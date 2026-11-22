import { hasOperationTiming, observeOperationCheckout, observeOperationSql, type ConnectionCheckout } from '../operation-timing.ts'
import { backfillConversationQueryFieldsV1 } from './conversation-query-migration-v1.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg'
import { GatewayPostgresClient } from './client.ts'

const MIGRATION_LOCK_KEY = 0x48475750
const MAX_TIMER_DELAY_MS = 2_147_483_647
/** Default upper bound for one PostgreSQL statement issued by the Gateway. */
export const DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS = 30_000
/** Default wait bound for PostgreSQL row/table locks. */
export const DEFAULT_DATABASE_LOCK_TIMEOUT_MS = 5_000
/** Default bound for a transaction left idle while holding a checked-out client. */
export const DEFAULT_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS = 60_000
/** Maximum time a migration runner waits for another process's advisory lock. */
export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 30_000
/** Maximum number of Gateway callers waiting for a PostgreSQL checkout. */
export const DEFAULT_DATABASE_MAX_CHECKOUT_QUEUE = 256
const MIGRATION_LOCK_POLL_MS = 100
const TRANSIENT_DATABASE_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '57P01',
  '57P02',
  '57P03',
])

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }>
}

/** Gateway-only pool option; pg itself does not expose a pending-queue bound. */
export interface GatewayPoolConfig extends PoolConfig {
  traceRole?: 'governance'|'content'
  maxCheckoutQueue?: number
}

interface CheckoutState {
  pending: number
  limit: number
  rejected: number
}

const checkoutStates = new WeakMap<Pool, CheckoutState>()

/** Node-local checkout admission; rejected is cumulative for this pool's lifetime. */
export interface PostgresPoolAdmissionSnapshot {
  /** Unsettled checkout operations, including connections still being established. */
  readonly pending: number
  readonly maxPending: number
  readonly rejected: number
}

/**
 * Read checkout admission without exposing SQL, connection strings or caller identities.
 * @param pool - Gateway-created pool or an injected pool adopted by connectFromPool.
 * @returns Current pending count, configured limit and cumulative refusals; null before an injected pool is adopted.
 */
export function poolAdmissionSnapshot(pool: Pool): PostgresPoolAdmissionSnapshot | null {
  const state = checkoutStates.get(pool)
  return state === undefined ? null : { pending: state.pending, maxPending: state.limit, rejected: state.rejected }
}

/** An unresolved checkout was refused before entering pg's pending queue. */
export class PostgresCheckoutQueueFullError extends Error {
  readonly code = 'DB_CHECKOUT_QUEUE_FULL'
  /** @param limit - configured unresolved-checkout capacity. */
  constructor(readonly limit: number) {
    super('PostgreSQL checkout queue is full (' + String(limit) + ')')
    this.name = 'PostgresCheckoutQueueFullError'
  }
}

function checkoutQueueFull(state: CheckoutState): PostgresCheckoutQueueFullError {
  state.rejected += 1
  return new PostgresCheckoutQueueFullError(state.limit)
}

type CheckoutCallback = Parameters<Pool['connect']>[0]

/** pg.query uses this.connect, so one override owns admission for every native checkout entry. */
class GatewayPostgresPool extends Pool {
  private readonly checkout: CheckoutState
  private readonly freshSetup = new WeakMap<PoolClient, number>()
  private readonly keepsWarmClients: boolean
  private readonly awaitingReuse = new Set<() => void>()
  private handoffScheduled = false

  constructor(options: PoolConfig, limit: number, private readonly traceRole: 'governance' | 'content') {
    super(options)
    this.checkout = { pending: 0, limit, rejected: 0 }
    this.keepsWarmClients = (this.options.min ?? 0) > 0
    checkoutStates.set(this, this.checkout)
    this.on('connect', client => {
      if (client instanceof GatewayPostgresClient) this.freshSetup.set(client, performance.now() - client.setupStartedAt)
    })
    if (this.keepsWarmClients) this.on('release', () => this.scheduleHandoff())
  }

  private scheduleHandoff(): void {
    if (this.handoffScheduled || this.ending || this.awaitingReuse.size === 0) return
    this.handoffScheduled = true
    // pg publishes release before it returns the client to idle or to its native queue.
    queueMicrotask(() => {
      this.handoffScheduled = false
      for (const borrow of this.awaitingReuse) {
        if (this.ending || this.idleCount <= this.waitingCount) break
        this.awaitingReuse.delete(borrow)
        borrow()
      }
    })
  }

  private acquire(callback: CheckoutCallback, record: (result: ConnectionCheckout) => void): void {
    const shouldOfferHandoff = this.keepsWarmClients && this.idleCount === 0 && this.waitingCount === 0
      && this.totalCount > 0 && this.totalCount < this.options.max
    const deliver = shouldOfferHandoff || hasOperationTiming() ? AsyncLocalStorage.bind(callback) : callback
    let delivered = false
    const finish = (error: Error | undefined, client: PoolClient | undefined, release: Parameters<CheckoutCallback>[2], handoff = false): void => {
      const setupMs = client === undefined ? undefined : this.freshSetup.get(client)
      if (client !== undefined) this.freshSetup.delete(client)
      if (delivered) {
        if (client !== undefined) release()
        return
      }
      if (handoff && error) return
      delivered = true
      this.awaitingReuse.delete(borrowReturnedClient)
      record(error ? { kind: 'failed' } : setupMs === undefined ? { kind: handoff ? 'handoff' : 'reused' }
        : { kind: 'opened', setupMs })
      deliver(error, client === undefined ? undefined : guardCheckedOutClient(client, this.traceRole), release)
    }
    const borrowReturnedClient = (): void => {
      super.connect((error, client, release) => finish(error, client, release, true))
    }
    if (shouldOfferHandoff) this.awaitingReuse.add(borrowReturnedClient)
    try { super.connect(finish) } catch (error) {
      this.awaitingReuse.delete(borrowReturnedClient)
      throw error
    }
  }

  override connect(): Promise<PoolClient>
  override connect(callback: CheckoutCallback): void
  override connect(callback?: CheckoutCallback): Promise<PoolClient> | void {
    if (this.ending) return callback === undefined ? super.connect() : super.connect(callback)
    if (this.checkout.pending >= this.checkout.limit) {
      const error = checkoutQueueFull(this.checkout)
      if (callback === undefined) return Promise.reject(error)
      queueMicrotask(() => { callback(error, undefined, () => {}) })
      return
    }
    this.checkout.pending += 1
    const stopCheckout = observeOperationCheckout(this.traceRole)
    let settled = false
    const settle = (result: ConnectionCheckout): void => {
      if (settled) return
      settled = true
      this.checkout.pending -= 1
      stopCheckout(result)
    }
    if (callback !== undefined) {
      try { this.acquire(callback, settle) } catch (error) {
        settle({ kind: 'failed' })
        throw error
      }
      return
    }
    const PromiseImplementation = this.options.Promise ?? Promise
    return new PromiseImplementation<PoolClient>((resolve, reject) => {
      try { this.acquire((error, client) => { if (error) reject(error); else resolve(client!) }, settle) } catch (error) {
        settle({ kind: 'failed' })
        reject(error)
      }
    }) as Promise<PoolClient>
  }
}

function checkoutLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_DATABASE_MAX_CHECKOUT_QUEUE
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`maxCheckoutQueue must be a positive safe integer`)
  }
  return resolved
}

export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HGW_DATABASE_URL !== undefined && env.HGW_DATABASE_URL.trim() !== '') return env.HGW_DATABASE_URL.trim()
  if (env.HGW_DATABASE_URL_FILE !== undefined && env.HGW_DATABASE_URL_FILE.trim() !== '') {
    throw new Error('HGW_DATABASE_URL_FILE must be resolved asynchronously with databaseUrlFromFile')
  }
  throw new Error('HGW_DATABASE_URL or HGW_DATABASE_URL_FILE is required')
}

export async function databaseUrlFromFile(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.HGW_DATABASE_URL !== undefined && env.HGW_DATABASE_URL.trim() !== '') return env.HGW_DATABASE_URL.trim()
  const path = env.HGW_DATABASE_URL_FILE?.trim()
  if (path === undefined || path === '') throw new Error('HGW_DATABASE_URL or HGW_DATABASE_URL_FILE is required')
  const value = (await readFile(path, 'utf8')).trim()
  if (value === '') throw new Error(`database URL file is empty: ${path}`)
  return value
}

/**
 * Resolve the PostgreSQL endpoint used by the reserved control and access-listener pools.
 * @param connectionString - the business pool URL for the same PostgreSQL database.
 * @param tunnelPort - optional port of an independent loopback forward to that database.
 * @returns the configured URL, with only the authority port replaced when a forward is configured.
 */
export function databaseControlUrl(connectionString: string, tunnelPort: string | undefined): string {
  if (tunnelPort === undefined) return connectionString
  if (!/^[1-9][0-9]{0,4}$/u.test(tunnelPort) || Number(tunnelPort) > 65_535) {
    throw new Error('HGW_DATABASE_CONTROL_TUNNEL_PORT must be a TCP port from 1 to 65535')
  }
  const url = URL.parse(connectionString)
  if (url === null || (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.searchParams.has('host') || url.searchParams.has('port')) {
    throw new Error('HGW_DATABASE_CONTROL_TUNNEL_PORT requires a loopback PostgreSQL URL with its host and port in the authority')
  }
  if ((url.port || '5432') === tunnelPort) throw new Error('HGW_DATABASE_CONTROL_TUNNEL_PORT must differ from the business database port')
  url.port = tunnelPort
  return url.href
}

export function createPostgresPool(connectionString: string, overrides: GatewayPoolConfig = {}): Pool {
  const { maxCheckoutQueue, traceRole='governance', ...poolOverrides } = overrides
  const checkoutQueueLimit = checkoutLimit(maxCheckoutQueue)
  const pool = new GatewayPostgresPool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'dsh-gateway',
    statement_timeout: DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS,
    lock_timeout: DEFAULT_DATABASE_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: DEFAULT_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS,
    Client: GatewayPostgresClient,
    ...poolOverrides,
  }, checkoutQueueLimit, traceRole)
  // `pg.Pool` emits an `error` event when an idle client is terminated by the
  // server or network.  Without a listener Node treats that event as
  // uncaught and takes the Gateway down, even though a later checkout could
  // recover with a fresh connection.  Keep the diagnostic deliberately
  // metadata-only; the pool owns reconnection and callers observe the failed
  // query through its normal promise.
  pool.on('error', (error: unknown) => {
    console.error(`[gateway] PostgreSQL pool error (${errorCodeForDiagnostics(error)})`)
  })
  return pool
}

/** Clients get their checkout error guard attached exactly once across pool reuse. */
const checkedOutErrorGuard = new WeakSet<PoolClient>()

/**
 * A server-side kill (`idle_in_transaction_session_timeout`, administrator
 * `pg_terminate_backend`, a proxy cutting the socket) reaches a checked-out
 * client as an `error` event. While a transaction holds the client between
 * statements no query is in flight, so the event has nowhere to go and an
 * unhandled emission crashes the process. The guard absorbs the event into a
 * metadata-only diagnostic; the next statement still observes the dead
 * connection through its own rejection. Once the client is idle again the
 * pool's own `error` listener owns removal and may co-report the same event.
 */
function guardCheckedOutClient(client: PoolClient,role:'governance'|'content'='governance'): PoolClient {
  if (typeof client.on !== 'function' || checkedOutErrorGuard.has(client)) return client
  checkedOutErrorGuard.add(client)
  if (typeof client.query==='function') observeOperationSql(client,role)
  client.on('error', (error: unknown) => {
    console.error(`[gateway] PostgreSQL checked-out client error (${errorCodeForDiagnostics(error)})`)
  })
  return client
}

/**
 * Acquire one pool client with the checkout `error` guard attached and the
 * bounded unresolved-checkout count enforced. Gateway-created pools apply
 * both protections to their native connect and query entries; this helper
 * also adopts externally supplied pools for transaction callers.
 */
export function connectFromPool(pool: Pool): Promise<PoolClient> {
  if (pool instanceof GatewayPostgresPool) return pool.connect()
  const state = checkoutStates.get(pool)
  /* v8 ignore next -- every production pool is created by createPostgresPool; the
     fallback keeps transaction tests and injected pools compatible. */
  const current = state ?? { pending: 0, limit: DEFAULT_DATABASE_MAX_CHECKOUT_QUEUE, rejected: 0 }
  if (current.pending >= current.limit) {
    return Promise.reject(checkoutQueueFull(current))
  }
  current.pending += 1
  if (state === undefined) checkoutStates.set(pool, current)
  let connecting: Promise<PoolClient>
  try {
    connecting = pool.connect()
  } catch (error: unknown) {
    current.pending -= 1
    return Promise.reject(error)
  }
  return connecting.then(
    client => guardCheckedOutClient(client),
  ).finally(() => { current.pending -= 1 })
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const value = (error as { code?: unknown }).code
  return typeof value === 'string' ? value : undefined
}

/** Return a non-secret database error code suitable for operational logs. */
export function errorCodeForDiagnostics(error: unknown): string {
  return errorCode(error) ?? 'unknown'
}

/**
 * Recognize a bounded statement or transaction refused by PostgreSQL contention.
 * This classification never permits replay of an operation with an unknown commit result.
 * @param error - failure returned by the database driver.
 * @returns whether the caller can report temporary unavailability without disclosing SQL.
 */
export function isDatabaseContentionError(error: unknown): boolean {
  const code = errorCode(error)
  return code === '55P03' || code === '57014' || code === '40P01' || code === '40001'
}

/** Whether one startup failure can reasonably clear without changing configuration. */
export function isTransientDatabaseError(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== undefined && current !== null && !seen.has(current); depth += 1) {
    seen.add(current)
    const code = errorCode(current)
    if (code !== undefined && (TRANSIENT_DATABASE_CODES.has(code) || code.startsWith('08'))) return true
    // pg can report a socket closed before startup completes without an errno or SQLSTATE.
    if (code === undefined && current instanceof Error && current.message === 'Connection terminated unexpectedly') return true
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined
  }
  return false
}

export interface DatabaseStartupRetryOptions {
  /** Initial delay between transient startup failures. */
  initialDelayMs: number
  /** Maximum delay between transient startup failures. */
  maxDelayMs: number
  /** Optional signal used by a supervisor while replacing the process. */
  signal?: AbortSignal
  /** Receives a retry notification without the connection string. */
  onRetry?: (error: unknown, delayMs: number) => void
}

function abortedStartup(): Error {
  const error = new Error('database startup retry aborted')
  error.name = 'AbortError'
  return error
}

function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortedStartup())
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const abort = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(abortedStartup())
    }
    timer = setTimeout(finish, delayMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

/** Retry only transient PostgreSQL startup failures until the dependency returns. */
export async function withDatabaseStartupRetry<T>(
  operation: () => Promise<T>,
  options: DatabaseStartupRetryOptions,
): Promise<T> {
  if (!Number.isSafeInteger(options.initialDelayMs) || options.initialDelayMs < 1
    || options.initialDelayMs > MAX_TIMER_DELAY_MS
    || !Number.isSafeInteger(options.maxDelayMs) || options.maxDelayMs < 1
    || options.maxDelayMs > MAX_TIMER_DELAY_MS
    || options.maxDelayMs < options.initialDelayMs) {
    throw new RangeError(`database startup retry delays must be positive safe integers within 1..${MAX_TIMER_DELAY_MS}, with maxDelayMs >= initialDelayMs`)
  }
  let delayMs = options.initialDelayMs
  while (true) {
    try {
      return await operation()
    } catch (error) {
      if (!isTransientDatabaseError(error) || options.signal?.aborted) throw error
      options.onRetry?.(error, delayMs)
      await waitForRetry(delayMs, options.signal)
      delayMs = Math.min(options.maxDelayMs, delayMs * 2)
    }
  }
}

async function connectWithSignal(pool: Pool, signal?: AbortSignal): Promise<PoolClient> {
  signal?.throwIfAborted()
  const connecting = connectFromPool(pool)
  if (signal === undefined) return connecting
  return new Promise<PoolClient>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(signal.reason instanceof Error ? signal.reason : new Error('database checkout aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    void connecting.then(
      client => {
        if (settled) {
          client.release()
          return
        }
        settled = true
        cleanup()
        resolve(client)
      },
      error => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
  })
}

/** Per-transaction lock waiting; all other pool timeout settings remain effective. */
export interface PostgresTransactionOptions {
  /** Use the statement timeout for expected serialized work; an unlimited statement retains the pool lock timeout. */
  readonly lockWait?: 'statement'
}

/**
 * Commit one operation on an owned client; a failed operation is never replayed.
 * @param pool - database connection pool.
 * @param operation - database work retaining its client until settlement.
 * @param signal - optional cancellation checked before committing.
 * @param options - lock waiting for work that deliberately serializes with other transactions.
 * @returns the operation result after commit acknowledgement.
 */
export async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
  signal?: AbortSignal,
  options?: PostgresTransactionOptions,
): Promise<T> {
  const client = await connectWithSignal(pool, signal)
  let failure: Error | null = null
  try {
    signal?.throwIfAborted()
    await client.query('BEGIN')
    if (options?.lockWait === 'statement') {
      await client.query(`SELECT set_config('lock_timeout',CASE WHEN current_setting('statement_timeout')='0'
        THEN current_setting('lock_timeout') ELSE current_setting('statement_timeout') END,true)`)
    }
    signal?.throwIfAborted()
    const result = await operation(client)
    signal?.throwIfAborted()
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve the original failure */ }
    failure = error instanceof Error ? error : new Error(String(error))
    throw error
  } finally {
    // Releasing with the error destroys a dead connection (for example a
    // backend killed mid-transaction) instead of lending it out again.
    if (failure === null) client.release()
    else client.release(failure)
  }
}

interface MigrationFile { version: number; name: string; path: string; checksum: string; sql: string }
type MigrationRecord = Pick<MigrationFile, 'version' | 'name' | 'checksum'>

/** A published push migration with identical SQL at its canonical version. */
interface MigrationRelocation { from: number; to: number }

const PUSH_MIGRATION_LINEAGE = [
  {
    from: 130, to: 144, suffix: 'push_delivery_outcomes.sql',
    checksum: '6d7b40d5aa4c660e805ee49c3eaaa0b0901b1524327adadf985530e1a54043d6',
  },
  {
    from: 131, to: 145, suffix: 'unifiedpush_provider.sql',
    checksum: '59de0ff92952399d707b3c428fa2ad83ed77ea04ff4fb8868c303bc5e290c244',
  },
] as const
const LAST_PUSH_MIGRATION_VERSION = PUSH_MIGRATION_LINEAGE[1].to

function matchesMigration(record: MigrationRecord, migration: MigrationFile | undefined): boolean {
  return migration !== undefined && record.version === migration.version
    && record.name === migration.name && record.checksum === migration.checksum
}

function pushMigrationRelocations(rows: MigrationRecord[], migrations: MigrationFile[]): MigrationRelocation[] | undefined {
  const common = PUSH_MIGRATION_LINEAGE[0].from - 1
  const fork = rows.slice(common)
  if (fork.length === 0 || fork.length > PUSH_MIGRATION_LINEAGE.length
    || !rows.slice(0, common).every((row, index) => matchesMigration(row, migrations[index]))) return
  const relocations: MigrationRelocation[] = []
  for (const [index, { from, to, suffix, checksum }] of PUSH_MIGRATION_LINEAGE.entries()) {
    const target = migrations[to - 1]
    if (target?.version !== to || target.name !== `${to}_${suffix}` || target.checksum !== checksum) return
    const row = fork[index]
    if (row === undefined) continue
    if (row.version !== from || row.name !== `${from}_${suffix}` || row.checksum !== checksum) return
    relocations.push({ from, to })
  }
  return relocations
}

async function migrationFiles(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter(name => /^\d{3}_[a-z0-9_-]+\.sql$/.test(name)).sort()
  const versions = new Set<number>()
  const migrations: MigrationFile[] = []
  for (const name of names) {
    const version = Number(name.slice(0, 3))
    if (versions.has(version)) throw new Error(`duplicate PostgreSQL migration version ${String(version)}`)
    versions.add(version)
    const path = resolve(directory, name)
    const sql = await readFile(path, 'utf8')
    migrations.push({ version, name, path, sql, checksum: createHash('sha256').update(sql).digest('hex') })
  }
  if (migrations.length === 0) throw new Error(`no PostgreSQL migrations found in ${directory}`)
  for (const [index, migration] of migrations.entries()) {
    const expected = index + 1
    if (migration.version !== expected) {
      throw new Error(`PostgreSQL migration sequence expected version ${String(expected)}, found ${String(migration.version)}`)
    }
  }
  return migrations
}

/** Packaged-versus-applied migration diff for the deploy applier's plan and status output. */
export interface MigrationPlan {
  /** Versions recorded in `harness.schema_migrations`. */
  applied: number[]
  /** Packaged migrations not yet recorded. */
  pending: Array<{ version: number; name: string }>
  /** Applied versions whose recorded name or checksum differs from the packaged file. */
  drifted: number[]
  /** Checksummed push migrations to renumber during an explicit coordinated apply. */
  relocations?: MigrationRelocation[]
  /** Highest packaged version, or 0 when the directory is empty. */
  current: number
}

/**
 * Diff the installed ledger against the packaged files without locking or writing it.
 * @param pool - governance database connection.
 * @param directory - complete packaged SQL sequence.
 * @returns installed and pending versions, checksum drift, and any recognized push ledger correction.
 */
export async function migrationPlan(pool: Queryable, directory: string): Promise<MigrationPlan> {
  const migrations = await migrationFiles(directory)
  let rows: MigrationRecord[] = []
  try {
    const existing = await pool.query<MigrationRecord>(
      'SELECT version, name, checksum FROM harness.schema_migrations ORDER BY version',
    )
    rows = existing.rows
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
    if (code !== '42P01' && code !== '3F000') throw error
  }
  const byVersion = new Map(migrations.map(migration => [migration.version, migration]))
  const applied = rows.map(row => row.version)
  const relocations = pushMigrationRelocations(rows, migrations)
  const drifted = relocations === undefined
    ? rows.filter(row => !matchesMigration(row, byVersion.get(row.version))).map(row => row.version)
    : []
  const accountedFor = new Set(applied)
  for (const { from, to } of relocations ?? []) {
    accountedFor.delete(from)
    accountedFor.add(to)
  }
  const pending = migrations
    .filter(migration => !accountedFor.has(migration.version))
    .map(migration => ({ version: migration.version, name: migration.name }))
  return { applied, pending, drifted, current: migrations.at(-1)?.version ?? 0,
    ...(relocations === undefined ? {} : { relocations }) }
}

/** Verify a release's governance migration prefix without running SQL from the release.
 * @param pool - configured governance database.
 * @param directory - migration files shipped by the release being checked.
 * @param exact - require every shipped migration to be applied, as for rollback.
 * @returns whether the recorded ledger is the required checksummed sequence.
 */
export async function verifyReleaseMigrationLedger(pool: Pool, directory: string, exact: boolean): Promise<boolean> {
  return transaction(pool, async tx => {
    await tx.query('SET TRANSACTION READ ONLY')
    const lock = await tx.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [MIGRATION_LOCK_KEY])
    if (!lock.rows[0]?.locked) return false
    const { rows: [ledger] } = await tx.query<{ present: boolean; occupied: boolean }>(`SELECT
      to_regclass('harness.schema_migrations') IS NOT NULL present,
      EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='harness' AND c.relkind IN ('r','p') AND c.relname<>'schema_migrations') occupied`)
    if (ledger === undefined) return false
    if (!ledger.present) {
      await migrationFiles(directory)
      return !exact && !ledger.occupied
    }
    const plan = await migrationPlan(tx, directory)
    return (plan.applied.length > 0 || !ledger.occupied)
      && plan.relocations === undefined
      && plan.drifted.length === 0 && plan.applied.every((version, index) => version === index + 1)
      && (!exact || plan.pending.length === 0)
  })
}

async function applyMigration(client: PoolClient, migration: MigrationFile): Promise<void> {
  await client.query(migration.sql)
  if (migration.version === 100) await backfillConversationQueryFieldsV1(client)
  await client.query(
    'INSERT INTO harness.schema_migrations(version,name,checksum) VALUES($1,$2,$3)',
    [migration.version, migration.name, migration.checksum],
  )
}

async function applyPushMigrationLineage(
  client: PoolClient, migrations: MigrationFile[], existing: MigrationRecord[], relocations: MigrationRelocation[],
  verify: (client: Queryable) => Promise<void>,
): Promise<number[]> {
  const applied: number[] = []
  await client.query('BEGIN')
  try {
    await verify(client)
    for (const { from, to } of relocations) {
      const previous = existing[from - 1]!
      const target = migrations[to - 1]!
      const updated = await client.query(`UPDATE harness.schema_migrations SET version=$1, name=$2
        WHERE version=$3 AND name=$4 AND checksum=$5`, [to, target.name, from, previous.name, previous.checksum])
      if (updated.rowCount !== 1) throw new Error(`PostgreSQL push migration ledger changed at version ${from}`)
    }
    const alreadyApplied = new Set(relocations.map(relocation => relocation.to))
    for (const migration of migrations.slice(PUSH_MIGRATION_LINEAGE[0].from - 1, LAST_PUSH_MIGRATION_VERSION)) {
      if (alreadyApplied.has(migration.version)) continue
      await applyMigration(client, migration)
      applied.push(migration.version)
    }
    await client.query('COMMIT')
    return applied
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

/** Options for an explicitly coordinated migration apply. */
export interface MigrationApplyOptions {
  /** Verify quiescence and retain the maintenance fence in the legacy push upgrade transaction. */
  verifyPushUpgrade?: (client: Queryable) => Promise<void>
}

/** Outcome of an applied governance migration sequence. */
export interface MigrationApplyResult {
  /** Versions whose SQL committed during this run. */
  applied: number[]
  /** Highest version shipped by the release. */
  current: number
  /** Published push migrations whose ledger entries moved without replaying their SQL. */
  relocations?: MigrationRelocation[]
}

/**
 * Apply checksummed SQL and associated versioned backfills in atomic migration transactions.
 * @param pool - database whose advisory lock serializes all migration runners.
 * @param directory - complete, immutable SQL migration sequence matching this Gateway.
 * @param options - deployment applier's transactional maintenance check for the legacy push ledger.
 * @returns versions applied by this runner and the latest supported version.
 */
export async function runMigrations(pool: Pool, directory: string, options?: MigrationApplyOptions): Promise<MigrationApplyResult> {
  const migrations = await migrationFiles(directory)
  const current = migrations.at(-1)!.version
  const client = await connectFromPool(pool)
  const applied: number[] = []
  try {
    const deadline = Date.now() + DEFAULT_MIGRATION_LOCK_TIMEOUT_MS
    let locked = false
    while (!locked) {
      const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [MIGRATION_LOCK_KEY])
      locked = result.rows[0]?.locked === true
      if (locked) break
      if (Date.now() >= deadline) {
        throw new Error(`PostgreSQL migration advisory lock was not acquired within ${String(DEFAULT_MIGRATION_LOCK_TIMEOUT_MS)}ms`)
      }
      await delay(Math.min(MIGRATION_LOCK_POLL_MS, Math.max(1, deadline - Date.now())))
    }
    await client.query('CREATE SCHEMA IF NOT EXISTS harness')
    await client.query(`CREATE TABLE IF NOT EXISTS harness.schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`)
    const existing = await client.query<MigrationRecord>(
      'SELECT version, name, checksum FROM harness.schema_migrations ORDER BY version',
    )
    const relocations = pushMigrationRelocations(existing.rows, migrations)
    let installed = existing.rows.length
    if (relocations !== undefined) {
      if (options?.verifyPushUpgrade === undefined) throw new Error('PostgreSQL push migration ledger requires coordinated deploy-apply')
      applied.push(...await applyPushMigrationLineage(client, migrations, existing.rows, relocations, options.verifyPushUpgrade))
      installed = LAST_PUSH_MIGRATION_VERSION
    } else {
      for (const [index, recorded] of existing.rows.entries()) {
        const expected = index + 1
        if (recorded.version !== expected) {
          throw new Error(`PostgreSQL migration ledger expected version ${String(expected)}, found ${String(recorded.version)}`)
        }
        const migration = migrations[index]
        if (migration === undefined) {
          throw new Error(`database contains unknown PostgreSQL migration version ${String(recorded.version)}`)
        }
        if (!matchesMigration(recorded, migration)) {
          throw new Error(`PostgreSQL migration ${migration.name} differs from the applied checksum`)
        }
      }
    }
    for (const migration of migrations.slice(installed)) {
      await client.query('BEGIN')
      try {
        await applyMigration(client, migration)
        await client.query('COMMIT')
        applied.push(migration.version)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
    return { applied, current, ...(relocations === undefined ? {} : { relocations }) }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]) } catch { /* connection close releases it */ }
    client.release()
  }
}
