/** Session-authorized, relative-path Workspace file reads over the existing FS provider. */
import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsInfo, FsObservation, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { collaborationRefusal } from '@deepseek-ai/dsh-collaboration'
import type { CollaborationAuthority } from '@deepseek-ai/dsh-collaboration'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { HostFrame } from './api/events.ts'
import type { RpcError, RpcRequest, RpcResponse } from './api/rpc.ts'
import type { WorkspaceFileEntry, WorkspaceFilesApi, WorkspaceFileStat } from './api/workspace-files.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Authorize a canonical provider path before Workspace metadata or content is read.
     * @mode serial
     * @param sessionId - Session whose Workspace bounds the request.
     * @param path - internal provider path; never emitted on the wire.
     */
    'workspace-files/authorize'(sessionId: SessionId, path: string): void | Promise<void>
  }
}

/** Default maximum bytes returned by one Workspace page or byte window. */
export const DEFAULT_WORKSPACE_FILE_MAX_BYTES = 2 * 1024 * 1024
/** Default maximum lines returned by one Workspace text page. */
export const DEFAULT_WORKSPACE_FILE_MAX_LINES = 5_000
/** Default maximum directory entries processed for one Workspace listing. */
export const DEFAULT_WORKSPACE_FILE_MAX_ENTRIES = 2_000

/** Default number of Client metadata records retained per runtime. */
export const DEFAULT_WORKSPACE_FILE_MAX_RESOURCES = 512

type FileFailureCode = 'workspace-file/not-found' | 'workspace-file/outside-workspace'
  | 'workspace-file/not-directory' | 'workspace-file/not-regular-file' | 'workspace-file/not-text'
  | 'workspace-file/stale-version'

const FILE_FAILURE_MESSAGES: Record<FileFailureCode, string> = {
  'workspace-file/not-found': 'Workspace file was not found.',
  'workspace-file/outside-workspace': 'The path is outside the Session workspace or uses a symbolic link.',
  'workspace-file/not-directory': 'The Workspace path is not a directory.',
  'workspace-file/not-regular-file': 'The Workspace path is not a regular file.',
  'workspace-file/not-text': 'This file cannot be previewed as UTF-8 text. Use a byte window instead.',
  'workspace-file/stale-version': 'The file changed while reading. Reload its metadata and retry.',
}

class FileFailure extends Error {
  constructor(readonly error: RpcError) { super(error.message) }
}

function refuse(code: FileFailureCode, sessionId: SessionId, path: string): never {
  throw new FileFailure({ code, message: FILE_FAILURE_MESSAGES[code], details: { sessionId, path } })
}

function relativePath(input: string, sessionId: SessionId): string {
  // Both path grammars are checked because the browser and provider can run on different OSes.
  if (posix.isAbsolute(input) || win32.isAbsolute(input) || /^[A-Za-z]:|^[A-Za-z][\w+.-]*:/u.test(input)
    || input.includes('\0') || input.length > 4096) {
    throw new FileFailure({ code: 'workspace-file/unsupported-address', message: 'Use a Workspace-relative file address.', details: { sessionId } })
  }
  const segments = input.replaceAll('\\', '/').split('/')
  if (segments.includes('..')) refuse('workspace-file/outside-workspace', sessionId, '.')
  return segments.filter(part => part !== '' && part !== '.').join('/') || '.'
}

/**
 * Encode provider freshness without exposing provider-specific identity fields.
 * @param version - provider token.
 * @returns opaque wire token.
 */
function wireVersion(version: FsVersion): string {
  return createHash('sha256').update(version).digest('hex')
}

interface Limits { maxBytes: number; maxLines: number; maxEntries: number }
interface ReadOptions {
  maxBytes: number | undefined
  maxLines: number | undefined
  maxEntries: number | undefined
  authorize(sessionId: SessionId): Promise<{ authority: CollaborationAuthority | undefined } | { error: RpcError }>
  validateRoot(cwd: string, authority: CollaborationAuthority | undefined): Promise<string>
  principalSignal(signal: AbortSignal, authority: CollaborationAuthority | undefined): AbortSignal
}
interface LocatedFile {
  fs: FileSystem
  cwd: string
  root: FsTarget
  target: FsTarget
  info: FsInfo
  path: string
  sessionId: SessionId
}

function bound(value: number | undefined, maximum: number, sessionId: SessionId, path: string): number {
  const resolved = value ?? maximum
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new FileFailure({ code: 'workspace-file/too-large', message: `The requested window must be within 1..${String(maximum)}.`, details: { sessionId, path, limit: maximum } })
  }
  return resolved
}

async function headerOf(ctx: Context, sessionId: SessionId, signal: AbortSignal): Promise<SessionHeader | undefined> {
  return ctx.sessions.get(sessionId)?.header ?? await ctx.get('sessionPersistence')?.readHeader(sessionId, signal)
}

async function locate(
  ctx: Context, fs: FileSystem, cwd: string, path: string, sessionId: SessionId, signal: AbortSignal,
): Promise<LocatedFile> {
  const root = await fs.resolve('.', { cwd, signal })
  const target = await fs.resolve(path, { cwd, signal })
  if (!fs.contains(root, target)) refuse('workspace-file/outside-workspace', sessionId, path)
  await ctx.serial('workspace-files/authorize', sessionId, fs.processPath(target))
  let prefix = ''
  for (const segment of path.split('/')) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`
    const info = await fs.lstat(prefix, { cwd }, signal)
    if (info === undefined) refuse('workspace-file/not-found', sessionId, path)
    if (info.type === 'symlink') refuse('workspace-file/outside-workspace', sessionId, path)
    if (prefix !== path && info.type !== 'directory') refuse('workspace-file/not-directory', sessionId, path)
  }
  const info = await fs.stat(target, signal)
  if (info === undefined) refuse('workspace-file/not-found', sessionId, path)
  return { fs, cwd, root, target, info, path, sessionId }
}

function metadata(file: LocatedFile): WorkspaceFileStat {
  if (file.info.type === 'other') refuse('workspace-file/not-regular-file', file.sessionId, file.path)
  return { path: file.path, type: file.info.type, version: wireVersion(file.info.version),
    ...(file.info.type !== 'file' || file.info.size === undefined ? {} : { bytes: file.info.size }) }
}

function readFailure(error: unknown, sessionId: SessionId, path: string, signal: AbortSignal, limits: Limits): RpcError {
  if (signal.aborted || (error instanceof FsError && error.code === 'FS_ABORTED')) {
    return { code: 'cancelled', message: 'Workspace file operation was cancelled.', details: {} }
  }
  if (error instanceof FileFailure) return error.error
  if (error instanceof FsError) {
    if (error.code === 'FS_PERMISSION_DENIED' || error.code === 'FS_SANDBOX_DENIED') return { code: 'collaboration-forbidden', message: 'Workspace file access is not permitted.', details: { sessionId, action: 'read', reason: 'forbidden' } }
    const codes: Partial<Record<FsError['code'], FileFailureCode>> = {
      FS_NOT_FOUND: 'workspace-file/not-found', FS_NOT_DIRECTORY: 'workspace-file/not-directory',
      FS_NOT_REGULAR_FILE: 'workspace-file/not-regular-file', FS_NOT_TEXT: 'workspace-file/not-text',
      FS_STALE_VERSION: 'workspace-file/stale-version',
    }
    if (error.code === 'FS_TOO_LARGE') return { code: 'workspace-file/too-large', message: 'Workspace file page exceeds the byte limit.', details: { sessionId, path, limit: limits.maxBytes } }
    const code = codes[error.code]
    if (code !== undefined) return { code, message: FILE_FAILURE_MESSAGES[code], details: { sessionId, path } }
  }
  // Provider diagnostics may include absolute paths or credentials; only the error category crosses RPC.
  return { code: 'internal', message: 'Workspace file operation failed. Retry after checking the workspace provider.', details: {} }
}

/**
 * Create the file domain owned by the ApiProxy Cordis plugin.
 * @param ctx - Host services and lifetime.
 * @param options - validated limits, current-principal authorization, and project root policy.
 * @returns unary methods using the existing RPC error and cancellation behavior.
 */
export function createWorkspaceFilesApi(ctx: Context, options: ReadOptions): WorkspaceFilesApi {
  const limits: Limits = {
    maxBytes: options.maxBytes ?? DEFAULT_WORKSPACE_FILE_MAX_BYTES,
    maxLines: options.maxLines ?? DEFAULT_WORKSPACE_FILE_MAX_LINES,
    maxEntries: options.maxEntries ?? DEFAULT_WORKSPACE_FILE_MAX_ENTRIES,
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) throw new RangeError(`workspaceFiles: ${name} must be a positive safe integer below MAX_SAFE_INTEGER`)
  }
  const lifetime = new AbortController()
  const pending = new Set<Promise<unknown>>()
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([...pending])
  }, 'apiproxy: Workspace file reads')

  async function unary<T>(request: RpcRequest<{ sessionId: SessionId; path?: string }>, external: AbortSignal | undefined,
    operation: (file: LocatedFile, signal: AbortSignal) => Promise<T>): Promise<RpcResponse<T>> {
    const { sessionId } = request.payload
    let signal = external === undefined ? lifetime.signal : AbortSignal.any([external, lifetime.signal])
    let path = '.'
    const work = (async (): Promise<RpcResponse<T>> => {
      try {
        signal.throwIfAborted()
        const authorized = await options.authorize(sessionId)
        if ('error' in authorized) return { rpcId: request.rpcId, result: { ok: false, error: authorized.error } }
        signal = options.principalSignal(signal, authorized.authority)
        signal.throwIfAborted()
        path = relativePath(request.payload.path ?? '.', sessionId)
        const fs = ctx.get('fs')
        if (fs === undefined) throw new Error('FS unavailable')
        const header = await headerOf(ctx, sessionId, signal)
        if (header?.cwd === undefined) throw new FileFailure({ code: 'workspace-file/unknown-session', message: 'Session workspace is unavailable.', details: { sessionId } })
        const cwd = await options.validateRoot(header.cwd, authorized.authority)
        const file = await locate(ctx, fs, cwd, path, sessionId, signal)
        const value = await operation(file, signal)
        const current = await locate(ctx, fs, cwd, path, sessionId, signal)
        if (current.target.targetKey !== file.target.targetKey || current.info.version !== file.info.version) refuse('workspace-file/stale-version', sessionId, path)
        // Access may be revoked while provider I/O is in flight. No bytes are returned until this recheck succeeds.
        if (authorized.authority !== undefined) {
          try { await authorized.authority.authorize(sessionId, 'read') } catch (error: unknown) {
            return { rpcId: request.rpcId, result: { ok: false, error: collaborationRefusal(error, 'read', sessionId) } }
          }
        }
        signal.throwIfAborted()
        return { rpcId: request.rpcId, result: { ok: true, value } }
      } catch (error: unknown) {
        return { rpcId: request.rpcId, result: { ok: false, error: readFailure(error, sessionId, path, signal, limits) } }
      }
    })()
    pending.add(work)
    try { return await work } finally { pending.delete(work) }
  }

  return {
    list: (request, signal) => unary(request, signal, async (file, abort) => {
      if (file.info.type !== 'directory') refuse('workspace-file/not-directory', file.sessionId, file.path)
      const limit = bound(request.payload.maxEntries, limits.maxEntries, file.sessionId, file.path)
      const children = await file.fs.listDir(file.target, abort, limit + 1)
      const entries: WorkspaceFileEntry[] = []
      for (const child of children.slice(0, limit)) {
        if (child.name === '.' || child.name === '..' || /[\\/\0]/u.test(child.name)) continue
        const path = file.path === '.' ? child.name : `${file.path}/${child.name}`
        if (!file.fs.contains(file.root, child.target)) continue
        const info = await file.fs.lstat(path, { cwd: file.cwd }, abort)
        if (info === undefined || info.type === 'symlink' || info.type === 'other') continue
        entries.push({ name: child.name, path, type: info.type, version: wireVersion(info.version),
          ...(info.type !== 'file' || info.size === undefined ? {} : { bytes: info.size }) })
      }
      return { path: file.path, entries, truncated: children.length > limit }
    }),
    stat: (request, signal) => unary(request, signal, file => Promise.resolve(metadata(file))),
    read: (request, signal) => unary(request, signal, async (file, abort) => {
      if (file.info.type !== 'file') refuse('workspace-file/not-regular-file', file.sessionId, file.path)
      const offset = request.payload.offset ?? 1
      if (!Number.isSafeInteger(offset) || offset < 1) throw new FileFailure({ code: 'bad-request', message: 'Text offsets start at line 1.', details: { issues: [] } })
      const limit = bound(request.payload.limit, limits.maxLines, file.sessionId, file.path)
      if (request.payload.version !== undefined && request.payload.version !== wireVersion(file.info.version)) refuse('workspace-file/stale-version', file.sessionId, file.path)
      const parts: string[] = []
      let line = 1
      let bytes = 0
      let eof = true
      const stream = await file.fs.streamText(file.target, abort, file.info.version)
      outer: for await (const chunk of stream) {
        abort.throwIfAborted()
        let start = 0
        while (start < chunk.length) {
          const newline = chunk.indexOf('\n', start)
          const end = newline < 0 ? chunk.length : newline + 1
          if (line >= offset) {
            const part = chunk.slice(start, end)
            if (part.includes('\0')) refuse('workspace-file/not-text', file.sessionId, file.path)
            bytes += Buffer.byteLength(part)
            if (bytes > limits.maxBytes) throw new FileFailure({ code: 'workspace-file/too-large', message: 'Workspace text page exceeds its byte limit.', details: { sessionId: file.sessionId, path: file.path, limit: limits.maxBytes } })
            parts.push(part)
          }
          start = end
          if (newline >= 0) line += 1
          if (line - offset >= limit) { eof = false; break outer }
        }
      }
      return { path: file.path, offset, limit, text: parts.join(''), eof, version: wireVersion(file.info.version) }
    }),
    readBytes: (request, signal) => unary(request, signal, async (file, abort) => {
      if (file.info.type !== 'file') refuse('workspace-file/not-regular-file', file.sessionId, file.path)
      const offset = request.payload.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0) throw new FileFailure({ code: 'bad-request', message: 'Byte offsets start at 0.', details: { issues: [] } })
      const length = bound(request.payload.length, limits.maxBytes, file.sessionId, file.path)
      if (request.payload.version !== undefined && request.payload.version !== wireVersion(file.info.version)) refuse('workspace-file/stale-version', file.sessionId, file.path)
      const bytes = await file.fs.readByteRange(file.target, { offset, length, expectedVersion: file.info.version }, abort)
      return { path: file.path, offset, bytes: Buffer.from(bytes).toString('base64'),
        eof: file.info.size === undefined ? bytes.length < length : offset >= file.info.size - bytes.length,
        version: wireVersion(file.info.version) }
    }),
  }
}

type FileChange = Extract<HostFrame, { type: 'host/workspace-file-changed' }>
interface ChangeOptions {
  authority: CollaborationAuthority | undefined
  signal: AbortSignal
  publish(change: FileChange): void
  fail(error: unknown): void
  validateRoot(cwd: string, authority: CollaborationAuthority | undefined): Promise<string>
}

/**
 * Forward Agent observations through one bounded, coalescing Host-stream queue.
 * @param ctx - current Host plugin context.
 * @param options - stream authority, lifetime, and publication callbacks.
 * @returns synchronous listener removal and cancellation.
 */
export function subscribeWorkspaceFileChanges(ctx: Context, options: ChangeOptions): () => void {
  const lifetime = new AbortController()
  const signal = AbortSignal.any([lifetime.signal, options.signal])
  const pending = new Map<string, { session: Session; target: FsTarget; observation: FsObservation }>()
  let draining = false
  const drain = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      while (pending.size > 0 && !signal.aborted) {
        /* v8 ignore next -- Map.size > 0 and its iterator are one synchronous invariant. */
        const first = pending.entries().next().value
        /* v8 ignore next -- the non-empty Map cannot yield no first entry. */
        if (first === undefined) break
        const [key, { session, target, observation }] = first
        pending.delete(key)
        if (ctx.sessions.get(session.id) !== session || session.header.cwd === undefined) continue
        if (options.authority !== undefined && !(await options.authority.readableSessionIds([session.id])).has(session.id)) continue
        const fs = ctx.get('fs')
        if (fs === undefined) continue
        const cwd = await options.validateRoot(session.header.cwd, options.authority)
        const root = await fs.resolve('.', { cwd, signal })
        if (!fs.contains(root, target)) continue
        const base = fs.processPath(root)
        const path = (/^[A-Za-z]:|^\\\\/u.test(base) ? win32 : posix).relative(base, fs.processPath(target)).replaceAll('\\', '/')
        if (path === '' || path.startsWith('../')) continue
        await ctx.serial('workspace-files/authorize', session.id, fs.processPath(target))
        if (options.authority !== undefined) await options.authority.authorize(session.id, 'read')
        signal.throwIfAborted()
        options.publish({ type: 'host/workspace-file-changed', sessionId: session.id, path,
          present: observation.kind === 'present', ...(observation.kind === 'present' ? { version: wireVersion(observation.version) } : {}) })
      }
    } catch (error: unknown) {
      if (!signal.aborted) options.fail(error)
      pending.clear()
      lifetime.abort()
    } finally { draining = false }
  }
  const stop = ctx.on('fs/observed', (target, observation, actor) => {
    if (signal.aborted || actor === undefined) return
    const subject: { agent?: { session?: Session } } = actor
    const session = subject.agent?.session
    if (session === undefined) return
    const key = `${String(session.id)}\0${String(target.targetKey)}`
    // These limits match the existing Host carrier frame budget; overflow requests a reconnect.
    /* v8 ignore next -- duplicate observations are drained synchronously before a test can suspend 1024 distinct entries. */
    if (key.length > 8192 || (pending.size >= 1024 && !pending.has(key))) {
      pending.clear()
      options.fail(new Error('Workspace observation queue overflow'))
      lifetime.abort()
      return
    }
    pending.set(key, { session, target, observation })
    void drain()
  })
  return () => { lifetime.abort(); pending.clear(); stop() }
}
