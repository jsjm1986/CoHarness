import { RuntimeCapacity, RuntimeCapacityError, type RuntimeCapacityLease, type RuntimeCapacitySnapshot } from './runtime-capacity.ts'
import type { GatewayResourceOwner, NodeResourceBudget } from './node-resource-budget.ts'
import type { GatewayModelBudget } from './gateway-model-budget.ts'
import type { RuntimeId } from './runtime-catalog.ts'
import { personalRuntimeLayout, type PersonalRuntimeStorage } from './runtime-layout.ts'
import { prepareRuntimeProfileDirectory } from './user-data.ts'
import { prepareProjectRuntimeData } from './project-runtime-data.ts'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { CollaborationDeniedError } from './collaboration.ts'
import { requireSqliteAdministrator } from './administrator-authority.ts'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  chownSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import type Database from 'better-sqlite3'
import type { UserRow } from './auth.ts'
import type { GatewayConfig } from './config.ts'
import type { ProjectOrigin } from './projects.ts'
import {
  LocalLauncher,
  RuntimeLaunchCleanupError,
  type InstanceProc,
  type Launcher,
  type RuntimePolicyIdentity,
} from './launcher.ts'
import {
  RUNTIME_READINESS_NONCE_HEADER,
  RUNTIME_READINESS_PATH,
  RUNTIME_READINESS_REQUEST_HEADER,
  runtimeReadinessRequestProof,
  runtimeReadinessResponseProof,
  runtimeIdleResponseProof,
  sameRuntimeReadinessProof,
} from './runtime-readiness.ts'
import { assertProjectImportPathAllowed } from './project-directories.ts'
import { readResponseJson } from './response-budget.ts'

const POLL_INTERVAL_MS = 300
const STOP_GRACE_MS = 5000
const STOP_ALL_CONCURRENCY = 8
const MANAGED_CREDENTIALS_FILENAME = '.credentials.yaml'
const ADMIN_GUARD_PATCH_FILENAME = 'cordis.admin.patch.yml'
/**
 * Profile every managed runtime instance boots (`dsh web` in `dshCommand`).
 * Policy packages materialize inside this profile's own `node_modules`: the
 * runtime profile resolver scans profile-local directories before the shared
 * `profiles/node_modules` fallback position, which a runtime-mode generation
 * intentionally never reads.
 */
const INSTANCE_PROFILE = 'web'
const PROJECT_RUNTIME_PATCH = `- id: session-persistence-jsonl
  disabled: true
- insert:
    - id: collaboration-gateway
      name: '@deepseek-ai/dsh-collaboration-gateway'
    - id: collaboration-context
      name: '@deepseek-ai/dsh-collaboration-context'
    - id: session-persistence-gateway
      name: '@deepseek-ai/dsh-session-persistence-gateway'
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
- id: memory
  config:
    space: project
`

/**
 * Managed-desktop patch stanza appended when the node declares an interactive
 * desktop identifier: the runtime mounts the computer-use service and the
 * provisioned Cua Driver provider, and `gateway-execution` starts publishing
 * the managed desktop authorization policy for that identifier.
 */
function managedDesktopPatch(cfg: GatewayConfig, desktop: string): string {
  const driverConfig: string[] = []
  if (cfg.desktopDriverCommand !== undefined) driverConfig.push(`        command: ${JSON.stringify(cfg.desktopDriverCommand)}`)
  if (cfg.desktopDriverArgs !== undefined) driverConfig.push(`        args: ${JSON.stringify(cfg.desktopDriverArgs)}`)
  const config = driverConfig.length === 0 ? '' : `\n      config:\n${driverConfig.join('\n')}`
  return `- id: gateway-execution
  config:
    desktop: ${JSON.stringify(desktop)}
- insert:
    - id: computer-use
      name: '@deepseek-ai/dsh-computer-use'
    - id: computer-use-cua-driver-mcp
      name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'${config}
`
}

interface InstanceOwner extends PersonalRuntimeStorage {
  kind: 'user' | 'project'
  id: number
  username: string
  homePath: string
  name?: string
  /** Reserved project category for project owners. */
  projectKind?: 'standard' | 'steward'
  /** Stored creation source; user-managed directories retain their dedicated root policy. */
  projectOrigin?: ProjectOrigin
}

/**
 * Recheck a persisted project directory before launch or document access.
 * @param cfg - local deployment directory and launcher policy.
 * @param path - stored project directory.
 * @param origin - stored creation source; omitted legacy callers use administrator policy.
 * @returns the validated canonical directory.
 */
export function validateProjectRuntimePath(cfg: GatewayConfig, path: string, origin: ProjectOrigin = 'admin'): string {
  let canonical: string
  try {
    canonical = realpathSync(path)
    if (!statSync(canonical).isDirectory()) throw new Error('project-runtime-path-not-directory')
  } catch (error) {
    if (error instanceof Error && error.message === 'project-runtime-path-not-directory') throw error
    throw new Error('project-runtime-path-unavailable', { cause: error })
  }
  // Project rows are stored canonically. A replaced final component must not
  // silently redirect the next runtime to another tree. The host's `/var`
  // alias may itself resolve to `/private/var`, so raw path spellings cannot
  // be compared here; the canonical path is checked against policy below.
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('project-runtime-path-changed')
  } catch (error) {
    if (error instanceof Error && error.message === 'project-runtime-path-changed') throw error
    throw new Error('project-runtime-path-unavailable', { cause: error })
  }
  // Local development projects may intentionally live inside the checkout
  // (the local launcher has no mount namespace). Systemd launches must repeat
  // the full reserved/root policy immediately before constructing BindPaths.
  if (cfg.launcher === 'systemd') assertProjectImportPathAllowed(cfg, canonical, { allowUserProjectsRoot: origin === 'user' })
  return canonical
}

/** Runtime ownership and optional exact identity; omitted identity requires an unambiguous local assignment. */
export type RuntimeTarget = ({ kind: 'user'; id: number } | { kind: 'project'; id: number }) & { runtimeId?: RuntimeId }
export type RuntimeTargetInput = RuntimeTarget | number

/** Personal launch facts retain account identity separately from the selected Runtime. */
export type PersonalRuntime = UserRow & PersonalRuntimeStorage

/** Existing account/project launch facts with optional exact Runtime addressing. */
export type RuntimeSubject = PersonalRuntime | ProjectRuntime

/** Ready endpoint and exact identity; legacy local repositories omit the RuntimeId. */
export interface RuntimeEndpoint {
  port: number
  generation: number
  runtimeId?: RuntimeId
}

/** One durable assignment read; an endpoint still requires supervision and activity admission. */
export interface RuntimeInstanceSnapshot {
  target: RuntimeTarget
  state: string
  port: number
  generation: number
}

/**
 * Preserve the selected Runtime when resolving its business owner.
 * @param subject - current account or project launch facts.
 * @returns owner coordinates and the exact identity when supplied.
 */
export function runtimeTargetOf(subject: RuntimeSubject): RuntimeTarget {
  return { kind: 'username' in subject ? 'user' : 'project', id: subject.id,
    ...(subject.runtimeId === undefined ? {} : { runtimeId: subject.runtimeId }) }
}

/** Current personal account facts that determine process identity and launch privileges. */
export type PersonalRuntimePolicy = Pick<UserRow, 'id' | 'username' | 'homePath' | 'role' | 'status'> & PersonalRuntimeStorage

/** Server-generated identity of one process-owned destructive operation. */
export type RuntimeStopOperationId = Branded<'RuntimeStopOperationId'>

/** Assignment captured atomically with a durable destructive-operation registration. */
export interface RuntimeStopLease {
  readonly runtimeId: RuntimeId
  /** Present for PostgreSQL operations retained by a kernel-owned Gateway generation. */
  readonly operationId?: RuntimeStopOperationId
  readonly generation: number
  readonly wasStopped: boolean
}

/** Project facts required to launch its shared runtime. */
export interface ProjectRuntime {
  kind: 'project'
  id: number
  name: string
  path: string
  /** Exact assigned environment; omission requires a unique local project assignment. */
  runtimeId?: RuntimeId
  /**
   * True for the reserved steward space: the runtime is resident (idle-reaper
   * exempt, supervisor restart policy), privileged-confined, and mounts the
   * steward tools package.
   */
  steward?: boolean
}

/** Fully resolved launch facts passed to policy projection and launch drivers. */
export interface RuntimeLaunchContext extends RuntimePolicyIdentity {
  target: RuntimeTarget
  user?: PersonalRuntime
  project?: ProjectRuntime
}

/** Host facts embedded into each private runtime credential. */
export interface RuntimeSecurityConfig {
  principalPublicKey: string
}

/**
 * A new operation or WebSocket lease raced with a serialized runtime stop.
 * Callers must reacquire the runtime and retry with a fresh generation rather
 * than sending work to the stopped process.
 */
export class RuntimeLeaseUnavailableError extends Error {
  readonly code = 'RUNTIME_LEASE_UNAVAILABLE'

  constructor(target: RuntimeTarget) {
    super(`runtime ${target.kind}:${String(target.id)} is not ready for a new lease`)
    this.name = 'RuntimeLeaseUnavailableError'
  }
}

/** Durable reason for a stopped runtime; a new runtime has no stop reason. */
export type RuntimeStopReason = 'manual' | 'idle' | 'shutdown' | 'failed' | 'access-change'
/** Process-only administrator control or quiescence for data-changing work; destructive protection is the default. */
export type RuntimeStopPurpose = 'control' | 'destructive' | 'content-publication'
/** Explicit starts require an authenticated user action at the owning HTTP route. */
export type RuntimeStartIntent = 'passive' | 'explicit' | 'webhook'

/** One deduplicated start with separate bounded admission and readiness results. */
export interface RuntimeStartRequest {
  /** Resolves after bounded queue acceptance, immediate capacity reservation or warm reuse. */
  readonly admission: Promise<void>
  /** Resolves after readiness or qualified warm reuse; cold starts retain deadline and cancellation through publication. */
  readonly completion: Promise<RuntimeEndpoint>
}

/** Runtime admission cannot override an unavailable owner or a durable stop decision. */
export class RuntimeStartBlockedError extends Error {
  readonly code: 'INSTANCE_STOPPED' | 'INSTANCE_UNAVAILABLE'
  /**
   * @param reason - durable stop, maintenance, or unavailable-assignment decision.
   * @param message - actionable recovery instructions when availability requires process reconciliation.
   * @param options - underlying failure retained for server diagnostics.
   */
  constructor(readonly reason: RuntimeStopReason | 'maintenance' | 'stale-epoch' | 'unavailable' | null, message?: string, options?: ErrorOptions) {
    super(message ?? (reason === 'unavailable'
      ? 'Runtime start is unavailable. Check the owner status, membership and instance assignment.'
      : reason === 'maintenance' || reason === 'stale-epoch'
      ? 'Runtime start is unavailable during maintenance or after a database restore.'
      : 'The runtime requires an explicit start by an authorized user.'), options)
    this.name = 'RuntimeStartBlockedError'
    this.code = reason === 'maintenance' || reason === 'stale-epoch' || reason === 'unavailable' ? 'INSTANCE_UNAVAILABLE' : 'INSTANCE_STOPPED'
  }
}

/** Administrator control named a process generation that has already changed. */
export class RuntimeGenerationConflictError extends Error {
  readonly code = 'INSTANCE_GENERATION_CHANGED'
  constructor() { super('The Runtime generation changed. Read its current state before issuing another control operation.'); this.name = 'RuntimeGenerationConflictError' }
}

/** A destructive stop failed during supervision, stopped publication or accounting. */
export class RuntimeStopError extends Error {
  readonly code = 'INSTANCE_STOP_FAILED'
  /** @param cause - supervision, storage or accounting failure retained for operator diagnostics. */
  constructor(cause: unknown) {
    super('Runtime stop could not be completed. Check its state before retrying.', { cause })
    this.name = 'RuntimeStopError'
  }
}

function targetOf(input: RuntimeTargetInput): RuntimeTarget {
  return typeof input === 'number' ? { kind: 'user', id: input } : input
}

function targetKey(input: RuntimeTargetInput): string {
  const target = targetOf(input)
  return `${target.kind}:${String(target.id)}${target.runtimeId === undefined ? '' : `:${target.runtimeId}`}`
}

function targetFromKey(key: string): RuntimeTarget {
  const [kind, rawId, runtimeId] = key.split(':')
  const id = Number(rawId)
  if ((kind !== 'user' && kind !== 'project') || !Number.isSafeInteger(id)) throw new Error(`invalid runtime process key ${key}`)
  return { kind, id, ...(runtimeId === undefined ? {} : { runtimeId: runtimeId as RuntimeId }) }
}

/** Keep leases from different runtime generations independent after a forced stop. */
function leaseKey(target: RuntimeTarget, generation: number | undefined): string {
  return generation === undefined ? targetKey(target) : `${targetKey(target)}@${String(generation)}`
}

/** Durable instance rows required by {@link InstanceManager}. */
export interface InstanceRepository {
  /** Check physical project storage before a new process can write its profile or consume a startup lease. */
  checkProjectStorage?(target:RuntimeTarget):Promise<void|(()=>Promise<void>)>

  /** Initialize missing assignments without treating startup as process termination. */
  initialize(): Promise<void>
  /**
   * Resolve one local assignment before process keys or mutations are selected.
   * @param target - exact identity or existing owner selector.
   * @returns current exact assignment; missing or ambiguous selectors refuse admission.
   * @remarks Omitted by legacy repositories whose owner uniquely identifies their sole local assignment.
   */
  resolveTarget?(target: RuntimeTarget): Promise<RuntimeTarget>
  /**
   * Read assignment, state, port and generation from one database snapshot without starting a process.
   * @param target - exact identity or an unambiguous local owner selector.
   * @returns the current row, or null when a legacy local owner has no assignment; ambiguous selectors fail.
   */
  snapshotOf(target: RuntimeTarget): Promise<RuntimeInstanceSnapshot | null>
  /** @returns existing processes assigned to this node, including incomplete starts and stops. */
  activeTargets(): Promise<RuntimeTarget[]>
  portOf(target: RuntimeTarget): Promise<number>
  stateOf(target: RuntimeTarget): Promise<string>
  stopReasonOf(target: RuntimeTarget): Promise<RuntimeStopReason | null>
  /**
   * @param target - exact runtime assignment to check without mutating it.
   * @returns current eligible owner/instance policy, or null when unavailable; beginStart rechecks it atomically.
   */
  startEligibility(target: RuntimeTarget): Promise<{ stopReason: RuntimeStopReason | null } | null>
  generationOf(target: RuntimeTarget): Promise<number>
  /**
   * @param target - runtime assignment.
   * @param generation - expected generation; a replacement refuses this read.
   * @returns its bearer digest, or null for a stopped or pre-credential legacy assignment.
   */
  credentialHashOf(target: RuntimeTarget, generation: number): Promise<string | null>
  touch(target: RuntimeTarget, at: number): Promise<void>
  /**
   * Retain the assignment writer lock before freshly checking owner, node and ready-generation eligibility and committing activity.
   * Expected lock contention waits within the database statement timeout; no reference may be retained on failure.
   * @param target - exact assignment or an unambiguous local owner selector.
   * @param at - activity time in milliseconds.
   * @param generation - captured generation; omission accepts the current generation.
   * @returns whether admission committed; refusal leaves activity unchanged.
   */
  admitLease(target: RuntimeTarget, at: number, generation?: number): Promise<boolean>
  /**
   * Claim stop intent only for a running assignment whose managed node connection is no longer valid.
   * @param target - exact assignment or an unambiguous local owner.
   * @param generation - captured process generation; a replacement refuses the claim.
   * @param administratorUserId - initiating administrator when supplied; omission permits trusted lifecycle cleanup.
   * @returns whether the captured stale assignment committed stop intent; local and current connections remain unchanged.
   */
  markExpiredConnectionStopping(target: RuntimeTarget, generation: number, administratorUserId?: number): Promise<boolean>
  /**
   * Claim an eligible stopped assignment atomically; incomplete or ready assignments refuse another start.
   * @param target - runtime owner assigned to this node.
   * @param at - start time in milliseconds.
   * @param runtimeTokenHash - digest of the fresh generation's bearer.
   * @param intent - start policy; passive by default.
   * @param administratorUserId - initiating administrator retained through the claim; omission permits trusted lifecycle maintenance.
   * @returns the claimed generation.
   */
  beginStart(target: RuntimeTarget, at: number, runtimeTokenHash: Buffer, intent?: RuntimeStartIntent, administratorUserId?: number): Promise<number>
  markReady(target: RuntimeTarget, generation: number): Promise<void>
  idleTargets(cutoff: number): Promise<RuntimeTarget[]>
  /** Re-check one idle candidate without rescanning the whole instance table. */
  idleTarget(target: RuntimeTarget, cutoff: number): Promise<boolean>
  /**
   * Stopped assignments on this node whose stop cause permits unattended warmup.
   * @param activityCutoff - earliest last-activity timestamp that still qualifies.
   * @returns recently used targets stopped by shutdown, idle release or failure; manual and access-change stops never appear.
   */
  warmTargets?(activityCutoff: number): Promise<RuntimeTarget[]>
  /**
   * @param target - assignment to stop.
   * @param generation - captured generation; never a replacement.
   * @param reason - durable stop reason, manual by default.
   * @param actorUserId - when supplied, require the current administrator and a deletable target in the same transaction; omission is trusted lifecycle maintenance.
   * @returns whether the captured generation still owns the assignment.
   */
  markStopping(target: RuntimeTarget, generation: number, reason?: RuntimeStopReason, actorUserId?: number): Promise<boolean>
  /**
   * Claim the exact idle generation while checking activity and outstanding resources atomically.
   * @param target - exact local assignment or an unambiguous legacy owner.
   * @param generation - generation whose Host confirmed idle readiness.
   * @param cutoff - latest activity timestamp eligible for automatic release.
   * @returns false while work, newer activity or another generation must be retained; omission disables automatic release.
   */
  markIdleStopping?(target: RuntimeTarget, generation: number, cutoff: number): Promise<boolean>
  /**
   * Authorize explicit lifecycle control without granting destructive data access.
   * @param administratorUserId - server-authenticated initiating administrator.
   * @returns completion after current organization/account/membership authority is confirmed.
   */
  authorizeAdministrator(administratorUserId: number): Promise<void>
  /**
   * Retain current administrator authority through stop intent; reserved projects remain controllable.
   * @param target - assignment on this node.
   * @param generation - captured generation; a replacement remains unchanged.
   * @param reason - durable stop reason.
   * @param administratorUserId - initiating administrator.
   * @returns whether the captured assignment accepted stop intent.
   */
  markControlStopping(target: RuntimeTarget, generation: number, reason: RuntimeStopReason, administratorUserId: number): Promise<boolean>
  /**
   * @param target - assignment whose full process range stopped.
   * @param generation - confirmed generation; never a replacement.
   * @param reason - optional reason overriding a non-manual stop.
   * @returns whether the generation was published stopped; a replacement remains unchanged.
   */
  markStopped(target: RuntimeTarget, generation: number, reason?: RuntimeStopReason): Promise<boolean>
  /**
   * Claim a distributed stop operation before cancelling starts; absent only for local test repositories.
   * @param target - current assignment on this node.
   * @param operationId - unique server-generated operation identifier.
   * @param owner - kernel-backed Gateway process generation retained until release.
   * @param actorUserId - authenticated administrator; omission permits trusted lifecycle maintenance.
   * @param expectedGeneration - optional reviewed generation, checked before reserving or changing the assignment.
   * @param purpose - process-only control retains administrator admission; destructive work also retains project mutation protection.
   * @returns the identity and generation protected until release or proved Gateway retirement.
   */
  acquireStopLease?(target: RuntimeTarget, operationId: RuntimeStopOperationId, owner: GatewayResourceOwner, actorUserId?: number, expectedGeneration?: number, purpose?: RuntimeStopPurpose): Promise<RuntimeStopLease>
  /**
   * Release only the exact operation, including after its live assignment was removed.
   * @param operationId - registration issued by acquireStopLease.
   * @param owner - the same retained process generation.
   * @returns completion after the durable operation is removed.
   */
  releaseStopLease?(operationId: RuntimeStopOperationId, owner: GatewayResourceOwner): Promise<void>
  /** Persist process quiescence after confirmed termination and before destructive work. */
  confirmStopLease?(operationId: RuntimeStopOperationId, owner: GatewayResourceOwner): Promise<void>
  owner(target: RuntimeTarget): Promise<InstanceOwner | null>
  /** Enumerate this owner's local assignments for invalidation and configuration projection. */
  targetsForOwner?(target: RuntimeTarget): Promise<RuntimeTarget[]>
  /**
   * Resolve current launch privileges for an eligible account on this node.
   * @param id - personal account identifier.
   * @param administratorUserId - when supplied, retain this actor's current authority through the same owner-policy read.
   * @param runtimeId - when supplied, require that exact assignment; omission requires a unique local personal Runtime.
   * @returns current process identity and role, or null after account, membership, organization or assignment withdrawal.
   */
  personalPolicy(id: number, administratorUserId?: number, runtimeId?: RuntimeId): Promise<PersonalRuntimePolicy | null>
}

class SqliteInstanceRepository implements InstanceRepository {
  constructor(private readonly db: Database.Database) {}

  initialize(): Promise<void> { return Promise.resolve() }

  async activeTargets(): Promise<RuntimeTarget[]> {
    const rows = this.db.prepare("SELECT user_id FROM instances WHERE state IN ('ready','starting','stopping')").all() as Array<{ user_id: number }>
    return rows.map(row => ({ kind: 'user', id: row.user_id }))
  }

  private userId(target: RuntimeTarget): number {
    if (target.kind !== 'user') throw new Error('SQLite test repository has no project runtimes')
    return target.id
  }

  async portOf(target: RuntimeTarget): Promise<number> {
    const userId = this.userId(target)
    const row = this.db.prepare(`SELECT port FROM instances WHERE user_id = ?`).get(userId) as
      { port: number } | undefined
    if (row === undefined) throw new Error(`no instance row for user ${userId}`)
    return row.port
  }

  async snapshotOf(target: RuntimeTarget): Promise<RuntimeInstanceSnapshot | null> {
    const userId = this.userId(target)
    const row = this.db.prepare('SELECT state,port FROM instances WHERE user_id=?').get(userId) as
      { state: string; port: number } | undefined
    return row === undefined ? null : { ...row, generation: 1, target: { kind: 'user', id: userId } }
  }

  async stateOf(target: RuntimeTarget): Promise<string> {
    const userId = this.userId(target)
    const row = this.db.prepare(`SELECT state FROM instances WHERE user_id = ?`).get(userId) as
      { state: string } | undefined
    return row?.state ?? 'stopped'
  }

  async generationOf(target: RuntimeTarget): Promise<number> {
    this.userId(target)
    return 1
  }

  async credentialHashOf(target: RuntimeTarget, _generation: number): Promise<string | null> {
    this.userId(target)
    return null
  }

  async stopReasonOf(target: RuntimeTarget): Promise<RuntimeStopReason | null> {
    const row = this.db.prepare('SELECT stop_reason FROM instances WHERE user_id = ?').get(this.userId(target)) as
      { stop_reason: RuntimeStopReason | null } | undefined
    if (row === undefined) throw new Error(`no instance row for user ${target.id}`)
    return row.stop_reason
  }

  async touch(target: RuntimeTarget, at: number): Promise<void> {
    const userId = this.userId(target)
    this.db.prepare(`UPDATE instances SET last_activity_at = ? WHERE user_id = ?`).run(at, userId)
  }

  async admitLease(target: RuntimeTarget, at: number, generation?: number): Promise<boolean> {
    const userId = this.userId(target)
    return this.db.prepare(`UPDATE instances SET last_activity_at=?
      WHERE user_id=? AND state='ready' AND (? IS NULL OR ?=1)
        AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='active' AND deleted_at IS NULL)`)
      .run(at, userId, generation ?? null, generation ?? null, userId).changes === 1
  }

  async markExpiredConnectionStopping(_target: RuntimeTarget, _generation: number, _administratorUserId?: number): Promise<boolean> {
    return false
  }

  async beginStart(target: RuntimeTarget, at: number, _runtimeTokenHash: Buffer, intent: RuntimeStartIntent = 'passive', administratorUserId?: number): Promise<number> {
    const userId = this.userId(target)
    const claim = () => {
      if (administratorUserId !== undefined) requireSqliteAdministrator(this.db, administratorUserId)
      return this.db.prepare(`UPDATE instances SET state = 'starting', stop_reason = NULL, started_at = ?, last_activity_at = ?
      WHERE user_id = ? AND state = 'stopped' AND (? = 'explicit' OR (stop_reason IS NOT 'manual' AND (? <> 'webhook' OR stop_reason = 'idle')))
        AND EXISTS(SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL)`)
      .run(at, at, userId, intent, intent, userId)
    }
    const updated = administratorUserId === undefined ? claim() : this.db.transaction(claim).immediate()
    if (updated.changes !== 1) {
      const eligible = await this.startEligibility(target), reason = eligible?.stopReason
      const blockedIntent = intent !== 'explicit' && (reason === 'manual' || intent === 'webhook' && reason !== 'idle')
      throw new RuntimeStartBlockedError(eligible !== null && blockedIntent ? eligible.stopReason : 'unavailable')
    }
    return 1
  }

  async startEligibility(target: RuntimeTarget): Promise<{ stopReason: RuntimeStopReason | null } | null> {
    const row = this.db.prepare(`SELECT i.stop_reason FROM instances i JOIN users u ON u.id=i.user_id
      WHERE i.user_id=? AND u.status='active' AND u.deleted_at IS NULL`).get(this.userId(target)) as
      { stop_reason: RuntimeStopReason | null } | undefined
    return row === undefined ? null : { stopReason: row.stop_reason }
  }

  async markReady(target: RuntimeTarget, _generation: number): Promise<void> {
    const userId = this.userId(target)
    const updated = this.db.prepare(`UPDATE instances SET state = 'ready' WHERE user_id = ? AND state = 'starting' AND stop_reason IS NULL`).run(userId)
    if (updated.changes !== 1) throw new RuntimeStartBlockedError(await this.stopReasonOf(target))
  }

  async idleTargets(cutoff: number): Promise<RuntimeTarget[]> {
    const rows = this.db.prepare(
      `SELECT user_id FROM instances WHERE state = 'ready' AND last_activity_at < ?`,
    ).all(cutoff) as Array<{ user_id: number }>
    return rows.map(row => ({ kind: 'user' as const, id: row.user_id }))
  }

  async idleTarget(target: RuntimeTarget, cutoff: number): Promise<boolean> {
    const userId = this.userId(target)
    const row = this.db.prepare(
      `SELECT 1 AS present FROM instances WHERE user_id = ? AND state = 'ready' AND last_activity_at < ? LIMIT 1`,
    ).get(userId, cutoff) as { present: number } | undefined
    return row !== undefined
  }

  async warmTargets(activityCutoff: number): Promise<RuntimeTarget[]> {
    const rows = this.db.prepare(
      `SELECT user_id FROM instances WHERE state = 'stopped'
        AND stop_reason IN ('shutdown','idle','failed') AND last_activity_at > ? ORDER BY last_activity_at DESC`,
    ).all(activityCutoff) as Array<{ user_id: number }>
    return rows.map(row => ({ kind: 'user' as const, id: row.user_id }))
  }

  async markStopping(target: RuntimeTarget, generation: number, reason: RuntimeStopReason = 'manual', actorUserId?: number): Promise<boolean> {
    return this.db.transaction(() => {
      if (actorUserId !== undefined) requireSqliteAdministrator(this.db, actorUserId)
      if (generation !== 1) return false
      const userId = this.userId(target)
      return this.db.prepare(`UPDATE instances SET state = 'stopping', stop_reason = CASE WHEN stop_reason = 'manual' THEN 'manual' ELSE ? END WHERE user_id = ?`).run(reason, userId).changes === 1
    }).immediate()
  }

  async markIdleStopping(target: RuntimeTarget, generation: number, cutoff: number): Promise<boolean> {
    if (generation !== 1) return false
    return this.db.transaction(() => this.db.prepare(`UPDATE instances SET state='stopping',
      stop_reason=CASE WHEN stop_reason='manual' THEN 'manual' ELSE 'idle' END
      WHERE user_id=? AND state='ready' AND last_activity_at < ?`).run(this.userId(target), cutoff).changes === 1).immediate()
  }

  async authorizeAdministrator(administratorUserId: number): Promise<void> {
    this.db.transaction(() => requireSqliteAdministrator(this.db, administratorUserId)).immediate()
  }

  markControlStopping(target: RuntimeTarget, generation: number, reason: RuntimeStopReason, administratorUserId: number): Promise<boolean> {
    return this.markStopping(target, generation, reason, administratorUserId)
  }

  async markStopped(target: RuntimeTarget, generation: number, reason?: RuntimeStopReason): Promise<boolean> {
    if (generation !== 1) return false
    const userId = this.userId(target)
    return this.db.prepare(`UPDATE instances SET state = 'stopped', pid = NULL, stop_reason = CASE WHEN stop_reason = 'manual' THEN 'manual' ELSE COALESCE(?,stop_reason) END WHERE user_id = ?`)
      .run(reason ?? null, userId).changes === 1
  }

  async owner(target: RuntimeTarget): Promise<InstanceOwner | null> {
    const userId = this.userId(target)
    const row = this.db.prepare(`SELECT id, username, home_path FROM users WHERE id = ?`).get(userId) as
      | { id: number; username: string; home_path: string }
      | undefined
    return row === undefined ? null : { kind: 'user', id: row.id, username: row.username, homePath: row.home_path }
  }

  async personalPolicy(id: number, administratorUserId?: number): Promise<PersonalRuntimePolicy | null> {
    const read = () => {
      if (administratorUserId !== undefined) requireSqliteAdministrator(this.db, administratorUserId)
      const row = this.db.prepare(`SELECT u.id,u.username,u.home_path,u.role,u.status FROM users u
        JOIN instances i ON i.user_id=u.id WHERE u.id=? AND u.status='active' AND u.deleted_at IS NULL`).get(id) as
        { id: number; username: string; home_path: string; role: UserRow['role']; status: 'active' } | undefined
      return row === undefined ? null : { id: row.id, username: row.username, homePath: row.home_path, role: row.role, status: row.status }
    }
    return administratorUserId === undefined ? read() : this.db.transaction(read).immediate()
  }
}

export class InstanceManager {
  private readonly launcher: Launcher
  private readonly repository: InstanceRepository
  private readonly initialized: Promise<void>
  private readonly capacity: RuntimeCapacity
  private readonly residentLeases = new Map<string, RuntimeCapacityLease>()
  private readonly pendingStarts = new Map<string, RuntimeStartRequest>()
  private closedStartRequest: RuntimeStartRequest | undefined
  private readonly startControllers = new Map<string, Set<AbortController>>()
  private readonly addressQueue = new Map<string, Promise<void>>()
  private readonly procs = new Map<string, InstanceProc>()
  private readonly procGenerations = new WeakMap<InstanceProc, number>()
  private readonly procTokens = new WeakMap<InstanceProc, string>()
  private readonly wsRefs = new Map<string, number>()
  /** Aggregate WebSocket leases by runtime, independent of generation. */
  private readonly wsTotals = new Map<string, number>()
  /** Active HTTP/data-plane operations that must keep a runtime warm. */
  private readonly operationRefs = new Map<string, number>()
  /** Aggregate operation leases by runtime, independent of generation. */
  private readonly operationTotals = new Map<string, number>()
  /** Per-runtime operation chain: serializes start vs stop so a reap cannot orphan a fresh spawn. */
  private readonly ops = new Map<string, Promise<unknown>>()
  /** Reconcile-initiated starts per target this boot; the budget caps crash loops. */
  private readonly reconcileRestarts = new Map<string, number>()
  /** Gateway maintenance admission and writer accounting around the complete start operation. */
  startAdmission?: (operation: () => Promise<RuntimeEndpoint>) => Promise<RuntimeEndpoint>

  /**
   * Called with the resolved runtime just before it is spawned, on every start.
   * The wiring uses it to write the per-instance directory-grants file so the
   * grants handoff is intrinsic to starting an instance rather than a caller's
   * responsibility.
   */
  beforeStart?: (runtime: RuntimeLaunchContext) => void | Promise<void>
  /** Refresh versioned policy projections before a ready runtime serves work. */
  beforeUse?: (subject: RuntimeSubject) => void | Promise<void>

  constructor(
    source: Database.Database | InstanceRepository,
    private readonly cfg: GatewayConfig,
    launcher?: Launcher,
    private readonly security: RuntimeSecurityConfig = { principalPublicKey: '' },
    private readonly resources?: Pick<NodeResourceBudget, 'stopped' | 'registered' | 'admitRuntimeStart'>,
    private readonly processOwner?: Pick<GatewayModelBudget, 'withOwnership'>,
  ) {
    this.repository = 'prepare' in source ? new SqliteInstanceRepository(source) : source
    this.launcher = launcher ?? new LocalLauncher(cfg)
    this.capacity = new RuntimeCapacity(cfg.runtimeCapacity)
    this.initialized = this.repository.initialize().then(async () => {
      for (const target of await this.repository.activeTargets()) {
        const key = targetKey(target)
        this.residentLeases.set(key, this.capacity.adopt(key))
      }
    })
  }

  /** @returns node-local process admission counts; excludes AI, tool and child-process resource usage. */
  capacitySnapshot(): RuntimeCapacitySnapshot { return this.capacity.snapshot() }

  private releaseResident(key: string): void {
    this.residentLeases.get(key)?.release()
    this.residentLeases.delete(key)
  }

  private cancelStarts(target: RuntimeTargetInput): void {
    const resolved = targetOf(target), owner = `${resolved.kind}:${resolved.id}`
    for (const [key, controllers] of this.startControllers) {
      if (key !== owner && (resolved.runtimeId === undefined ? !key.startsWith(`${owner}:`) : key !== targetKey(resolved))) continue
      for (const controller of controllers) controller.abort()
    }
  }

  private async address(input: RuntimeTargetInput, cleanup = false): Promise<RuntimeTarget> {
    await this.initialized
    const target = targetOf(input)
    if (this.repository.resolveTarget === undefined) return { kind: target.kind, id: target.id }
    if (cleanup && target.runtimeId !== undefined) return target
    try { return await this.repository.resolveTarget(target) }
    catch (error) {
      if (!cleanup || !(error instanceof RuntimeStartBlockedError)) throw error
      const owner = `${target.kind}:${target.id}`
      const retained = [...new Set([...this.procs.keys(), ...this.residentLeases.keys()])]
        .filter(key => key === owner || key.startsWith(`${owner}:`))
      if (retained.length !== 1) throw error
      return targetFromKey(retained[0]!)
    }
  }

  private dispatch<T>(input: RuntimeTargetInput, operation: (target: RuntimeTarget) => Promise<T>, cleanup = false): Promise<T> {
    const target = targetOf(input), owner = `${target.kind}:${target.id}`
    const prior = this.addressQueue.get(owner) ?? Promise.resolve()
    // Release selection ordering once work enters its exact Runtime queue.
    const scheduled = prior.then(async () => ({ completion: operation(await this.address(target, cleanup)) }))
    const done = scheduled.then(() => undefined, () => undefined)
    this.addressQueue.set(owner, done)
    void done.then(() => { if (this.addressQueue.get(owner) === done) this.addressQueue.delete(owner) })
    return scheduled.then(({ completion }) => completion)
  }

  async portOf(target: RuntimeTargetInput): Promise<number> {
    await this.initialized
    return this.repository.portOf(targetOf(target))
  }

  /**
   * Resolve an existing selector without starting or probing a process.
   * @param target - exact Runtime identity or an unambiguous local owner.
   * @returns the assignment used by lifecycle and signed-operation callers.
   */
  resolveTarget(target: RuntimeTargetInput): Promise<RuntimeTarget> { return this.address(target) }

  /**
   * Find local assignments and retained lifecycle work for one account or project.
   * @param input - owner invalidated by a current organization policy change.
   * @returns exact Runtime identities; no process is contacted or started.
   */
  async targetsForOwner(input: RuntimeTargetInput): Promise<RuntimeTarget[]> {
    await this.initialized
    const target = targetOf(input)
    const assigned = this.repository.targetsForOwner === undefined
      ? await this.repository.owner(target) === null ? [] : [await this.address(target)]
      : await this.repository.targetsForOwner(target)
    const keys = new Set(assigned.map(targetKey))
    const prefix = `${target.kind}:${target.id}`
    for (const key of [...this.procs.keys(), ...this.residentLeases.keys(), ...this.startControllers.keys()]) {
      if (key === prefix || key.startsWith(`${prefix}:`)) keys.add(key)
    }
    return [...keys].map(targetFromKey)
  }

  /**
   * Resolve an assignment's local directories without starting it.
   * @param input - exact Runtime or unambiguous local owner, after caller authorization.
   * @returns persisted storage selection and supervisor identity.
   */
  async storageOf(input: RuntimeTargetInput): Promise<PersonalRuntimeStorage & { homePath: string; dshHome: string; runtimeKey: string }> {
    const target = await this.address(input), owner = await this.repository.owner(target)
    if (owner === null) throw new RuntimeStartBlockedError('unavailable')
    const layout = owner.kind === 'user' ? personalRuntimeLayout(this.cfg, { ...owner, runtimeId: target.runtimeId })
      : { runtimeKey: `project-${owner.id}`, dshHome: join(this.cfg.projectRuntimesRoot, String(owner.id), 'dsh') }
    return { ...layout, homePath: owner.homePath, runtimeId: target.runtimeId, storageLayout: owner.storageLayout, provisioning: owner.provisioning }
  }

  async stateOf(target: RuntimeTargetInput): Promise<string> {
    try { return this.repository.stateOf(await this.address(target)) }
    catch (error) {
      if (error instanceof RuntimeStartBlockedError && error.reason === 'unavailable') return 'stopped'
      throw error
    }
  }

  /**
   * Determine whether this node owns an assignment or retains its local lifecycle work.
   * @param target - account/project target from an organization-wide notification.
   * @returns true for a local assignment, tracked process, resident reservation or pending start.
   */
  async owns(target: RuntimeTargetInput): Promise<boolean> {
    await this.initialized
    const resolved = targetOf(target), owner = `${resolved.kind}:${resolved.id}`
    const retained = [...this.procs.keys(), ...this.residentLeases.keys(), ...this.startControllers.keys()]
      .some(key => key === targetKey(resolved) || resolved.runtimeId === undefined && key.startsWith(`${owner}:`))
    return retained
      || await this.repository.owner(resolved) !== null
  }

  async generationOf(target: RuntimeTargetInput): Promise<number> {
    await this.initialized
    return this.repository.generationOf(targetOf(target))
  }

  /** Read the durable stop reason without starting the target. */
  async stopReasonOf(target: RuntimeTargetInput): Promise<RuntimeStopReason | null> {
    await this.initialized
    return this.repository.stopReasonOf(targetOf(target))
  }

  /**
   * Whether this process still holds a live child for a `ready` row.
   * A crashed or externally killed child leaves the row `ready`; callers must
   * treat that as not live and go through {@link ensureRunning}. Supervisor
   * launchers whose units outlive the Gateway lazily re-attach the surviving
   * unit so admin reads answer from the real process; a handle is published
   * only while the durable state and captured generation still match.
   * @param target - runtime target
   * @returns true only while the row is `ready` and a tracked or attached runtime has not exited
   * @throws RuntimeStartBlockedError when supervision cannot establish liveness; existing occupation is retained.
   */
  async isLive(target: RuntimeTargetInput): Promise<boolean> {
    return await this.liveEndpoint(target) !== null
  }

  /**
   * Read one coherent endpoint and verify its captured generation through the supervisor and node accounting.
   * This observation grants no lease; forwarding must admit activity for the returned generation.
   * @param target - exact Runtime assignment or an unambiguous local owner.
   * @returns the supervised ready endpoint, or null after confirmed absence; unavailable supervision throws.
   */
  async liveEndpoint(target: RuntimeTargetInput): Promise<(RuntimeEndpoint & { target: RuntimeTarget }) | null> {
    await this.initialized
    const snapshot = await this.repository.snapshotOf(targetOf(target))
    if (snapshot === null || snapshot.state !== 'ready') return null
    const resolved = snapshot.target, generation = snapshot.generation
    const key = targetKey(resolved)
    let proc = this.procs.get(key)
    if (proc === undefined && this.launcher.attach !== undefined) {
      try {
        proc = await this.attachSurvivor(resolved, generation, await this.repository.credentialHashOf(resolved, generation))
      } catch (error: unknown) {
        console.error(`[gateway] failed to attach ${key} survivor:`, error)
        throw new RuntimeStartBlockedError('unavailable', 'Runtime supervision is unavailable. Retry after its state is confirmed.')
      }
      // A serialized stop or restart may have won while the supervisor
      // answered; never publish a handle whose durable state moved on.
      const current = proc === undefined ? null : await this.repository.snapshotOf(resolved)
      if (proc !== undefined && current?.state === 'ready'
        && current.generation === generation && current.port === snapshot.port) {
        this.procGenerations.set(proc, generation)
        this.procs.set(key, proc)
      } else {
        proc = undefined
      }
    }
    if (proc === undefined || this.procGenerations.get(proc) !== generation) return null
    if (this.resources !== undefined) {
      if (!await this.resources.registered(resolved, generation)) return null
    }
    let alive: boolean
    if (proc.isAlive !== undefined) {
      try { alive = await proc.isAlive() } catch (error) {
        console.error(`[gateway] Runtime supervisor liveness unavailable for ${key}:`, error)
        throw new RuntimeStartBlockedError('unavailable', 'Runtime supervision is unavailable. Retry after its state is confirmed.')
      }
    } else alive = !proc.hasExited()
    return alive ? { port: snapshot.port, generation, target: resolved,
      ...(resolved.runtimeId === undefined ? {} : { runtimeId: resolved.runtimeId }) } : null
  }

  async touch(target: RuntimeTargetInput): Promise<void> {
    await this.initialized
    const resolved = await this.address(target)
    await this.serialize(resolved, async () => {
      await this.repository.touch(resolved, Date.now())
    })
  }

  async wsRef(target: RuntimeTargetInput, delta: 1 | -1, generation?: number): Promise<void> {
    await this.changeLease(this.wsRefs, this.wsTotals, target, delta, generation)
  }

  /** Hold a runtime lease across a long request so idle reaping cannot stop it. */
  async operationRef(target: RuntimeTargetInput, delta: 1 | -1, generation?: number): Promise<void> {
    await this.changeLease(this.operationRefs, this.operationTotals, target, delta, generation)
  }

  /** Commit durable admission before retaining a reference; releases remain applied when activity storage fails. */
  private async changeLease(
    references: Map<string, number>, totals: Map<string, number>, target: RuntimeTargetInput, delta: 1 | -1, generation?: number,
  ): Promise<void> {
    await this.initialized
    const selected = targetOf(target)
    const resolved = delta === 1 && selected.runtimeId !== undefined && this.repository.resolveTarget !== undefined
      ? selected : await this.address(selected, delta === -1)
    await this.serialize(resolved, async () => {
      if (delta === 1 && !await this.repository.admitLease(resolved, Date.now(), generation)) {
        throw new RuntimeLeaseUnavailableError(resolved)
      }
      const key = leaseKey(resolved, generation)
      const prior = references.get(key) ?? 0
      const next = Math.max(0, prior + delta)
      if (next === 0) references.delete(key)
      else references.set(key, next)
      this.adjustLeaseTotal(totals, resolved, next - prior)
      if (delta === -1) await this.repository.touch(resolved, Date.now())
    })
  }

  /** Run `fn` after any in-flight start/stop for this runtime has settled. */
  private serialize<T>(target: RuntimeTargetInput, fn: () => Promise<T>): Promise<T> {
    const key = targetKey(target)
    const prev = this.ops.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(() => undefined, () => undefined)
    this.ops.set(key, tail)
    void tail.then(() => {
      if (this.ops.get(key) === tail) this.ops.delete(key)
    })
    return run
  }

  private async personalSubject(subject: PersonalRuntime, administratorUserId?: number): Promise<PersonalRuntime> {
    const policy = await this.repository.personalPolicy(subject.id, administratorUserId, subject.runtimeId)
    if (policy === null) throw new RuntimeStartBlockedError('unavailable')
    return { ...subject, ...policy }
  }

  private async personalPolicyMatches(user: PersonalRuntime, administratorUserId?: number): Promise<boolean> {
    const current = await this.repository.personalPolicy(user.id, administratorUserId, user.runtimeId)
    return current !== null && current.role === user.role && current.username === user.username
      && current.homePath === user.homePath && current.status === user.status && current.runtimeId === user.runtimeId
      && current.storageLayout === user.storageLayout
  }

  private async launchContext(subject: RuntimeSubject): Promise<Omit<RuntimeLaunchContext, 'generation'>> {
    if ('username' in subject) {
      const target = runtimeTargetOf(subject)
      const user = await this.personalSubject(subject)
      return {
        kind: 'user',
        ownerId: user.id,
        target,
        user,
        username: user.username,
        runtimeKey: personalRuntimeLayout(this.cfg, user).runtimeKey,
        systemUser: `harness-${user.username}`,
        privileged: user.role === 'admin',
        port: await this.portOf(target),
        homePath: user.homePath,
        dshHome: personalRuntimeLayout(this.cfg, user).dshHome,
      }
    }
    const target = runtimeTargetOf(subject)
    // Re-read the owner row at the launch boundary. The request that supplied
    // `subject` may have crossed a project rename/mount update; launching a
    // stale path would bypass the current project ownership record.
    const owner = await this.repository.owner(target)
    if (owner === null || owner.kind !== 'project' || owner.id !== subject.id
      || resolve(owner.homePath) !== resolve(subject.path)) {
      throw new Error(`project runtime ${String(subject.id)} ownership changed before launch`)
    }
    // Steward privileges only apply while the space is enabled; a disabled
    // steward row launches as an ordinary confined project runtime. The
    // database kind, not the caller's flag, authorizes the privileged unit so
    // a forged subject cannot elevate a standard project.
    const steward = subject.steward === true && owner.projectKind === 'steward' && this.cfg.steward.enabled
    const projectPath = validateProjectRuntimePath(this.cfg, subject.path, owner.projectOrigin)
    return {
      kind: 'project',
      ownerId: subject.id,
      target,
      project: { ...subject, path: projectPath, steward },
      username: `project-${String(subject.id)}`,
      runtimeKey: `project-${String(subject.id)}`,
      systemUser: steward ? this.cfg.steward.runtimeUser : this.cfg.projectRuntimeUser,
      // The steward unit runs privileged so its agent can reach the release
      // tree and deployment tooling it maintains; ordinary project runtimes
      // stay masked to their project path.
      privileged: steward,
      resident: steward,
      port: await this.portOf(target),
      homePath: projectPath,
      dshHome: join(this.cfg.projectRuntimesRoot, String(subject.id), 'dsh'),
    }
  }

  /**
   * Await readiness with the start-request authority and deduplication rules.
   * @param subject - authorized personal or project owner facts.
   * @param intent - passive, explicit or webhook start policy.
   * @param administratorUserId - initiating administrator for Admin control; omission permits trusted lifecycle maintenance.
   * @returns the authenticated ready port and generation.
   */
  ensureRunning(subject: RuntimeSubject, intent: RuntimeStartIntent = 'passive', administratorUserId?: number): Promise<RuntimeEndpoint> {
    return this.startRequest(subject, intent, administratorUserId).completion
  }

  /**
   * Request a Runtime start while allowing HTTP callers to observe admission before readiness.
   * @param subject - authorized user or project whose Runtime is required.
   * @param intent - passive, explicit or webhook start policy.
   * @param administratorUserId - initiating administrator for Admin control; omission permits trusted lifecycle maintenance.
   * @returns one shared operation per target, intent and initiating administrator while its start remains unsettled.
   */
  startRequest(subject: RuntimeSubject, intent: RuntimeStartIntent = 'passive', administratorUserId?: number): RuntimeStartRequest {
    if (this.closedStartRequest !== undefined) return this.closedStartRequest
    const key = targetKey(runtimeTargetOf(subject))
    const requestKey = administratorUserId === undefined ? `${key}:${intent}` : `${key}:${intent}:administrator:${String(administratorUserId)}`
    const pending = this.pendingStarts.get(requestKey)
    if (pending !== undefined) return pending
    const controller = new AbortController()
    let controllers = this.startControllers.get(key)
    if (controllers === undefined) this.startControllers.set(key, controllers = new Set())
    controllers.add(controller)
    let accept!: () => void
    let refuse!: (error: unknown) => void
    const admission = new Promise<void>((resolve, reject) => { accept = resolve; refuse = reject })
    // ensureRunning consumers observe readiness only; keep the optional admission result contained.
    void admission.catch(() => {})
    const run = this.dispatch(runtimeTargetOf(subject), target => this.ensureRunningNow(
      { ...subject, runtimeId: target.runtimeId }, intent, controller.signal, accept, administratorUserId)).then(result => {
      accept()
      return result
    }, error => {
      refuse(error)
      throw error
    })
    const operation: RuntimeStartRequest = { admission, completion: run }
    this.pendingStarts.set(requestKey, operation)
    void run.finally(() => {
      if (this.pendingStarts.get(requestKey) === operation) this.pendingStarts.delete(requestKey)
      controllers.delete(controller)
      if (controllers.size === 0) this.startControllers.delete(key)
    }).catch(() => {})
    return operation
  }

  private ensureRunningNow(subject: RuntimeSubject, intent: RuntimeStartIntent, signal: AbortSignal, accept: () => void, administratorUserId?: number): Promise<RuntimeEndpoint> {
    const target = runtimeTargetOf(subject)
    return this.serialize(target, async () => {
      await this.initialized
      if (this.closedStartRequest !== undefined) throw new RuntimeCapacityError('cancelled')
      if (administratorUserId !== undefined) await this.repository.authorizeAdministrator(administratorUserId)
      if (await this.repository.startEligibility(target) === null) {
        const previous = await this.repository.snapshotOf(target)
        if (previous === null || !await this.repository.markExpiredConnectionStopping(target, previous.generation, administratorUserId)) {
          throw new RuntimeStartBlockedError('unavailable')
        }
        const stopped = await this.terminate(target, 'access-change', previous.generation, false, undefined, administratorUserId)
        if (stopped !== previous.generation || await this.repository.startEligibility(target) === null) {
          throw new RuntimeStartBlockedError('unavailable')
        }
      }
      const port = await this.portOf(target)
      const proc = this.procs.get(targetKey(target))
      if (await this.stateOf(target) === 'ready') {
        let live = proc
        if (live === undefined && this.launcher.attach !== undefined) {
          // Supervisor-owned runtimes survive a Gateway restart. Rebuild the
          // process handle before deciding to launch a new generation; doing
          // so preserves the runtime token and avoids needlessly restarting a
          // healthy survivor.
          try {
            const generation = await this.repository.generationOf(target)
            live = this.launcher.attach({ ...await this.launchContext(subject), generation,
              credentialHash: await this.repository.credentialHashOf(target, generation) })
            this.procGenerations.set(live, generation)
            this.procs.set(targetKey(target), live)
          } catch (error: unknown) {
            // Without a handle the existing process cannot be confirmed stopped.
            console.error(`[gateway] failed to re-attach ${targetKey(target)} survivor:`, error)
            live = undefined
          }
        }
        let alive = false
        if (live !== undefined) {
          try {
            alive = live.isAlive !== undefined ? await live.isAlive() : !live.hasExited()
          } catch (error: unknown) {
            console.error(`[gateway] survivor liveness probe failed for ${targetKey(target)}:`, error)
            throw new RuntimeStartBlockedError('unavailable', 'Runtime supervision is unavailable. Retry after its state is confirmed.')
          }
        }
        if (alive) {
          const generation = await this.repository.generationOf(target)
          if (live === undefined || this.procGenerations.get(live) !== generation) {
            throw new RuntimeStartBlockedError('unavailable', 'Runtime supervision changed. Retry after its current generation is confirmed.')
          }
          if (this.resources !== undefined && !await this.resources.registered(target, generation)) {
            throw new RuntimeStartBlockedError('unavailable', 'Runtime resource admission is unavailable. Restart this Runtime before using it.')
          }
          const current = 'username' in subject ? await this.personalSubject(subject, administratorUserId) : subject
          if (administratorUserId !== undefined && !('username' in current)) await this.repository.authorizeAdministrator(administratorUserId)
          await this.beforeUse?.(current)
          if (administratorUserId !== undefined) {
            if ('username' in current) {
              if (!await this.personalPolicyMatches(current, administratorUserId)) {
                throw new RuntimeStartBlockedError('unavailable', 'Runtime account policy changed during refresh. Retry with current authority.')
              }
            } else await this.repository.authorizeAdministrator(administratorUserId)
          }
          return { port, generation, ...(target.runtimeId === undefined ? {} : { runtimeId: target.runtimeId }) }
        }
        // A dead root can leave descendants running; release only after confirmed termination.
        if (live === undefined && this.residentLeases.has(targetKey(target))) {
          throw new RuntimeStartBlockedError('unavailable', 'The runtime has an unconfirmed existing process. Stop it successfully before starting it again.')
        }
        if (live !== undefined) {
          const generation = this.procGenerations.get(live)
          if (generation === undefined) throw new Error(`Runtime ${targetKey(target)} has no confirmed process generation`)
          if (administratorUserId !== undefined) await this.repository.authorizeAdministrator(administratorUserId)
          await live.terminate(STOP_GRACE_MS)
          await this.publishQuiescence(target, generation, 'failed')
        }
        this.procs.delete(targetKey(target))
        this.releaseResident(targetKey(target))
      }
      if (this.residentLeases.has(targetKey(target))) {
        throw new RuntimeStartBlockedError('unavailable', 'The runtime has an incomplete start or stop. Stop it successfully before starting it again.')
      }
      const reason = await this.repository.stopReasonOf(target)
      if (intent !== 'explicit' && (reason === 'manual' || intent === 'webhook' && reason !== 'idle')) {
        const eligible = await this.repository.startEligibility(target)
        if (eligible === null) throw new RuntimeStartBlockedError('unavailable')
        if (eligible.stopReason === 'manual' || intent === 'webhook' && eligible.stopReason !== 'idle') {
          throw new RuntimeStartBlockedError(eligible.stopReason)
        }
      }
      const request = this.capacity.request(targetKey(target), signal)
      accept()
      const lease = await request.lease
      this.residentLeases.set(targetKey(target), lease)
      try {
        if (signal.aborted) throw new RuntimeCapacityError('cancelled')
        const start = async () => {
          if (administratorUserId !== undefined) await this.repository.authorizeAdministrator(administratorUserId)
          return this.start(await this.launchContext(subject), port, intent, signal, administratorUserId)
        }
        const result = await (this.startAdmission === undefined ? start() : this.startAdmission(start))
        lease.ready()
        return result
      } catch (error) {
        // Failed termination retains the process handle and its reservation.
        if (!this.procs.has(targetKey(target))) this.releaseResident(targetKey(target))
        throw error
      }
    })
  }

  private removeInstalledPolicyPackage(packagePath: string): void {
    const entry = lstatSync(packagePath, { throwIfNoEntry: false })
    if (entry === undefined) return
    if (entry.isSymbolicLink()) {
      unlinkSync(packagePath)
      return
    }
    if (!entry.isDirectory()) throw new Error(`policy package target is not a directory: ${packagePath}`)
    rmSync(packagePath, { recursive: true })
  }

  private materializePolicyPackage(sourceDir: string, targetDir: string, patchFiles: string[]): void {
    const manifest = join(sourceDir, 'package.json')
    const lib = join(sourceDir, 'lib')
    if (!existsSync(manifest) || !existsSync(lib)) {
      throw new Error(`policy package is incomplete: ${sourceDir}`)
    }
    for (const patchFile of patchFiles) {
      if (!existsSync(patchFile)) throw new Error(`policy package patch not found: ${patchFile}`)
    }

    const stagingDir = join(
      dirname(targetDir),
      `.${basename(targetDir)}-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
    )
    mkdirSync(stagingDir, { mode: 0o700 })
    try {
      copyFileSync(manifest, join(stagingDir, 'package.json'))
      cpSync(lib, join(stagingDir, 'lib'), { recursive: true, dereference: true })
      // Display metadata resolves through the materialized copy, so the locale
      // dictionaries ship beside lib; without them the plugin list falls back
      // to the raw manifest name and description.
      const localeDir = join(sourceDir, 'locale')
      if (existsSync(localeDir)) cpSync(localeDir, join(stagingDir, 'locale'), { recursive: true, dereference: true })
      const bundlePatch = join(sourceDir, 'cordis.patch.yml')
      const copiedPatches = new Set(existsSync(bundlePatch) ? [bundlePatch, ...patchFiles] : patchFiles)
      const adminPatch = join(sourceDir, ADMIN_GUARD_PATCH_FILENAME)
      if (existsSync(adminPatch)) copiedPatches.add(adminPatch)
      for (const patchFile of copiedPatches) {
        copyFileSync(patchFile, join(stagingDir, basename(patchFile)))
      }
      this.preparePolicyArtifactAccess(stagingDir)
      this.removeInstalledPolicyPackage(targetDir)
      renameSync(stagingDir, targetDir)
    } catch (error) {
      this.removeInstalledPolicyPackage(stagingDir)
      throw error
    }
  }

  /** Policy code must be readable by the assigned Unix account inside its private Runtime home. */
  private preparePolicyArtifactAccess(directory: string): void {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const entry = lstatSync(path)
      if (entry.isDirectory()) this.preparePolicyArtifactAccess(path)
      else if (entry.isFile()) chmodSync(path, (entry.mode & 0o111) === 0 ? 0o644 : 0o755)
      else throw new Error(`policy artifact is not a regular file or directory: ${path}`)
    }
    chmodSync(directory, 0o755)
  }

  /**
   * Mount the mandatory model-governance bundle and, when configured, the
   * independent directory-guard bundle. Their patch sequences are composed
   * into the one home-level patch file dsh loads. Turning the directory guard
   * off must never turn model authorization or usage accounting off.
   */
  private mountPolicyBundles(runtime: RuntimeLaunchContext): void {
    const governanceDir = this.cfg.modelGovernancePackage
    const governancePatch = join(governanceDir, 'cordis.patch.yml')
    if (!existsSync(join(governanceDir, 'package.json')) || !existsSync(governancePatch)) {
      throw new Error(`model-governance package is incomplete: ${governanceDir}`)
    }

    const dshHome = runtime.dshHome
    const packageParent = prepareRuntimeProfileDirectory(dshHome, INSTANCE_PROFILE)
    // Policy copies placed in the shared `profiles/node_modules` fallback by
    // earlier releases are unreachable under runtime resolution; drop them.
    const legacyParent = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
    for (const name of [
      'dsh-model-governance',
      'dsh-directory-guard',
      'dsh-steward-tools',
      'dsh-experimental-computer-use-cua-driver-mcp',
    ]) {
      this.removeInstalledPolicyPackage(join(legacyParent, name))
    }
    try {
      // Policy copies live in the instance profile's own node_modules. Peer
      // imports inside them resolve through the runtime resolver's package
      // generation (the dsh installation closure), so only the policy packages
      // themselves — which no manifest declares — need a physical copy here.
      const governancePackage = join(packageParent, 'dsh-model-governance')
      this.materializePolicyPackage(governanceDir, governancePackage, [governancePatch])

      let patchText = readFileSync(governancePatch, 'utf8').trimEnd() + '\n'
      const readinessPlugins = ['model-governance', 'gateway-execution', 'desktop-availability', ...(this.cfg.guardPatch === '' ? [] : ['directory-guard'])]
      patchText += `- id: gateway-runtime\n  config:\n    requiredPlugins: ${JSON.stringify(readinessPlugins)}\n`
      patchText += `- id: gateway-resource-budget\n  config:\n    requestTimeoutMs: ${String(this.cfg.runtimeRequestTimeoutMs)}\n    cleanupTimeoutMs: ${String(this.cfg.runtimeCleanupTimeoutMs)}\n`
      patchText += `- id: connection\n  config:\n    rpcTimeoutMs: ${String(this.cfg.runtimeBrowserRpcTimeoutMs)}\n    recovery:\n      streamOpenTimeoutMs: ${String(this.cfg.runtimeBrowserStreamTimeoutMs)}\n      generationReadyTimeoutMs: ${String(this.cfg.runtimeBrowserReadyTimeoutMs)}\n`
      const guardPatch = this.cfg.guardPatch
      const guardPackage = join(packageParent, 'dsh-directory-guard')
      this.removeInstalledPolicyPackage(guardPackage)
      if (guardPatch !== '') {
        if (!existsSync(guardPatch)) {
          throw new Error(`directory-guard patch not found: ${guardPatch} (set HGW_GUARD_PATCH=off to disable)`)
        }
        const guardDir = dirname(guardPatch)
        const guardPatchFiles = [guardPatch]
        if (runtime.user?.role === 'admin') {
          const adminPatch = join(guardDir, ADMIN_GUARD_PATCH_FILENAME)
          if (!existsSync(adminPatch)) {
            throw new Error(`directory-guard admin patch not found: ${adminPatch}`)
          }
          guardPatchFiles.push(adminPatch)
        }
        this.materializePolicyPackage(guardDir, guardPackage, guardPatchFiles)
        patchText += readFileSync(guardPatch, 'utf8').trimEnd() + '\n'
        if (runtime.user?.role === 'admin') {
          const adminPatch = join(guardDir, ADMIN_GUARD_PATCH_FILENAME)
          patchText += readFileSync(adminPatch, 'utf8').trimEnd() + '\n'
        }
      }
      if (runtime.kind === 'project') patchText += PROJECT_RUNTIME_PATCH
      if (runtime.project?.steward === true) {
        // The resident steward mounts its operator tools from a deployment
        // package, exactly like the model-governance mount: the patch file
        // declares the plugin entries and permission presets the package owns.
        const stewardPackage = this.cfg.steward.toolsPackage
        const stewardPatch = join(stewardPackage, 'cordis.patch.yml')
        if (!existsSync(join(stewardPackage, 'package.json')) || !existsSync(stewardPatch)) {
          throw new Error(`steward tools package is incomplete: ${stewardPackage}`)
        }
        this.materializePolicyPackage(
          stewardPackage,
          join(packageParent, 'dsh-steward-tools'),
          [stewardPatch],
        )
        patchText += readFileSync(stewardPatch, 'utf8').trimEnd() + '\n'
      }
      patchText += '- id: plugin-manager\n  inject: [pluginManagementAuthorization]\n  config:\n    authorization: required\n'
      patchText += '- id: api-gateway\n  inject: [executionAuthority]\n'
      patchText += `- id: connection\n  config:\n    serverTiming: ${String(this.cfg.performanceEnabled)}\n`
      if (this.cfg.officeFontMetadataCacheDirectory !== undefined) {
        patchText += `- id: office-to-pdf\n  config:\n    fontMetadataCacheDirectory: ${JSON.stringify(this.cfg.officeFontMetadataCacheDirectory)}\n`
      }
      patchText += "- insert:\n    - id: desktop-availability\n      name: '@deepseek-ai/dsh-gateway-execution/desktop-availability'\n"
      // Remote-desktop providers share the gateway's administration files so
      // grants and endpoints managed in /admin take effect in every runtime.
      patchText += `- id: remote-desktop-vnc
  config:
    endpointsFile: ${JSON.stringify(join(this.cfg.remoteDesktopDir, 'endpoints.json'))}
    grantsFile: ${JSON.stringify(join(this.cfg.remoteDesktopDir, 'grants.jsonl'))}
    auditFile: ${JSON.stringify(join(this.cfg.remoteDesktopDir, 'audit.jsonl'))}
    recordingDir: ${JSON.stringify(join(this.cfg.remoteDesktopDir, 'recordings'))}
`
      if (this.cfg.desktopId !== undefined) {
        // The provisioned driver package is materialized beside the policy
        // plugins so the runtime resolves it from the instance profile's
        // node_modules; `dsh-computer-use` arrives through the installation
        // fallback as a peer of the mounted gateway-execution.
        this.materializePolicyPackage(
          this.cfg.desktopDriverPackage,
          join(packageParent, 'dsh-experimental-computer-use-cua-driver-mcp'),
          [],
        )
        patchText += managedDesktopPatch(this.cfg, this.cfg.desktopId)
      }
      writeFileSync(join(dshHome, 'cordis.patch.yml'), patchText)
    } catch (error) {
      throw new Error(`policy bundle mount failed for ${runtime.runtimeKey ?? runtime.username}: ${String(error)}`)
    }
  }

  /**
   * Copy the company default credentials file to the instance's
   * `$DSH_HOME/.env` (the dsh user-env layer). Refreshed every start so a
   * rotated company key propagates. Personal runtimes retain their managed
   * override; project runtimes remove it and expose credential writes as read-only.
   */
  private seedDefaultEnv(runtime: RuntimeLaunchContext): void {
    if (runtime.kind === 'project') {
      rmSync(join(runtime.dshHome, MANAGED_CREDENTIALS_FILENAME), { force: true })
    }
    const source = this.cfg.defaultEnvFile
    if (source === '') return
    if (!existsSync(source)) throw new Error(`default env file not found: ${source} (unset HGW_DEFAULT_ENV_FILE to disable)`)
    const dshHome = runtime.dshHome
    mkdirSync(dshHome, { recursive: true })
    copyFileSync(source, join(dshHome, '.env'))
    if (process.platform !== 'win32') {
      const owner = lstatSync(dshHome)
      chownSync(join(dshHome, '.env'), owner.uid, owner.gid)
      chmodSync(join(dshHome, '.env'), 0o600)
    }
  }

  private async start(
    descriptor: Omit<RuntimeLaunchContext, 'generation'>,
    port: number,
    intent: RuntimeStartIntent,
    signal: AbortSignal,
    administratorUserId?: number,
  ): Promise<RuntimeEndpoint> {
    const now = Date.now()
    const runtimeToken = randomBytes(32).toString('base64url')
    const runtimeTokenHash = createHash('sha256').update(runtimeToken).digest()
    const verifyPreparedStorage=await this.repository.checkProjectStorage?.(descriptor.target)
    const generation = await this.repository.beginStart(
      descriptor.target,
      now,
      runtimeTokenHash,
      intent,
      administratorUserId,
    )
    const runtime: RuntimeLaunchContext = { ...descriptor, generation }
    const key = targetKey(runtime.target)
    let proc: InstanceProc | undefined
    try {
      if (runtime.kind === 'project' && this.cfg.launcher === 'systemd') {
        await prepareProjectRuntimeData(this.cfg, runtime.ownerId, runtime.systemUser, INSTANCE_PROFILE, signal)
      }
      this.mountPolicyBundles(runtime)
      this.seedDefaultEnv(runtime)
      await this.beforeStart?.(runtime)
      await verifyPreparedStorage?.()
      if (signal.aborted) throw new RuntimeCapacityError('cancelled')
      const gatewayCredential = JSON.stringify({
        version: 1,
        gatewayUrl: `http://127.0.0.1:${String(this.cfg.port)}`,
        organization: this.cfg.organizationSlug,
        runtime: { ...runtime.target, generation },
        token: runtimeToken,
        principalPublicKey: this.security.principalPublicKey,
        ...(this.cfg.streamPrincipalRenewal.enabled ? { streamPrincipalRenewal: this.cfg.streamPrincipalRenewal } : {}),
      })
      const resources = this.resources
      try { proc = await this.launcher.start({
        ...runtime, credentialHash: runtimeTokenHash.toString('hex'), gatewayCredential, signal,
        beforeAllocation: async () => {
          await resources?.admitRuntimeStart(runtime.target, generation, signal)
          if (runtime.user !== undefined) {
            if (!await this.personalPolicyMatches(runtime.user, administratorUserId)) {
              throw new RuntimeStartBlockedError('unavailable', 'Runtime account policy changed before allocation. Retry with current authority.')
            }
          } else if (administratorUserId !== undefined) await this.repository.authorizeAdministrator(administratorUserId)
          if (signal.aborted) throw new RuntimeCapacityError('cancelled')
        },
      }) } catch (launchError: unknown) {
        if (launchError instanceof RuntimeLaunchCleanupError) {
          proc = launchError.process
          this.procGenerations.set(proc, generation)
          this.procs.set(key, proc)
        }
        throw launchError
      }
      this.procGenerations.set(proc, generation)
      this.procs.set(key, proc)
      if (proc.exited !== undefined) {
        const observed = proc
        void proc.exited.then(() => this.serialize(runtime.target, async () => {
          if (this.procs.get(key) === observed) await this.terminate(runtime.target, 'failed', generation)
        })).catch((error: unknown) => { console.error(`[gateway] Runtime exit cleanup failed for ${key}:`, error) })
      }

      const deadline = performance.now() + this.cfg.readinessTimeoutMs
      const launched = proc
      this.procTokens.set(launched, runtimeToken)
      const withinDeadline = (): boolean => {
        if (signal.aborted) throw new RuntimeCapacityError('cancelled')
        return performance.now() < deadline && !launched.hasExited()
      }
      const readinessNonce = randomBytes(32).toString('base64url')
      const readinessIdentity = {
        kind: runtime.kind,
        id: runtime.ownerId,
        generation,
        runtimeId: runtime.target.runtimeId,
      } as const
      const readinessRequest = runtimeReadinessRequestProof(runtimeToken, readinessNonce, readinessIdentity)
      const readinessExpected = runtimeReadinessResponseProof(runtimeToken, readinessNonce, readinessIdentity)
      while (withinDeadline()) {
        let authenticated = false
        try {
          const remaining = deadline - performance.now()
          if (remaining <= 0) break
          const probeTimeoutMs = Math.max(1, Math.floor(Math.min(1000, remaining)))
          const authority = `127.0.0.1:${String(port)}`
          const response = await fetch(`http://${authority}${RUNTIME_READINESS_PATH}`, {
            method: 'GET',
            headers: {
              host: authority,
              [RUNTIME_READINESS_NONCE_HEADER]: readinessNonce,
              [RUNTIME_READINESS_REQUEST_HEADER]: readinessRequest,
            },
            signal: AbortSignal.any([signal, AbortSignal.timeout(probeTimeoutMs)]),
          })
          if (response.ok) {
            const value: unknown = await readResponseJson(response, this.cfg.upstreamResponseLimitBytes)
            const body = typeof value === 'object' && value !== null && !Array.isArray(value)
              ? value as Record<string, unknown>
              : undefined
            const identity = typeof body?.runtime === 'object' && body.runtime !== null && !Array.isArray(body.runtime)
              ? body.runtime as Record<string, unknown>
              : undefined
            if (body?.version !== 1
              || identity?.kind !== readinessIdentity.kind
              || identity?.id !== readinessIdentity.id
              || identity?.generation !== readinessIdentity.generation
              || identity?.runtimeId !== readinessIdentity.runtimeId
              || !sameRuntimeReadinessProof(readinessExpected, body.proof)) {
              throw new Error('runtime readiness identity proof did not match the launched instance')
            }
            authenticated = true
          } else await response.body?.cancel()
        } catch (_unavailableReadinessProbe) {
          // Transport, response data and challenge proofs can remain unavailable during startup.
        }
        if (!withinDeadline()) break
        if (authenticated) {
          const registered = this.resources === undefined || await this.resources.registered(runtime.target, generation)
          if (!withinDeadline()) break
          if (registered) {
            await this.repository.markReady(runtime.target, generation)
            if (!withinDeadline()) break
            return { port, generation, ...(runtime.target.runtimeId === undefined ? {} : { runtimeId: runtime.target.runtimeId }) }
          }
        }
        const remaining = deadline - performance.now()
        if (remaining <= 0) break
        try { await delay(Math.min(POLL_INTERVAL_MS, remaining), undefined, { signal }) }
        catch (error) {
          if (signal.aborted) throw new RuntimeCapacityError('cancelled')
          throw error
        }
      }
      throw new Error(`instance for ${runtime.runtimeKey ?? runtime.username} failed to become ready on port ${port}`)
    } catch (error) {
      // A failed post-beginStart path must never strand the durable row in
      // `starting`; terminate the child first, then publish the stopped state.
      let terminated = proc === undefined
      if (proc !== undefined) {
        try { await proc.terminate(STOP_GRACE_MS); terminated = true } catch (cleanupError: unknown) {
          console.error(`[gateway] failed to terminate instance ${key}:`, cleanupError)
        }
      }
      if (terminated) {
        try {
          await this.publishQuiescence(runtime.target, generation, 'failed')
          if (this.procs.get(key) === proc) this.procs.delete(key)
        } catch (cleanupError: unknown) {
          console.error(`[gateway] failed to roll back instance ${key}:`, cleanupError)
        }
      }
      throw error
    }
  }

  async reapIdle(): Promise<number> {
    await this.initialized
    const cutoff = Date.now() - this.cfg.idleTimeoutMs
    const targets = await this.repository.idleTargets(cutoff)
    let stopped = 0
    const seen = new Set<string>()
    for (const target of targets) {
      const key = targetKey(target)
      if (seen.has(key)) continue
      seen.add(key)
      const didStop = await this.serialize(target, async () => {
        // Re-check the durable idle predicate after waiting for queued touch
        // and lease operations. The initial query is only a candidate scan.
        const stillIdle = await this.repository.idleTarget(target, cutoff)
        if (!stillIdle
          || (this.wsTotals.get(targetKey(target)) ?? 0) > 0
          || (this.operationTotals.get(targetKey(target)) ?? 0) > 0) return false
        const generation = await this.confirmHostIdle(target)
        if (generation === undefined) return false
        if (!await this.repository.idleTarget(target, cutoff)) return false
        return await this.terminate(target, 'idle', generation, false, undefined, undefined, cutoff) !== undefined
      })
      if (didStop) stopped += 1
    }
    return stopped
  }

  /**
   * Reconcile durable rows with observed processes on this node. Ready rows
   * whose process can no longer be confirmed alive are published `failed`;
   * recently used stopped runtimes restart through ordinary passive
   * admission. Manual and access-change stops are never reverted, and
   * reconcile-initiated starts are budgeted per boot so a crash loop
   * settles as `failed` instead of burning generations forever.
   * @returns per-tick counts for operator visibility.
   */
  async reconcile(): Promise<{ failed: number; warmed: number; budgeted: number }> {
    await this.initialized
    const summary = { failed: 0, warmed: 0, budgeted: 0 }
    for (const key of [...this.residentLeases.keys()]) {
      const target = targetFromKey(key)
      try {
        const snapshot = await this.repository.snapshotOf(target)
        if (snapshot === null || snapshot.state !== 'ready') continue
        const tracked = this.procs.get(key)
        let dead = false
        if (tracked !== undefined) {
          try {
            dead = tracked.isAlive === undefined ? tracked.hasExited() : !await tracked.isAlive()
          } catch { /* unavailable supervision is not death evidence */ }
        } else {
          let endpoint: Awaited<ReturnType<InstanceManager['liveEndpoint']>> = null
          try { endpoint = await this.liveEndpoint(snapshot.target) }
          catch (error) {
            if (!(error instanceof RuntimeStartBlockedError)) throw error
            continue
          }
          if (endpoint !== null) continue
          // An unregistered row is a resource-publication gap, not death evidence.
          dead = this.resources === undefined || await this.resources.registered(snapshot.target, snapshot.generation)
        }
        if (!dead) continue
        await this.stop(snapshot.target, 'failed')
        summary.failed += 1
      } catch (error) {
        console.error(`[gateway] reconcile probe for ${key} failed:`, error)
      }
    }
    const cutoff = Date.now() - this.cfg.reconcile.warmWindowMs
    for (const target of await this.repository.warmTargets?.(cutoff) ?? []) {
      const key = targetKey(target)
      const attempts = this.reconcileRestarts.get(key) ?? 0
      if (attempts >= this.cfg.reconcile.maxRestarts) { summary.budgeted += 1; continue }
      try {
        const subject = await this.warmSubject(target)
        if (subject === undefined) continue
        this.reconcileRestarts.set(key, attempts + 1)
        await this.ensureRunning(subject, 'passive')
        summary.warmed += 1
      } catch (error) {
        // Eligibility, admission pressure and racing operator stops are
        // legitimate refusals; the next tick re-evaluates the row.
        if (!(error instanceof RuntimeStartBlockedError) && !(error instanceof RuntimeCapacityError)) {
          console.error(`[gateway] reconcile warm for ${key} failed:`, error)
        }
      }
    }
    return summary
  }

  /**
   * Build the launch subject for a warmable target from its current owner
   * row. Personal policy refills account facts at admission, so id and
   * username suffice to address it.
   */
  private async warmSubject(target: RuntimeTarget): Promise<RuntimeSubject | undefined> {
    const owner = await this.repository.owner(target)
    if (owner === null) return undefined
    if (target.kind === 'user') {
      return { id: owner.id, username: owner.username, homePath: owner.homePath, runtimeId: target.runtimeId } as PersonalRuntime
    }
    return { kind: 'project', id: target.id, name: owner.name ?? '', path: owner.homePath,
      ...(target.runtimeId === undefined ? {} : { runtimeId: target.runtimeId }) }
  }

  private async confirmHostIdle(target: RuntimeTarget): Promise<number | undefined> {
    const proc = this.procs.get(targetKey(target))
    const token = proc === undefined ? undefined : this.procTokens.get(proc)
    const generation = proc === undefined ? undefined : this.procGenerations.get(proc)
    if (token === undefined || generation === undefined) return undefined
    try {
      const snapshot = await this.repository.snapshotOf(target)
      if (snapshot === null || snapshot.state !== 'ready' || snapshot.generation !== generation) return undefined
      const identity = { kind: target.kind, id: target.id, generation }
      const nonce = randomBytes(32).toString('base64url')
      const authority = `127.0.0.1:${String(snapshot.port)}`
      const response = await fetch(`http://${authority}${RUNTIME_READINESS_PATH}`, {
        redirect: 'error',
        headers: { host: authority, [RUNTIME_READINESS_NONCE_HEADER]: nonce,
          [RUNTIME_READINESS_REQUEST_HEADER]: runtimeReadinessRequestProof(token, nonce, identity) },
        signal: AbortSignal.timeout(this.cfg.runtimeRequestTimeoutMs),
      })
      if (response.status !== 200) { await response.body?.cancel(); return undefined }
      const value = await readResponseJson(response, 4096)
      if (typeof value !== 'object' || value === null) return undefined
      const body = value as { version?: unknown; runtime?: { kind?: unknown; id?: unknown; generation?: unknown; runtimeId?: unknown };
        idle?: { policy?: unknown; canStop?: unknown; proof?: unknown } }
      if (body.version !== 1 || body.runtime?.kind !== target.kind || body.runtime.id !== target.id
        || body.runtime.generation !== generation || body.runtime.runtimeId !== target.runtimeId
        || body.idle?.policy !== 'on-demand' || body.idle.canStop !== true) return undefined
      return sameRuntimeReadinessProof(runtimeIdleResponseProof(token, nonce, identity, 'on-demand', true), body.idle.proof)
        ? generation : undefined
    } catch (error) {
      console.warn('[gateway] idle confirmation unavailable; retaining Runtime until a later successful check',
        { runtime: targetKey(target), generation, error: error instanceof Error ? error.name : 'unknown' })
      return undefined
    }
  }

  /**
   * Stop an assignment after current administrative admission when supplied.
   * @param target - runtime assigned to this node.
   * @param reason - durable stop reason.
   * @param administratorUserId - checked before queued-start cancellation and again at stop intent; omission permits trusted maintenance.
   * @returns completion after confirmed termination and accounting; revocation can refuse later work after an already approved cancellation.
   */
  async stop(target: RuntimeTargetInput, reason: RuntimeStopReason = 'manual', administratorUserId?: number): Promise<void> {
    if (administratorUserId !== undefined) {
      await this.initialized
      await this.repository.authorizeAdministrator(administratorUserId)
    }
    this.cancelStarts(target)
    return this.dispatch(target, resolved => this.serialize(resolved, async () => {
      if (administratorUserId !== undefined) await this.repository.authorizeAdministrator(administratorUserId)
      await this.terminate(resolved, reason, undefined, false, undefined, administratorUserId)
    }), true)
  }

  /**
   * Confirm quiescence and retain the stop operation through the callback; only confirmed termination permits stopped publication on failure.
   * @param target - runtime whose starts and stops remain serialized
   * @param operation - work that requires the runtime to remain stopped
   * @param actorUserId - authenticated administrator checked with the initial stop transition before cancellation or termination; omission permits trusted lifecycle maintenance.
   * @param expectedGeneration - reviewed process generation; a mismatch refuses before cancelling starts or reserving a destructive operation.
   * @param purpose - process-only control permits stopping a reserved project; the default preserves destructive project protection.
   * @returns the operation result
   */
  async withStopped<T>(target: RuntimeTargetInput, operation: (lease?: RuntimeStopLease) => Promise<T>, actorUserId?: number, expectedGeneration?: number,
    purpose: RuntimeStopPurpose = 'destructive'): Promise<T> {
    if (purpose === 'content-publication' && (this.repository.acquireStopLease === undefined || this.repository.confirmStopLease === undefined)) {
      throw new RuntimeStopError(new Error('Content publication requires process-owned quiescence confirmation.'))
    }
    if (this.repository.acquireStopLease !== undefined) {
      if (this.processOwner === undefined || this.repository.releaseStopLease === undefined) {
        throw new RuntimeStopError(new Error('Distributed destructive operations require Gateway process ownership'))
      }
      let entered = false
      return this.processOwner.withOwnership(async owner => {
        entered = true
        const operationId = randomUUID() as RuntimeStopOperationId
        let lease: RuntimeStopLease
        try {
          await this.initialized
          lease = await this.repository.acquireStopLease!(targetOf(target), operationId, owner, actorUserId, expectedGeneration, purpose)
        }
        catch (error) {
          if (error instanceof CollaborationDeniedError || error instanceof RuntimeGenerationConflictError) throw error
          throw new RuntimeStopError(error)
        }
        let outcome: { kind: 'success'; value: T } | { kind: 'failure'; error: unknown }
        try { outcome = { kind: 'success', value: await this.withStoppedOperation({ ...targetOf(target), runtimeId: lease.runtimeId }, operation, lease,
          undefined, () => this.repository.confirmStopLease?.(operationId, owner)) } }
        catch (error) { outcome = { kind: 'failure', error } }
        try { await this.repository.releaseStopLease!(operationId, owner) }
        catch (error) {
          if (outcome.kind === 'failure') throw new AggregateError([outcome.error, error], 'Destructive work and operation release failed')
          throw new RuntimeStopError(error)
        }
        if (outcome.kind === 'failure') throw outcome.error
        return outcome.value
      }).catch((error: unknown) => {
        if (!entered) throw new RuntimeStopError(error)
        throw error
      })
    }
    let stoppedBeforeAdmission: number | undefined
    if (actorUserId !== undefined || expectedGeneration !== undefined) {
      try {
        await this.initialized
        const generation = await this.repository.generationOf(targetOf(target))
        if (expectedGeneration !== undefined && generation !== expectedGeneration) throw new RuntimeGenerationConflictError()
        if (await this.repository.stateOf(targetOf(target)) === 'stopped') stoppedBeforeAdmission = generation
        if (!await this.repository.markStopping(targetOf(target), generation, 'manual', actorUserId)) {
          throw new RuntimeStartBlockedError('unavailable', 'The Runtime generation changed before termination. Retry the operation.')
        }
      } catch (error) {
        if (error instanceof CollaborationDeniedError || error instanceof RuntimeGenerationConflictError) throw error
        throw new RuntimeStopError(error)
      }
    }
    return this.withStoppedOperation(target, operation, undefined, stoppedBeforeAdmission)
  }

  private async withStoppedOperation<T>(target: RuntimeTargetInput, operation: (lease?: RuntimeStopLease) => Promise<T>, lease?: RuntimeStopLease,
    stoppedBeforeAdmission?: number, confirm?: () => void | Promise<void>): Promise<T> {
    this.cancelStarts(target)
    return this.dispatch(target, resolved => this.serialize(resolved, async () => {
      let generation: number | undefined
      try { generation = await this.terminate(resolved, 'manual', lease?.generation, true,
        lease?.wasStopped === true ? lease.generation : stoppedBeforeAdmission) }
      catch (error) {
        if (error instanceof CollaborationDeniedError) throw error
        throw new RuntimeStopError(error)
      }
      if (generation === undefined) throw new RuntimeStopError(new Error('Runtime generation changed before destructive work'))
      await confirm?.()
      let outcome: { kind: 'success'; value: T } | { kind: 'failure'; error: unknown }
      try { outcome = { kind: 'success', value: await operation(lease) } }
      catch (error) { outcome = { kind: 'failure', error } }
      try {
        await this.repository.markStopped(resolved, generation, 'manual')
        await this.resources?.stopped(resolved, generation)
      }
      catch (error) {
        if (outcome.kind === 'failure') throw new AggregateError([outcome.error, error], 'Destructive work and stopped-state publication failed')
        throw new RuntimeStopError(error)
      }
      if (outcome.kind === 'failure') throw outcome.error
      return outcome.value
    }), true)
  }

  /**
   * Terminate via the tracked handle, or re-attach first for an instance a
   * previous gateway process started (systemd survivors). Assumes the caller
   * holds the per-user op slot.
   */
  private async terminate(
    target: RuntimeTarget, reason: RuntimeStopReason, expectedGeneration?: number, holdStopping = false, stoppedBeforeAdmission?: number, administratorUserId?: number,
    idleCutoff?: number,
  ): Promise<number | undefined> {
    await this.initialized
    const key = targetKey(target)
    let proc = this.procs.get(key)
    const generation = expectedGeneration ?? await this.repository.generationOf(target)
    if (proc !== undefined && this.procGenerations.get(proc) === undefined) throw new Error(`Runtime ${key} has no confirmed process generation`)
    if (proc !== undefined && this.procGenerations.get(proc) !== generation) {
      if (expectedGeneration !== undefined) return
      if (administratorUserId !== undefined) await this.repository.authorizeAdministrator(administratorUserId)
      await proc.terminate(STOP_GRACE_MS)
      await this.reclaimResources(target, proc)
      this.forgetReferences(target, this.procGenerations.get(proc)!, false)
      if (this.procs.get(key) === proc) this.procs.delete(key)
      proc = undefined
    }
    const recover = proc === undefined && this.launcher.attach !== undefined
      && (this.residentLeases.has(key) || (await this.repository.stateOf(target) !== 'stopped' && stoppedBeforeAdmission !== generation))
    const credentialHash = recover
      ? await this.repository.credentialHashOf(target, generation) : null
    const current = reason === 'idle'
      ? idleCutoff !== undefined && await this.repository.markIdleStopping?.(target, generation, idleCutoff) === true
      : administratorUserId === undefined ? await this.repository.markStopping(target, generation, reason)
        : await this.repository.markControlStopping(target, generation, reason, administratorUserId)
    if (!current && reason === 'idle') return undefined
    if (!current && expectedGeneration === undefined) {
      throw new RuntimeStartBlockedError('unavailable', 'The Runtime generation changed before termination. Retry the operation.')
    }
    if (!current && proc === undefined) return
    if (recover) {
      proc = await this.attachSurvivor(target, generation, credentialHash)
      if (proc !== undefined && !this.procs.has(key)) this.procs.set(key, proc)
    }
    if (proc === undefined && this.residentLeases.has(key)) {
      throw new Error(`Runtime ${key} termination cannot be confirmed`)
    }
    if (proc !== undefined) {
      await proc.terminate(STOP_GRACE_MS)
    }
    await this.resources?.stopped(target, generation, 'retain')
    const published = current && (holdStopping || await this.repository.markStopped(target, generation))
    if (!holdStopping) await this.resources?.stopped(target, generation)
    if (this.procs.get(key) === proc || !this.procs.has(key)) {
      this.procs.delete(key)
      this.releaseResident(key)
    }
    this.forgetReferences(target, generation, published)
    return generation
  }

  private forgetReferences(target: RuntimeTarget, generation: number, includeUnversioned: boolean): void {
    for (const [references, totals] of [[this.wsRefs, this.wsTotals], [this.operationRefs, this.operationTotals]] as const) {
      for (const key of [...(includeUnversioned ? [targetKey(target)] : []), leaseKey(target, generation)]) {
        this.adjustLeaseTotal(totals, target, -(references.get(key) ?? 0))
        references.delete(key)
      }
    }
  }

  /** Reclaim the generation owned by this handle, never a newer database generation. */
  private async reclaimResources(target: RuntimeTarget, proc: InstanceProc): Promise<void> {
    if (this.resources === undefined) return
    const generation = this.procGenerations.get(proc)
    if (generation === undefined) throw new Error(`Runtime ${targetKey(target)} has no confirmed accounting generation`)
    await this.resources.stopped(target, generation)
  }

  /** Deny new work before freeing credits, then wake queues again after the stopped row commits. */
  private async publishQuiescence(target: RuntimeTarget, generation: number, reason: RuntimeStopReason): Promise<void> {
    await this.repository.markStopping(target, generation, reason)
    await this.resources?.stopped(target, generation, 'retain')
    await this.repository.markStopped(target, generation, reason)
    await this.resources?.stopped(target, generation)
  }

  /**
   * Rebuild the process identity of a supervisor-owned unit this Gateway did
   * not launch. Read-only against the instance row: no state transition,
   * credential rotation, or policy/profile write happens here.
   */
  private async attachSurvivor(target: RuntimeTarget, generation: number, credentialHash: string | null): Promise<InstanceProc | undefined> {
    const row = await this.repository.owner(target)
    if (row === null) return undefined
    const layout = row.kind === 'user' ? personalRuntimeLayout(this.cfg, { ...row, runtimeId: target.runtimeId }) : undefined
    const runtimeKey = layout?.runtimeKey ?? `project-${String(row.id)}`
    const steward = row.projectKind === 'steward' && this.cfg.steward.enabled
    const proc = this.launcher.attach!({
      generation,
      credentialHash,
      kind: row.kind,
      ownerId: row.id,
      username: row.username,
      runtimeKey,
      systemUser: row.kind === 'user' ? `harness-${row.username}`
        : steward ? this.cfg.steward.runtimeUser : this.cfg.projectRuntimeUser,
      privileged: steward,
      resident: steward,
      port: await this.portOf(target),
      homePath: row.homePath,
      dshHome: layout?.dshHome ?? join(this.cfg.projectRuntimesRoot, String(row.id), 'dsh'),
    })
    this.procGenerations.set(proc, generation)
    return proc
  }

  /** Apply one generation's lease delta to the O(1) runtime aggregate. */
  private adjustLeaseTotal(
    totals: Map<string, number>,
    target: RuntimeTarget,
    delta: number,
  ): void {
    if (delta === 0) return
    const key = targetKey(target)
    const next = Math.max(0, (totals.get(key) ?? 0) + delta)
    if (next === 0) totals.delete(key)
    else totals.set(key, next)
  }

  /**
   * Refuse new starts and cancel pending admission before the Gateway drains accepted writers.
   * Existing Runtime processes remain available until {@link stopAll} joins and stops them.
   */
  beginShutdown(): void {
    if (this.closedStartRequest !== undefined) return
    const refused = Promise.reject<never>(new RuntimeCapacityError('closed'))
    void refused.catch((_closedStartRefusal: unknown) => {
      // Shutdown owns this refusal even when no subsequent caller observes either result.
    })
    this.closedStartRequest = { admission: refused, completion: refused }
    this.capacity.close()
    for (const controllers of this.startControllers.values()) for (const controller of controllers) controller.abort()
  }

  /**
   * Terminate every adopted or tracked supervisor-owned target on this node.
   * Boot calls this to retire survivors whose recorded launch signature no
   * longer matches the running build; their next entry cold-starts current code.
   * @param reason - durable stop reason published for each drained target.
   * @returns completion after every target settled; rejects with the first failure.
   */
  async drainSurvivors(reason: RuntimeStopReason = 'shutdown'): Promise<void> {
    await this.initialized
    const targets = [...new Set([...this.procs.keys(), ...this.residentLeases.keys()])].map(key => targetFromKey(key))
    const failures = await this.drainTargets(targets, reason)
    if (failures.length > 0) throw failures[0]
  }

  /** Stop each target with bounded concurrency, collecting per-target failures. */
  private async drainTargets(targets: RuntimeTarget[], reason: RuntimeStopReason): Promise<unknown[]> {
    let cursor = 0
    const worker = async (): Promise<unknown[]> => {
      const errors: unknown[] = []
      for (;;) {
        const index = cursor
        cursor += 1
        const target = targets[index]
        if (target === undefined) break
        try {
          await this.stop(target, reason)
        } catch (error) {
          errors.push(error)
        }
      }
      return errors
    }
    const results = await Promise.all(Array.from(
      { length: Math.min(STOP_ALL_CONCURRENCY, targets.length) },
      () => worker(),
    ))
    return results.flat()
  }

  /**
   * Drain tracked and recovered local runtimes despite individual failures; retain configured supervisor units.
   * @param retainLocalSurvivors - skip terminating local-launcher survivors; graceful shutdown retains them for next-boot reattachment.
   * @returns completion after all workers settle; rejects with the first failed worker's original error
   */
  async stopAll(retainLocalSurvivors = false): Promise<void> {
    this.beginShutdown()
    await this.initialized
    await Promise.allSettled([...this.pendingStarts.values()].map(operation => operation.completion))
    // Graceful shutdown terminates locally owned children unless retention is
    // configured; supervisor units retain their independent lifecycle across a
    // Gateway restart regardless.
    if (this.launcher.instancesOutliveGateway || retainLocalSurvivors) return
    const targets = [...new Set([...this.procs.keys(), ...this.residentLeases.keys()])].map(key => targetFromKey(key))
    const failures = await this.drainTargets(targets, 'shutdown')
    if (failures.length > 0) throw failures[0]
  }
}
