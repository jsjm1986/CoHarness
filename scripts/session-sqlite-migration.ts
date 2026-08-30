/** Offline, lossless migration helpers for Session SQLite schema 18 and 20. */

import { createHash } from 'node:crypto'
import { chmodSync, fsyncSync, openSync, closeSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdDecompressSync } from 'node:zlib'
import { decodeStorageRecord, packChunkRuns, type SessionEvent } from '@deepseek-ai/dsh-session'
import { decodeRow, bindRecord } from '../packages/session/session-persistence-sqlite/src/compression.ts'
import type { StorageRecord as SqliteStorageRecord } from '../packages/session/session-persistence-sqlite/src/codec.ts'
import { sql } from '../packages/session/session-persistence-sqlite/src/sql.ts'
import {
  SESSION_PERSISTENCE_SQLITE_APPLICATION_ID,
  decodeEventRow,
  decodeSessionRow,
  rowToMeta,
} from '../packages/session/session-persistence-sqlite/src/schema.ts'

/** One logical session extracted from either physical schema. */
export interface LogicalSession {
  readonly header: ReturnType<typeof rowToMeta>
  readonly events: readonly SessionEvent[]
  readonly storeId: string
  readonly incarnation: string
  readonly revision: number
}

/** Migration options shared by both directions. */
export interface MigrationOptions {
  readonly input: string
  readonly output?: string
  readonly verifyOnly?: boolean
  readonly keepBackup?: boolean
  readonly replace?: boolean
}

const V18_SCHEMA = `
CREATE TABLE persistence_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id TEXT NOT NULL
) STRICT;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  cwd TEXT,
  parent_session TEXT,
  seed_length INTEGER,
  origin TEXT,
  delegation_depth INTEGER,
  agent_preset TEXT,
  draft INTEGER NOT NULL DEFAULT 0 CHECK (draft IN (0, 1)),
  incarnation TEXT NOT NULL,
  revision INTEGER NOT NULL
) STRICT;
CREATE TABLE events (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  time INTEGER NOT NULL,
  data ANY NOT NULL,
  source_event_seqs ANY,
  surface_op TEXT,
  ignorable INTEGER CHECK (ignorable IS NULL OR ignorable IN (0, 1)),
  PRIMARY KEY (session_id, seq)
) STRICT;`

/** Read and validate every logical event from a schema-18 file. */
export function readV18(path: string): LogicalSession[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    assertIdentity(db, 18, path)
    assertTableColumns(db, {
      persistence_state: ['singleton', 'store_id'],
      sessions: ['id', 'version', 'created_at', 'cwd', 'parent_session', 'seed_length', 'origin', 'delegation_depth', 'agent_preset', 'draft', 'incarnation', 'revision'],
      events: ['session_id', 'seq', 'type', 'time', 'data', 'source_event_seqs', 'surface_op', 'ignorable'],
    }, path)
    const storeId = readStoreId(db)
    const sessions = db.prepare(`
      SELECT id, version, created_at, cwd, parent_session, seed_length, origin,
             delegation_depth, agent_preset, draft, incarnation, revision
      FROM sessions ORDER BY rowid`).all()
    return sessions.map((value) => {
      const row = decodeSessionRow(value)
      const physical = db.prepare(`
        SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable
        FROM events WHERE session_id = ? ORDER BY seq`).all(row.id)
      const events = physical.flatMap(item => decodeV18Row(item, row.id))
      assertContiguous(events, row.id)
      return { header: rowToMeta(row), events, storeId, incarnation: row.incarnation, revision: row.revision }
    })
  } finally {
    db.close()
  }
}

/** Read and validate every logical event from a schema-20 file. */
export function readV20(path: string): LogicalSession[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    assertIdentity(db, 20, path)
    assertTableColumns(db, {
      persistence_state: ['singleton', 'store_id'],
      sessions: ['id', 'session_key', 'version', 'created_at', 'cwd', 'parent_session', 'seed_length', 'origin', 'delegation_depth', 'agent_preset', 'incarnation', 'revision'],
      events: ['session_id', 'seq', 'type', 'time', 'data', 'source_event_seqs', 'surface_op', 'is_packed'],
      session_extensions: ['session_id', 'draft'],
      event_extensions: ['session_id', 'seq', 'ignorable'],
    }, path)
    const storeId = readStoreId(db)
    const sessions = db.prepare(`
      SELECT s.session_key AS id, s.version, s.created_at, s.cwd, s.parent_session,
             s.seed_length, s.origin, s.delegation_depth, s.agent_preset,
             COALESCE(x.draft, 0) AS draft, s.incarnation, s.revision
      FROM sessions AS s LEFT JOIN session_extensions AS x ON x.session_id = s.id
      ORDER BY s.id`).all()
    return sessions.map((value) => {
      const row = decodeSessionRow(value)
      const physical = db.prepare(`
        SELECT e.seq, e.type, e.time, e.data, e.source_event_seqs, e.surface_op,
               e.is_packed, x.ignorable
        FROM events AS e JOIN sessions AS s ON s.id = e.session_id
        LEFT JOIN event_extensions AS x ON x.session_id = e.session_id AND x.seq = e.seq
        WHERE s.session_key = ? ORDER BY e.seq`).all(row.id)
      const events = physical.flatMap(item => decodeRow(decodeEventRow(item)))
      assertContiguous(events, row.id)
      return { header: rowToMeta(row), events, storeId, incarnation: row.incarnation, revision: row.revision }
    })
  } finally {
    db.close()
  }
}

/** Migrate schema 18 to schema 20 into a new file, or verify only. */
export async function migrateV18ToV20(options: MigrationOptions): Promise<void> {
  const input = resolve(options.input)
  const sessions = readV18(input)
  const storeId = sourceStoreId(input)
  reportHashes(sessions, 'v18')
  if (options.verifyOnly) return
  const output = outputPath(options, input)
  try {
    writeV20(output, sessions, storeId)
    verifyEquivalent(sessions, readV20(output), 'v18→v20')
    await finalizeOutput(output)
  } catch (error) {
    await removePartialOutput(output)
    throw error
  }
  maybeReplace(options, input, output)
}

/** Migrate schema 20 to schema 18 into a new file, or verify only. */
export async function migrateV20ToV18(options: MigrationOptions): Promise<void> {
  const input = resolve(options.input)
  const sessions = readV20(input)
  const storeId = sourceStoreId(input)
  reportHashes(sessions, 'v20')
  if (options.verifyOnly) return
  const output = outputPath(options, input)
  try {
    writeV18(output, sessions, storeId)
    verifyEquivalent(sessions, readV18(output), 'v20→v18')
    await finalizeOutput(output)
  } catch (error) {
    await removePartialOutput(output)
    throw error
  }
  maybeReplace(options, input, output)
}

function outputPath(options: MigrationOptions, input: string): string {
  if (options.output === undefined || options.output.trim().length === 0) {
    throw new Error('migration requires --output unless --verify-only is used')
  }
  const output = resolve(options.output)
  if (output === input) throw new Error('migration output must differ from input')
  if (existsSync(output)) throw new Error(`migration output already exists: ${output}`)
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
  return output
}

function assertIdentity(db: DatabaseSync, version: number, path: string): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown }
  if (row.user_version !== version) {
    throw new Error(`session database at "${path}" has schema version ${String(row.user_version)}, expected ${version}`)
  }
  const identity = db.prepare('PRAGMA application_id').get() as { application_id?: unknown }
  if (identity.application_id !== SESSION_PERSISTENCE_SQLITE_APPLICATION_ID) {
    throw new Error(`session database at "${path}" has application id ${String(identity.application_id)}, expected ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`)
  }
}

function readStoreId(db: DatabaseSync): string {
  const value = db.prepare('SELECT store_id FROM persistence_state WHERE singleton = 1').get() as { store_id?: unknown } | undefined
  if (typeof value?.store_id !== 'string' || value.store_id.length === 0) throw new Error('session database has no valid store identity')
  if (!UUID.test(value.store_id)) throw new Error('session database has no valid store identity')
  return value.store_id
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function assertTableColumns(
  db: DatabaseSync,
  expected: Readonly<Record<string, readonly string[]>>,
  path: string,
): void {
  for (const [table, columns] of Object.entries(expected)) {
    const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name?: unknown }>
    const actual = rows.map(row => row.name).filter((name): name is string => typeof name === 'string')
    if (actual.length !== columns.length || columns.some(column => !actual.includes(column))) {
      throw new Error(`session database at "${path}" has incompatible ${table} columns`)
    }
  }
}

async function removePartialOutput(path: string): Promise<void> {
  try { await unlink(path) } catch (error: unknown) {
    if (typeof error !== 'object' || error === null || Reflect.get(error, 'code') !== 'ENOENT') throw error
  }
}

function sourceStoreId(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return readStoreId(db) } finally { db.close() }
}

function decodeV18Row(value: unknown, sessionId: string): SessionEvent[] {
  const row = value as Record<string, unknown>
  const data = row.data
  const serialized = typeof data === 'string'
    ? data
    : data instanceof Uint8Array
      ? decodeLegacyData(data)
      : undefined
  if (serialized === undefined) throw new Error(`session ${sessionId} contains a non-text event payload`)
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch (error) {
    throw new Error(`session ${sessionId} contains invalid event JSON`, { cause: error })
  }
  const ignorable = row.ignorable
  if (ignorable === 0) {
    const records = decodeStorageRecord(parsed)
    return records
  }
  const event = parsed as Record<string, unknown>
  const source = row.source_event_seqs === null || row.source_event_seqs === undefined
    ? undefined
    : decodeLegacySource(row.source_event_seqs)
  return [{
    type: row.type as SessionEvent['type'],
    seq: row.seq as number,
    time: row.time as number,
    data: event,
    ...source === undefined ? {} : { sourceEventSeqs: source },
    ...surfaceOperation(row.surface_op),
    ...ignorable === 1 ? { ignorable: true as const } : {},
  } as SessionEvent]
}

function surfaceOperation(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {}
  if (typeof value !== 'string') throw new Error('legacy surface_op must be text or null')
  return { surfaceOp: JSON.parse(value) as unknown }
}

function decodeLegacyData(data: Uint8Array): string {
  try {
    return zstdDecompressSync(data).toString('utf8')
  } catch {
    // A v18 fixture may contain a plain blob; retain a useful parse error below.
    return Buffer.from(data).toString('utf8')
  }
}

function decodeLegacySource(value: unknown): number[] {
  if (!(value instanceof Uint8Array)) throw new Error('legacy source_event_seqs must be a blob')
  const result: number[] = []
  let previous = 0n
  let offset = 0
  while (offset < value.length) {
    let current = 0n
    let shift = 0n
    for (;;) {
      if (offset >= value.length) throw new Error('legacy source_event_seqs has a truncated varint')
      const byte = value[offset++] as number
      current |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) break
      shift += 7n
      if (shift > 56n) throw new Error('legacy source_event_seqs varint is too large')
    }
    const delta = result.length === 0
      ? current
      : (current & 1n) === 0n ? current / 2n : -((current + 1n) / 2n)
    const next = result.length === 0 ? delta : previous + delta
    if (next < 0n || next > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('legacy source_event_seqs value is out of range')
    result.push(Number(next))
    previous = next
  }
  return result
}

function assertContiguous(events: readonly SessionEvent[], sessionId: string): void {
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.seq !== index) throw new Error(`session ${sessionId} has a non-contiguous event sequence at ${String(events[index]?.seq)}`)
  }
}

function writeV20(path: string, sessions: readonly LogicalSession[], storeId: string): void {
  const db = createDatabase(path, 20, sql('schema'))
  try {
    db.prepare('INSERT INTO persistence_state (singleton, store_id) VALUES (1, ?)').run(storeId)
    const insertSession = db.prepare(`
      INSERT INTO sessions (session_key, version, created_at, cwd, parent_session, seed_length,
        origin, delegation_depth, agent_preset, incarnation, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const insertDraft = db.prepare(`
      INSERT INTO session_extensions (session_id, draft)
      SELECT id, ? FROM sessions WHERE session_key = ?`)
    const insertEvent = db.prepare(`
      INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, is_packed)
      SELECT id, ?, ?, ?, ?, ?, ?, ? FROM sessions WHERE session_key = ?`)
    const insertIgnorable = db.prepare(`
      INSERT INTO event_extensions (session_id, seq, ignorable)
      SELECT id, ?, 1 FROM sessions WHERE session_key = ?`)
    db.exec('BEGIN IMMEDIATE')
    for (const session of sessions) {
      const header = session.header
      insertSession.run(header.id, header.version, header.createdAt, header.cwd ?? null,
        header.parentSession ?? null, header.seedLength ?? null, header.origin ?? null,
        header.delegationDepth ?? null, header.agentPreset ?? null,
        session.incarnation, session.revision)
      insertDraft.run(header.draft === true ? 1 : 0, header.id)
      for (const record of packChunkRuns(session.events) as unknown as SqliteStorageRecord[]) {
        const bound = bindRecord(record)
        insertEvent.run(bound.seq, bound.type, bound.time, bound.data, bound.sourceEventSeqs,
          bound.surfaceOp, bound.isPacked, header.id)
        if (bound.ignorable === 1) insertIgnorable.run(bound.seq, header.id)
      }
    }
    db.exec('COMMIT')
    db.close()
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve the migration failure */ }
    db.close()
    throw error
  }
}

function writeV18(path: string, sessions: readonly LogicalSession[], storeId: string): void {
  const db = createDatabase(path, 18, V18_SCHEMA)
  try {
    db.prepare('INSERT INTO persistence_state (singleton, store_id) VALUES (1, ?)').run(storeId)
    const insertSession = db.prepare(`
      INSERT INTO sessions (id, version, created_at, cwd, parent_session, seed_length,
        origin, delegation_depth, agent_preset, draft, incarnation, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const insertEvent = db.prepare(`
      INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    db.exec('BEGIN IMMEDIATE')
    for (const session of sessions) {
      const header = session.header
      insertSession.run(header.id, header.version, header.createdAt, header.cwd ?? null,
        header.parentSession ?? null, header.seedLength ?? null, header.origin ?? null,
        header.delegationDepth ?? null, header.agentPreset ?? null, header.draft === true ? 1 : 0,
        session.incarnation, session.revision)
      for (const event of session.events) {
        const sourceEventSeqs = sourceSequences(event)
        insertEvent.run(header.id, event.seq, event.type, event.time, JSON.stringify(event.data),
          sourceEventSeqs === undefined ? null : encodeLegacySource(sourceEventSeqs),
          eventSurfaceOperation(event),
          event.ignorable === true ? 1 : null)
      }
    }
    db.exec('COMMIT')
    db.close()
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve the migration failure */ }
    db.close()
    throw error
  }
}

function sourceSequences(event: SessionEvent): readonly number[] | undefined {
  const value = (event as unknown as { sourceEventSeqs?: unknown }).sourceEventSeqs
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => !Number.isSafeInteger(item) || item < 0)) {
    throw new Error(`event ${String(event.seq)} has invalid sourceEventSeqs`)
  }
  return value.map(item => item as number)
}

function eventSurfaceOperation(event: SessionEvent): string | null {
  const value = (event as unknown as { surfaceOp?: unknown }).surfaceOp
  return value === undefined ? null : JSON.stringify(value)
}

function createDatabase(path: string, version: number, schema: string): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;')
    if (version === 20) db.exec('PRAGMA page_size = 65536')
    db.exec(`PRAGMA application_id = ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`)
    db.exec(schema)
    db.exec(`PRAGMA user_version = ${version}`)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function encodeLegacySource(values: readonly number[]): Uint8Array {
  const bytes: number[] = []
  let previous = 0n
  for (let index = 0; index < values.length; index += 1) {
    const current = BigInt(values[index] as number)
    const encoded = index === 0 ? current : current >= previous ? (current - previous) * 2n : (previous - current) * 2n - 1n
    let rest = encoded
    while (rest >= 0x80n) { bytes.push(Number(rest & 0x7fn) | 0x80); rest >>= 7n }
    bytes.push(Number(rest))
    previous = current
  }
  return Uint8Array.from(bytes)
}

function reportHashes(sessions: readonly LogicalSession[], label: string): void {
  for (const session of sessions) {
    process.stdout.write(`${label} ${session.header.id} ${hashSession(session)}\n`)
  }
}

function hashSession(session: LogicalSession): string {
  return createHash('sha256').update(JSON.stringify({
    header: session.header,
    events: session.events,
    storeId: session.storeId,
    incarnation: session.incarnation,
    revision: session.revision,
  })).digest('hex')
}

function verifyEquivalent(expected: readonly LogicalSession[], actual: readonly LogicalSession[], direction: string): void {
  if (expected.length !== actual.length) throw new Error(`${direction} changed the session count`)
  for (let index = 0; index < expected.length; index += 1) {
    if (hashSession(expected[index] as LogicalSession) !== hashSession(actual[index] as LogicalSession)) {
      throw new Error(`${direction} changed logical events for session ${expected[index]?.header.id}`)
    }
  }
}

async function finalizeOutput(path: string): Promise<void> {
  const handle = openSync(path, 'r')
  try { fsyncSync(handle) } finally { closeSync(handle) }
  chmodSync(path, 0o600)
  const parent = openSync(dirname(path), 'r')
  try { fsyncSync(parent) } finally { closeSync(parent) }
  const info = await stat(path)
  if (info.size === 0) throw new Error(`migration output is empty: ${path}`)
}

function maybeReplace(options: MigrationOptions, input: string, output: string): void {
  if (!options.replace) return
  const backup = `${input}.v18-backup`
  if (!options.keepBackup) throw new Error('--replace requires --keep-backup')
  if (existsSync(backup)) throw new Error(`backup already exists: ${backup}`)
  renameSync(input, backup)
  try {
    renameSync(output, input)
  } catch (error) {
    renameSync(backup, input)
    throw error
  }
}

/** Parse the small, explicit CLI shared by migration entry points. */
function parseMigrationArgs(argv: readonly string[]): MigrationOptions {
  let input: string | undefined
  let output: string | undefined
  let verifyOnly = false
  let keepBackup = false
  let replace = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--verify-only') verifyOnly = true
    else if (arg === '--keep-backup') keepBackup = true
    else if (arg === '--replace') replace = true
    else if (arg === '--input' || arg === '--output') {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a path`)
      if (arg === '--input') input = value
      else output = value
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: --input FILE [--output FILE] [--verify-only] [--replace --keep-backup]\n')
      process.exit(0)
    } else throw new Error(`unknown migration option: ${arg}`)
  }
  if (input === undefined) throw new Error('migration requires --input')
  return {
    input,
    ...output === undefined ? {} : { output },
    verifyOnly,
    keepBackup,
    replace,
  }
}

/** Execute one migration CLI and convert failures into a non-zero exit. */
export async function runMigration(main: (options: MigrationOptions) => Promise<void>): Promise<void> {
  try {
    await main(parseMigrationArgs(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`migration failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
