/** Immutable, Session-owned historical comparisons stored independently of recorder scratch space. @module */
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, realpath, rm, statfs, unlink } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceChangesSummary, WorkspaceFileDiff, WorkspaceReviewId } from './types.ts'

const count = z.number().int().nonnegative()
const path = z.object({ path: z.string().min(1), display: z.string().min(1) })
const summarySchema = z.object({
  turn: z.number().int().positive(), cwd: z.string().min(1), total: count, added: count, deleted: count,
  files: z.array(path.extend({ added: count, deleted: count, binary: z.literal(true).optional(), oversized: z.literal(true).optional() })),
  snapshot: z.object({ before: z.string(), after: z.string() }).optional(),
})
const diffSchema = z.discriminatedUnion('kind', [
  path.extend({ kind: z.literal('binary') }), path.extend({ kind: z.literal('oversized') }),
  path.extend({ kind: z.literal('text'), before: z.boolean(), after: z.boolean(), coarse: z.boolean(),
    hunks: z.array(z.object({ oldStart: count, oldLines: count, newStart: count, newLines: count,
      lines: z.array(z.string().regex(/^[+ -]/u)),
    })),
  }),
])
const recordSchema = z.object({
  version: z.literal(1), sessionId: z.string().min(1), summary: summarySchema, diffs: z.array(diffSchema),
}).strict()

/** One complete historical review; comparisons preserve their summary indices. */
export interface StoredReview {
  readonly version: 1
  readonly sessionId: SessionId
  readonly summary: WorkspaceChangesSummary
  readonly diffs: readonly WorkspaceFileDiff[]
}

/** A recorded review cannot fit the configured artifact limit. */
export class ReviewCapacityError extends Error {
  /** @param requiredBytes - minimum observed serialized capacity needed by this record. */
  constructor(readonly requiredBytes: number) { super('Historical review exceeds its configured storage limit') }
}

function digest(data: string | Buffer): string { return createHash('sha256').update(data).digest('hex') }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' }

function alignedFiles(record: {
  summary: { files: readonly { path: string; display: string }[] }
  diffs: readonly { path: string; display: string }[]
}): boolean {
  return record.summary.files.length === record.diffs.length && record.summary.files.every((file, index) => {
    const diff = record.diffs[index]
    return diff !== undefined && diff.path === file.path && diff.display === file.display
  })
}

async function syncDirectory(directory: string): Promise<void> {
  /* v8 ignore next -- Windows cannot open POSIX directory handles; NTFS journals entries, as for durable attachment storage. */
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function durableDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let current = directory
  while (current !== parse(current).root) {
    const entry = await lstat(current)
    if (entry.isSymbolicLink()) {
      // System path aliases are resolved by the caller's canonical root before publication.
      throw new Error('Historical review storage contains a symbolic-link directory')
    }
    await syncDirectory(dirname(current))
    current = dirname(current)
  }
}

/** Content-addressed review artifacts; successful publication includes file durability. */
export class ReviewStore {
  /** Configured Host storage root; recorders exclude it from workspace snapshots. */
  readonly root: string

  /**
   * @param root - private runtime-owned storage directory, separate from workspaces.
   * @param maxBytes - maximum serialized bytes accepted or read for one review.
   */
  constructor(root: string, private readonly maxBytes: number) { this.root = resolve(root) }

  /**
   * Refuse a growing review before retaining more comparison data.
   * @param bytes - serialized bytes accumulated by the recorder.
   */
  assertCapacity(bytes: number): void {
    if (bytes > this.maxBytes) throw new ReviewCapacityError(bytes)
  }

  private async directory(sessionId: SessionId, create = false): Promise<string> {
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 })
    return join(await realpath(this.root), digest(sessionId))
  }

  /**
   * Publish a complete review before its Session event is appended.
   * @param record - captured summary and exact per-file comparisons.
   * @returns immutable content identity used by the announcing event.
   */
  async save(record: StoredReview): Promise<WorkspaceReviewId> {
    if (!alignedFiles(record)) throw new Error('Historical review file indices are inconsistent')
    const bytes = Buffer.from(JSON.stringify(record))
    this.assertCapacity(bytes.length)
    const id = digest(bytes), directory = await this.directory(record.sessionId, true), target = join(directory, `${id}.json`)
    await durableDirectory(directory)
    const temporary = join(directory, `.${randomUUID()}.pending`)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      try { await link(temporary, target) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (await this.read(record.sessionId, id) === undefined) throw new Error('Historical review disappeared during publication')
      }
      await syncDirectory(directory)
      return id as WorkspaceReviewId
    } finally {
      try { await unlink(temporary) } catch (error) { if (!missing(error)) throw error }
    }
  }

  /**
   * Read and validate a review without touching the current workspace.
   * @param sessionId - the authorized Session whose event names this record.
   * @param id - content identity stored in that event.
   * @param signal - caller cancellation.
   * @returns detached recorded data, or undefined when an artifact is absent.
   */
  async read(sessionId: SessionId, id: string, signal?: AbortSignal): Promise<StoredReview | undefined> {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid historical review identity')
    let target: string
    try {
      target = join(await this.directory(sessionId), `${id}.json`)
      const info = await lstat(target)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Historical review is not a regular file')
    } catch (error) { if (missing(error)) return undefined; throw error }
    const handle = await open(target, 'r')
    let bytes: Buffer
    try {
      const { size } = await handle.stat()
      this.assertCapacity(size)
      const buffer = Buffer.alloc(size + 1)
      let offset = 0
      while (offset < buffer.length) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      bytes = buffer.subarray(0, offset)
      if (offset !== size || digest(bytes) !== id) throw new Error('Historical review digest mismatch')
    } finally { await handle.close() }
    const record = recordSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown)
    if (record.sessionId !== sessionId || !alignedFiles(record)) throw new Error('Historical review ownership or file indices are inconsistent')
    const { summary } = record
    return { version: 1, sessionId, diffs: record.diffs, summary: {
      turn: summary.turn, cwd: summary.cwd, total: summary.total, added: summary.added, deleted: summary.deleted,
      files: summary.files.map(file => ({ path: file.path, display: file.display, added: file.added, deleted: file.deleted,
        ...(file.binary === undefined ? {} : { binary: file.binary }),
        ...(file.oversized === undefined ? {} : { oversized: file.oversized }),
      })),
      ...(summary.snapshot === undefined ? {} : { snapshot: summary.snapshot }),
    } }
  }

  /**
   * Remove only this Session's immutable reviews after its lifecycle owner has released it.
   * @param sessionId - identity selected by an authorized permanent purge.
   * @param signal - cancellation before removal starts.
   */
  async remove(sessionId: SessionId, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    let directory: string
    try {
      directory = await this.directory(sessionId)
      const entry = await lstat(directory)
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Historical review storage is not an owned directory')
    } catch (error) { if (missing(error)) return; throw error }
    signal?.throwIfAborted()
    await rm(directory, { recursive: true })
    await syncDirectory(dirname(directory))
  }

  /**
   * Verify durable storage is writable before resuming a Session after a storage failure.
   * @param sessionId - affected Session; no historical artifact is replaced.
   * @param requiredBytes - previously recorded capacity requirement; zero when none was recorded.
   */
  async probe(sessionId: SessionId, requiredBytes = 0): Promise<void> {
    this.assertCapacity(requiredBytes)
    const directory = await this.directory(sessionId, true)
    await durableDirectory(directory)
    const space = await statfs(directory, { bigint: true })
    if (space.bavail * space.bsize < BigInt(this.maxBytes)) throw new Error('Historical review storage has insufficient free space')
    const file = join(directory, `.${randomUUID()}.probe`)
    try {
      const handle = await open(file, 'wx', 0o600)
      try { await handle.writeFile('review storage probe\n'); await handle.sync() } finally { await handle.close() }
      await syncDirectory(directory)
    } finally {
      try { await unlink(file) } catch (error) { if (!missing(error)) throw error }
    }
  }
}
