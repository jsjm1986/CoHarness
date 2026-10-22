/**
 * One opened JSON unit in `per-record` layout: the unit is a directory at
 * `dir`, holding one document per record under `<dir>/<table>/<key>.json`
 * plus `global.json` for the global slot. The directory is the state — this
 * unit holds NO in-memory state of its own: `loadAll` re-reads the tree and
 * every write is one durable file operation. The domain layer owns the live
 * in-memory tables (seeded by the open-time `loadAll`) and serializes writes
 * through its write chain, so this unit never mutates memory and needs no
 * rollback — a failed write simply leaves both the file and the domain's
 * memory unchanged.
 *
 * Per-record contract: a record document that is malformed or stamped with a
 * version outside the accepted set (the descriptor's current version plus
 * its `compatibleVersions`) reads as an absent record — one bad or stale
 * file never bricks the whole unit, and an unaccepted version stamp discards
 * the record instead of migrating it. Record keys become path segments, so
 * they must be path-safe (`[a-zA-Z0-9_-]+`); an unsafe key rejects at write.
 *
 * Legacy bootstrap: when the new tree has no document path, a legacy
 * whole-unit file `<root>/<name>.json` (the pre-per-record layout) seeds
 * per-record documents, provided its stored unit version is in the accepted
 * set — a legacy file stamped with any other version is left alone and reads
 * as the empty unit. Without migration metadata, any new document path,
 * including an unreadable or stale one, suppresses legacy import. The
 * legacy file is never changed or deleted. A durable bootstrap marker retains
 * the admitted source until every document is copied, then records completion;
 * interrupted migration resumes before loadAll exposes its state.
 * @module @deepseek-ai/dsh-storage-json/src/per-record-unit
 */

import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Dirent } from 'node:fs'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { writeAtomic } from './atomic.ts'
import { parseRecord, serializeRecord } from './format.ts'
import type { UnitState } from './format.ts'

/** Keys become path segments in this layout; this set is path-safe on every OS. */
const SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/
const BOOTSTRAP_FILE = '.legacy-bootstrap.json'

type BootstrapState = { version: 1; status: 'copying'; source: string } | { version: 1; status: 'complete' }

/**
 * Open one `per-record`-layout unit under `root`: the unit directory is
 * `<root>/<name>/`. Loads lazily on the first `loadAll` — this unit holds no
 * state, so opening touches nothing on the medium.
 * @param descriptor - Static identity and shape of the unit.
 * @param root - Absolute backend root directory.
 * @param onClose - Backend callback releasing the unit's open-slot.
 * @returns the opened unit.
 */
// oxlint-disable-next-line typescript/require-await -- async keeps both openers' call sites uniform
export async function openPerRecordUnit(
  descriptor: KvUnitDescriptor,
  root: string,
  onClose: () => void,
): Promise<KvUnit> {
  return new PerRecordJsonUnit(descriptor, join(root, descriptor.name), onClose)
}

/**
 * Read every record document under the unit directory: each declared table's
 * `<key>.json` files plus `global.json`. A missing directory is the empty
 * unit (materialization defers to the first write); a foreign document
 * (missing, malformed, or stamped with an unaccepted version) reads as an absent
 * record, per the per-record contract.
 * @param descriptor - Static identity and shape of the unit.
 * @param dir - Absolute unit directory path.
 * @returns the authoritative state reconstructed from the tree.
 */
async function loadPerRecordState(descriptor: KvUnitDescriptor, dir: string): Promise<UnitState> {
  const bootstrap = await readBootstrap(dir)
  const versions = acceptedStamps(descriptor)
  const state: UnitState = {
    version: descriptor.version,
    global: null,
    tables: new Map(descriptor.tables.map(table => [table, new Map<string, unknown>()])),
  }
  let entries: Dirent[] | undefined
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Missing directory = empty unit; the legacy bootstrap below still runs
    // (the fresh-upgrade shape is exactly an absent new tree).
  }
  const hasNewDocuments = entries === undefined
    ? false
    : (await Promise.all(entries.map(async (entry) => {
      if (entry.isDirectory()) {
        const records = state.tables.get(entry.name)
        if (records !== undefined) {
          return loadTableRecords(records, versions, join(dir, entry.name))
        }
      }
      if (entry.name === 'global.json' && descriptor.hasGlobal) {
        const global = await readRecord(join(dir, entry.name), versions)
        if (global !== undefined) state.global = global
        return true
      }
      return false
    }))).some(Boolean)
  if (bootstrap?.status === 'copying' || (bootstrap === undefined && !hasNewDocuments)) {
    await bootstrapLegacyUnit(descriptor, dir, state, bootstrap)
  }
  return state
}

/** The version stamps this unit reads as its own: current plus declared compatible versions. */
function acceptedStamps(descriptor: KvUnitDescriptor): readonly number[] {
  return [descriptor.version, ...descriptor.compatibleVersions ?? []]
}

/**
 * Bootstrap an empty per-record tree from a legacy whole-unit file
 * (`<root>/<name>.json`, the pre-per-record layout). Every declared-table
 * record is copied into a current-version document, while the legacy file is
 * retained unchanged. A missing, foreign (another unit's name), malformed,
 * or non-unit legacy file is left alone, and so is one whose stored unit
 * version is outside the accepted set — migrating records the owner never
 * vouched for would stamp them with the current version and turn a
 * discardable stale cache into schema failures at the domain layer. Other
 * read failures propagate.
 * @param descriptor - Static identity and shape of the unit.
 * @param dir - The per-record unit directory (`<root>/<name>`).
 * @param state - Reconstructed tree state; resumed records replace their partial copies.
 * @param pending - Durable source admitted by an interrupted migration, when present.
 */
async function bootstrapLegacyUnit(
  descriptor: KvUnitDescriptor, dir: string, state: UnitState, pending?: BootstrapState,
): Promise<void> {
  const legacyPath = join(dirname(dir), `${descriptor.name}.json`)
  let text = pending?.status === 'copying' ? pending.source : undefined
  if (text === undefined) {
    try {
      text = await readFile(legacyPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return
    }
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    if (pending !== undefined) throw new StorageError('malformed-medium', `unit '${descriptor.name}': invalid bootstrap source`)
    return
  }
  const decoded = decodeLegacy(descriptor, document)
  if (decoded === undefined) {
    if (pending !== undefined) throw new StorageError('malformed-medium', `unit '${descriptor.name}': invalid bootstrap source`)
    return
  }
  const { recordsByTable, global } = decoded
  // The durable source snapshot owns retries; a partial tree is never mistaken for a completed migration.
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const marker = join(dir, BOOTSTRAP_FILE)
  if (pending === undefined) {
    await writeAtomic(marker, `${JSON.stringify({ version: 1, status: 'copying', source: text })}\n`)
  }
  for (const [table, records] of recordsByTable) {
    for (const [key, value] of records) {
      const path = join(dir, table, `${key}.json`)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeAtomic(path, serializeRecord(descriptor.version, value))
      state.tables.get(table)?.set(key, value)
    }
  }
  if (descriptor.hasGlobal && global !== undefined && global !== null) {
    await writeAtomic(join(dir, 'global.json'), serializeRecord(descriptor.version, global))
    state.global = global
  }
  // Retain completion durably: deleting all migrated records must not resurrect the legacy snapshot.
  await writeAtomic(marker, `${JSON.stringify({ version: 1, status: 'complete' })}\n`)
}

/** Validate the complete legacy tree before admitting its migration snapshot. */
function decodeLegacy(
  descriptor: KvUnitDescriptor, document: unknown,
): { recordsByTable: Map<string, [string, unknown][]>; global: unknown } | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return
  const { unit, tables, global } = document as Record<string, unknown>
  if (typeof unit !== 'object' || unit === null || Array.isArray(unit)) return
  const header = unit as Record<string, unknown>
  if (header.name !== descriptor.name || typeof header.version !== 'number'
    || !acceptedStamps(descriptor).includes(header.version)) return
  if (typeof tables !== 'object' || tables === null || Array.isArray(tables)) return
  const recordsByTable = new Map<string, [string, unknown][]>()
  for (const table of descriptor.tables) {
    const records = (tables as Record<string, unknown>)[table]
    if (records === undefined) continue
    if (typeof records !== 'object' || records === null || Array.isArray(records)) return
    const entries = Object.entries(records)
    for (const [key] of entries) assertSafeKey(descriptor.name, key)
    recordsByTable.set(table, entries)
  }
  return { recordsByTable, global }
}

/** Read migration ownership metadata; corrupt progress must not expose a partial tree. */
async function readBootstrap(dir: string): Promise<BootstrapState | undefined> {
  let text: string
  try {
    text = await readFile(join(dir, BOOTSTRAP_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new StorageError('malformed-medium', 'invalid per-record bootstrap metadata', { cause: error })
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const marker = value as Record<string, unknown>
    if (marker.version === 1 && marker.status === 'complete') return { version: 1, status: 'complete' }
    if (marker.version === 1 && marker.status === 'copying' && typeof marker.source === 'string') {
      return { version: 1, status: 'copying', source: marker.source }
    }
  }
  throw new StorageError('malformed-medium', 'invalid per-record bootstrap metadata')
}

/**
 * Read one declared table's record documents into `records`.
 * @returns whether the directory contains any `.json` document path,
 * independently of key safety, readability, or stored version.
 */
async function loadTableRecords(records: Map<string, unknown>, versions: readonly number[], dir: string): Promise<boolean> {
  const files = await readdir(dir, { withFileTypes: true })
  const hasDocuments = files.some(file => file.name.endsWith('.json'))
  const loaded = await Promise.all(files.map(async (file) => {
    if (!file.name.endsWith('.json')) return
    const key = file.name.slice(0, -'.json'.length)
    if (!SAFE_KEY_RE.test(key)) return
    const record = await readRecord(join(dir, file.name), versions)
    if (record !== undefined) return [key, record] as const
  }))
  for (const record of loaded) {
    if (record !== undefined) records.set(...record)
  }
  return hasDocuments
}

/** Read one record document; a foreign (unreadable or stale) one reads as absent. */
async function readRecord(path: string, versions: readonly number[]): Promise<unknown> {
  try {
    return parseRecord(await readFile(path, 'utf8'), versions)
  } catch {
    return undefined
  }
}

/**
 * One opened `per-record`-layout unit. Stateless by design: the directory is
 * the medium, the domain layer owns the live memory, and each method here is
 * a single durable file operation. Write ordering belongs to the caller (the
 * domain layer's write chain), exactly like the `single`-layout unit.
 */
export class PerRecordJsonUnit implements KvUnit {
  private closed = false
  /** In-flight durable writes; close() drains them before releasing the unit. */
  private readonly inFlight = new Set<Promise<void>>()

  constructor(
    private readonly descriptor: KvUnitDescriptor,
    private readonly dir: string,
    private readonly onClose: () => void,
  ) {}

  /** Re-read the tree: the directory is the authoritative state. */
  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    const state = await loadPerRecordState(this.descriptor, this.dir)
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [table, records] of state.tables) {
      tables[table] = Object.fromEntries(records)
    }
    return { tables, global: state.global }
  }

  /** Durably replace one record: its own document, atomically. */
  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    assertSafeKey(this.descriptor.name, key)
    await this.tracked(this.writeDocument(join(this.tableDir(table), `${key}.json`), value))
  }

  /** Durably delete one record. Idempotent: a missing key is a no-op. */
  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    assertSafeKey(this.descriptor.name, key)
    await this.tracked(rm(join(this.tableDir(table), `${key}.json`), { force: true }))
  }

  /**
   * Move one record's document aside as `<key>.json.bak.<YYYYMMDDHHmm>`. The
   * moved file no longer ends in `.json`, so every later read ignores it; the
   * bytes stay on disk for inspection. A same-minute backup of the same
   * key overwrites the previous backup (the newer bytes are the ones worth
   * keeping).
   */
  async backupRecord(table: string, key: string): Promise<string> {
    this.assertOpen()
    assertSafeKey(this.descriptor.name, key)
    const path = join(this.tableDir(table), `${key}.json`)
    const moved = `${path}.bak.${backupStamp(new Date())}`
    await this.tracked(rename(path, moved))
    return moved
  }

  /** Durably replace the global singleton. Only valid when declared. */
  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
    }
    await this.tracked(this.writeDocument(join(this.dir, 'global.json'), value))
  }

  /* jscpd:ignore-start -- the two unit classes are standalone; the drain/guard lifecycle mirrors the shared KvUnit contract */
  /** Drain in-flight writes and release the unit. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) {
      await Promise.allSettled(this.inFlight)
      return
    }
    this.closed = true
    await Promise.allSettled(this.inFlight)
    this.onClose()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`)
    }
  }
  /* jscpd:ignore-end */

  /** Resolve a declared table's directory; an undeclared table is a caller bug and throws. */
  private tableDir(table: string): string {
    if (!this.descriptor.tables.includes(table)) {
      throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
    return join(this.dir, table)
  }

  /** Durably replace one document, creating its parent directory. */
  private writeDocument(path: string, value: unknown): Promise<void> {
    return (async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeAtomic(path, serializeRecord(this.descriptor.version, value))
    })()
  }

  /** Track one durable write so close() drains it. */
  private tracked(write: Promise<void>): Promise<void> {
    this.inFlight.add(write)
    // Swallow only on the tracking branch: the caller still awaits `write`
    // itself, so rejections stay observed exactly once.
    write.catch(() => {}).finally(() => this.inFlight.delete(write))
    return write
  }
}

/** Local-time `YYYYMMDDHHmm` suffix for backed-up documents. */
function backupStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`
}

/** Reject a record key that would be unsafe as a path segment. */
function assertSafeKey(unit: string, key: string): void {
  if (!SAFE_KEY_RE.test(key)) {
    throw new Error(`unit '${unit}': per-record key '${key}' is not path-safe (must match ${SAFE_KEY_RE})`)
  }
}
