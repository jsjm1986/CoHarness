/** Durable ownership records for local application data selected by deployment backups. */
import { appendFileSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

/** A local storage owner's file or dedicated data directory; never a project working tree. */
export interface ManagedDataPath {
  /** Package or deployment component responsible for the stored bytes. */
  owner: string
  kind: 'file' | 'directory'
  path: string
}

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024

function syncDirectories(file: string, firstCreated: string | undefined): void {
  /* v8 ignore next -- Windows file flush includes metadata; Node does not open POSIX directory handles there. */
  if (process.platform === 'win32') return
  let directory = dirname(file)
  const last = firstCreated === undefined ? directory : dirname(firstCreated)
  for (;;) {
    const fd = openSync(directory, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    if (directory === last) return
    directory = dirname(directory)
  }
}

function readRecords(file: string): ManagedDataPath[] {
  const info = lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Managed-data inventory must be a regular file')
  if (info.size > MAX_MANIFEST_BYTES) throw new Error('Managed-data inventory exceeds its readable size')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  let text: string
  try {
    const opened = fstatSync(fd)
    if (opened.ino !== info.ino || opened.dev !== info.dev) throw new Error('Managed-data inventory changed during read')
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const chunk = Buffer.allocUnsafe(64 * 1024)
      const size = readSync(fd, chunk)
      if (size === 0) break
      total += size
      if (total > MAX_MANIFEST_BYTES) throw new Error('Managed-data inventory exceeds its readable size')
      chunks.push(chunk.subarray(0, size))
    }
    text = Buffer.concat(chunks, total).toString('utf8')
  } finally { closeSync(fd) }
  if (text !== '' && !text.endsWith('\n')) throw new Error('Managed-data inventory has an incomplete record')
  const records = new Map<string, ManagedDataPath>()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const value: unknown = JSON.parse(line)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid managed-data inventory record')
    const row = value as Record<string, unknown>
    if (row.version !== 1 || typeof row.owner !== 'string' || row.owner === ''
      || (row.kind !== 'file' && row.kind !== 'directory')
      || typeof row.path !== 'string' || !isAbsolute(row.path)
      || Object.keys(row).some(key => !['version', 'owner', 'kind', 'path'].includes(key))) {
      throw new Error('Invalid managed-data inventory record')
    }
    const entry: ManagedDataPath = { owner: row.owner, kind: row.kind, path: resolve(row.path) }
    records.set(JSON.stringify([entry.path, entry.owner, entry.kind]), entry)
  }
  return [...records.keys()].sort().map(key => records.get(key) as ManagedDataPath)
}

/**
 * Read all recorded roots, including earlier roots retained after configuration changes.
 * @param file - inventory owned by a specific runtime's private Harness home.
 * @returns distinct recorded paths; missing, malformed and incomplete inventories fail.
 */
export function readManagedDataPaths(file: string): ManagedDataPath[] {
  return readRecords(file)
}

/**
 * Record storage ownership before the provider writes application data.
 * @param entry - actual resolved storage path and its package owner.
 * @param inventory - explicit inventory destination, or absence for an unmanaged deployment.
 * @returns after the claim is durable; an unset destination leaves standalone deployments unchanged.
 */
export function registerManagedDataPath(entry: ManagedDataPath, inventory: string | undefined): void {
  if (inventory === undefined) return
  if (!isAbsolute(inventory)) throw new Error('DSH_MANAGED_DATA_MANIFEST must be an absolute path')
  const record = { owner: entry.owner, kind: entry.kind, path: resolve(entry.path) }
  const existing = lstatSync(inventory, { throwIfNoEntry: false })
  const recorded = existing !== undefined && readRecords(inventory).some(previous => previous.owner === record.owner
    && previous.kind === record.kind && previous.path === record.path)
  const firstCreated = mkdirSync(dirname(inventory), { recursive: true, mode: 0o700 })
  // O_APPEND retains concurrent claims from processes sharing a Harness home.
  const fd = openSync(inventory, existing === undefined ? 'ax' : 'a', 0o600)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || (existing !== undefined && (opened.ino !== existing.ino || opened.dev !== existing.dev))) {
      throw new Error('Managed-data inventory changed during registration')
    }
    if (!recorded) {
      const line = JSON.stringify({ version: 1, ...record }) + '\n'
      if (opened.size + Buffer.byteLength(line) > MAX_MANIFEST_BYTES) throw new Error('Managed-data inventory exceeds its readable size')
      appendFileSync(fd, line)
    }
    fsyncSync(fd)
  } finally { closeSync(fd) }
  syncDirectories(inventory, firstCreated)
}
