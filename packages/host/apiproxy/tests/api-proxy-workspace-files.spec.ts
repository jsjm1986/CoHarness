import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { createWorkspaceFilesApi, subscribeWorkspaceFileChanges } from '../src/workspace-files.ts'
import { createApiProxy } from '../src/api-proxy.ts'
import type { RpcRequest } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import { CollaborationError } from '@deepseek-ai/dsh-collaboration'
import type { CollaborationAuthority } from '@deepseek-ai/dsh-collaboration'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose() })

const request = <P>(payload: P): RpcRequest<P> => ({ rpcId: RpcId('workspace-files-test'), payload })

function expectOk<T>(response: { result: { ok: true; value: T } | { ok: false; error: unknown } }): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('expected successful response')
  return response.result.value
}

async function harness(options: {
  authority?: CollaborationAuthority
  maxBytes?: number
  maxLines?: number
  maxEntries?: number
} = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-workspace-files-')))
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const domain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', domain)
  ctx.provide('storageDomain', domain)
  const headers = new Map<SessionId, import('@deepseek-ai/dsh-session').SessionHeader>()
  const readHeader = vi.fn((id: SessionId) => Promise.resolve(headers.get(id)))
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]), readHeader } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  if (options.authority !== undefined) ctx.provide('collaboration', { capture: () => options.authority } as never)
  const api = createApiProxy(ctx, { cwd: root, defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    ...(options.maxBytes === undefined ? {} : { workspaceFileMaxBytes: options.maxBytes }),
    ...(options.maxLines === undefined ? {} : { workspaceFileMaxLines: options.maxLines }),
    ...(options.maxEntries === undefined ? {} : { workspaceFileMaxEntries: options.maxEntries }),
  })
  const session = ctx.sessions.create(SessionId('workspace-files-session'), { meta: { cwd: root } })
  return { api, ctx, root, session, headers, readHeader }
}

function authority(mode: 'ro' | 'rw'): CollaborationAuthority {
  return {
    participant: { userId: 1, username: 'alice', displayName: 'Alice', role: 'user', scope: { kind: 'project', projectId: 7, projectName: 'Project', mode } },
    expiresAt: Date.now() + 60_000,
    signal: new AbortController().signal,
    authorize: async sessionId => ({ sessionId, rootSessionId: sessionId, canRead: true, canWrite: mode === 'rw', canManage: false, mode }),
    readableSessionIds: async ids => new Set(ids),
    claimInteraction: async () => false,
  }
}

describe('workspaceFiles RPC', () => {
  it('lists and reads bounded text and byte windows without exposing a host path', async () => {
    const { api, root, session } = await harness()
    writeFileSync(join(root, 'notes.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(root, 'data.bin'), Buffer.from([0, 1, 2, 3]))
    const listed = expectOk(await api.workspaceFiles.list(request({ sessionId: session.id })))
    expect(listed.path).toBe('.')
    expect(listed.entries.map(entry => entry.path)).toEqual(['data.bin', 'notes.txt'])
    expect(JSON.stringify(listed)).not.toContain(root)
    const stat = expectOk(await api.workspaceFiles.stat(request({ sessionId: session.id, path: 'notes.txt' })))
    expect(stat).toMatchObject({ path: 'notes.txt', type: 'file', bytes: 14 })
    const page = expectOk(await api.workspaceFiles.read(request({ sessionId: session.id, path: 'notes.txt', offset: 2, limit: 1 }), new AbortController().signal))
    expect(page.text).toBe('two\n')
    expect(page.eof).toBe(false)
    const window = expectOk(await api.workspaceFiles.readBytes(request({ sessionId: session.id, path: 'data.bin', offset: 1, length: 2 }), new AbortController().signal))
    expect(Buffer.from(window.bytes, 'base64')).toEqual(Buffer.from([1, 2]))
    const limited = expectOk(await api.workspaceFiles.list(request({ sessionId: session.id, maxEntries: 1 })))
    expect(limited.entries).toHaveLength(1)
    expect(limited.truncated).toBe(true)
  })

  it('rejects traversal, absolute paths, and symlinks', async () => {
    const { api, root, session } = await harness()
    writeFileSync(join(root, 'inside.txt'), 'ok')
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-workspace-files-outside-')))
    cleanups.push(() => { rmSync(outside, { recursive: true, force: true }) })
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
    const traversal = await api.workspaceFiles.stat(request({ sessionId: session.id, path: '../secret.txt' }))
    expect(traversal.result).toMatchObject({ ok: false, error: { code: 'workspace-file/outside-workspace' } })
    const absolute = await api.workspaceFiles.stat(request({ sessionId: session.id, path: join(outside, 'secret.txt') }))
    expect(absolute.result).toMatchObject({ ok: false, error: { code: 'workspace-file/unsupported-address' } })
    expect(JSON.stringify(absolute)).not.toContain(outside)
    const link = await api.workspaceFiles.stat(request({ sessionId: session.id, path: 'link.txt' }))
    expect(link.result).toMatchObject({ ok: false, error: { code: 'workspace-file/outside-workspace' } })
  })

  it('reports binary files through the text error while byte reads remain available', async () => {
    const { api, root, session } = await harness()
    writeFileSync(join(root, 'data.bin'), Buffer.from([0, 1, 2]))
    const text = await api.workspaceFiles.read(request({ sessionId: session.id, path: 'data.bin' }), new AbortController().signal)
    expect(text.result).toMatchObject({ ok: false, error: { code: 'workspace-file/not-text' } })
    const bytes = await api.workspaceFiles.readBytes(request({ sessionId: session.id, path: 'data.bin' }), new AbortController().signal)
    expect(bytes.result).toMatchObject({ ok: true, value: { bytes: 'AAEC' } })
  })
  it('reads a cold Session header without materializing an Agent or a log body', async () => {
    const { api, ctx, root, session, headers, readHeader } = await harness()
    writeFileSync(join(root, 'cold.txt'), 'cold')
    const coldId = SessionId('cold-session')
    headers.set(coldId, { ...session.header, id: coldId })
    const result = await api.workspaceFiles.stat(request({ sessionId: coldId, path: 'cold.txt' }))
    expect(result.result).toMatchObject({ ok: true, value: { bytes: 4 } })
    expect(readHeader).toHaveBeenCalledWith(coldId, expect.any(AbortSignal))
    expect(ctx.agents.get(coldId)).toBeUndefined()
    expect(ctx.sessions.get(coldId)).toBeUndefined()
    expect((await api.workspaceFiles.stat(request({ sessionId: SessionId('missing'), path: 'cold.txt' }))).result).toMatchObject({ ok: false, error: { code: 'workspace-file/unknown-session' } })
  })

  it.each(['ro', 'rw'] as const)('allows %s project members to read through the same read authorization', async (mode) => {
    const actor = authority(mode)
    const authorize = vi.spyOn(actor, 'authorize')
    const { api, root, session } = await harness({ authority: actor })
    writeFileSync(join(root, 'file'), 'data')
    expect((await api.workspaceFiles.readBytes(request({ sessionId: session.id, path: 'file' }), new AbortController().signal)).result.ok).toBe(true)
    expect(authorize.mock.calls.every(([, action]) => action === 'read')).toBe(true)
    expect(authorize).toHaveBeenCalledTimes(2)
  })

  it('checks Session permission before probing a submitted path and again after I/O', async () => {
    const actor = authority('rw')
    const { api, ctx, root, session } = await harness({ authority: actor })
    writeFileSync(join(root, 'file'), 'data')
    const resolve = vi.spyOn(ctx.fs, 'resolve')
    const authorize = vi.spyOn(actor, 'authorize').mockRejectedValueOnce(new CollaborationError('not-member'))
    expect((await api.workspaceFiles.stat(request({ sessionId: session.id, path: 'file' }))).result).toMatchObject({ ok: false, error: { code: 'collaboration-forbidden' } })
    expect(resolve).not.toHaveBeenCalled()
    const read = ctx.fs.readByteRange.bind(ctx.fs)
    vi.spyOn(ctx.fs, 'readByteRange').mockImplementation(async (...args) => {
      const bytes = await read(...args)
      authorize.mockRejectedValueOnce(new CollaborationError('not-member'))
      return bytes
    })
    const result = await api.workspaceFiles.readBytes(request({ sessionId: session.id, path: 'file' }), new AbortController().signal)
    expect(result.result).toMatchObject({ ok: false, error: { code: 'collaboration-forbidden' } })
    expect(JSON.stringify(result)).not.toContain(Buffer.from('data').toString('base64'))
  })

  it('enforces the composed directory grant listener and unwinds it on plugin disposal', async () => {
    const { api, ctx, root, session } = await harness()
    writeFileSync(join(root, 'file'), 'data')
    const plugin = await ctx.plugin((scope) => {
      scope.on('workspace-files/authorize', () => { throw new FsError('private deployment path', 'FS_PERMISSION_DENIED') })
    })
    const denied = await api.workspaceFiles.stat(request({ sessionId: session.id, path: 'file' }))
    expect(denied.result).toMatchObject({ ok: false, error: { code: 'collaboration-forbidden' } })
    expect(JSON.stringify(denied)).not.toContain('private deployment path')
    await plugin.dispose()
    expect((await api.workspaceFiles.stat(request({ sessionId: session.id, path: 'file' }))).result.ok).toBe(true)
  })

  it('rejects oversize pages and windows while returning an exact byte boundary', async () => {
    const { api, root, session } = await harness({ maxBytes: 4, maxLines: 2, maxEntries: 1 })
    writeFileSync(join(root, 'file'), '中文\nnext')
    const payload = { sessionId: session.id, path: 'file' }
    const signal = new AbortController().signal
    expect((await api.workspaceFiles.read(request({ ...payload, limit: 1 }), signal)).result).toMatchObject({ ok: false, error: { code: 'workspace-file/too-large' } })
    expect((await api.workspaceFiles.read(request({ ...payload, limit: 3 }), signal)).result).toMatchObject({ ok: false, error: { code: 'workspace-file/too-large' } })
    expect((await api.workspaceFiles.readBytes(request({ ...payload, length: 5 }), signal)).result).toMatchObject({ ok: false, error: { code: 'workspace-file/too-large' } })
    const tail = expectOk(await api.workspaceFiles.readBytes(request({ ...payload, offset: 7, length: 4 }), signal))
    expect(Buffer.from(tail.bytes, 'base64').toString()).toBe('next')
    expect(tail.eof).toBe(true)
    expect((await api.workspaceFiles.list(request({ sessionId: session.id, maxEntries: 2 }))).result.ok).toBe(false)
  })

  it('rejects a stale page token and a version changed while reading', async () => {
    const { api, ctx, root, session } = await harness()
    const payload = { sessionId: session.id, path: 'file' }
    writeFileSync(join(root, 'file'), 'old')
    const metadata = expectOk(await api.workspaceFiles.stat(request(payload)))
    writeFileSync(join(root, 'file'), 'new')
    expect((await api.workspaceFiles.read(request({ ...payload, version: metadata.version }), new AbortController().signal)).result).toMatchObject({ ok: false, error: { code: 'workspace-file/stale-version' } })
    const read = ctx.fs.readByteRange.bind(ctx.fs)
    vi.spyOn(ctx.fs, 'readByteRange').mockImplementation(async (...args) => {
      const bytes = await read(...args)
      writeFileSync(join(root, 'file'), 'changed after read')
      return bytes
    })
    expect((await api.workspaceFiles.readBytes(request(payload), new AbortController().signal)).result).toMatchObject({ ok: false, error: { code: 'workspace-file/stale-version' } })
  })

  it('cancels reads when the principal expires or the caller aborts', async () => {
    const actor = authority('ro')
    const { api, root, session } = await harness({ authority: actor })
    writeFileSync(join(root, 'file'), 'data')
    const payload = { sessionId: session.id, path: 'file' }
    expect((await api.workspaceFiles.readBytes(request(payload), AbortSignal.abort())).result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    Object.assign(actor, { expiresAt: Date.now() - 1 })
    expect((await api.workspaceFiles.readBytes(request(payload), new AbortController().signal)).result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })


  it('publishes ordered Agent observations with a relative path and stops after release', async () => {
    const { ctx, root, session } = await harness()
    writeFileSync(join(root, 'file'), 'data')
    const target = await ctx.fs.resolve('file')
    const frames: unknown[] = []
    const fail = vi.fn()
    const stop = subscribeWorkspaceFileChanges(ctx, {
      authority: undefined,
      signal: new AbortController().signal,
      publish: (frame) => { frames.push(frame) },
      fail,
      validateRoot: async cwd => cwd,
    })
    ctx.emit('fs/observed', target, { kind: 'present', version: await (async () => {
      const info = await ctx.fs.stat(target)
      if (info === undefined) throw new Error('missing test target')
      return info.version
    })() }, { agent: { session } })
    ctx.emit('fs/observed', target, { kind: 'absent' }, { agent: { session } })
    await vi.waitFor(() => { expect(frames).toHaveLength(2) })
    expect(frames.at(-1)).toMatchObject({ type: 'host/workspace-file-changed', sessionId: session.id, path: 'file', present: false })
    expect(JSON.stringify(frames[0])).not.toContain(root)
    stop()
    ctx.emit('fs/observed', target, { kind: 'present', version: FsVersion('late') }, { agent: { session } })
    await Promise.resolve()
    expect(frames).toHaveLength(2)
    expect(fail).not.toHaveBeenCalled()
  })

  it('skips unreadable sessions and ends the changes stream on policy failure or queue overflow', async () => {
    const { ctx, root, session } = await harness()
    writeFileSync(join(root, 'file'), 'data')
    const target = await ctx.fs.resolve('file')
    const actor = authority('ro')
    actor.readableSessionIds = async () => new Set()
    const skipped: unknown[] = []
    const stop = subscribeWorkspaceFileChanges(ctx, {
      authority: actor, signal: new AbortController().signal,
      publish: (frame) => { skipped.push(frame) }, fail: vi.fn(), validateRoot: async cwd => cwd,
    })
    ctx.emit('fs/observed', target, { kind: 'present', version: FsVersion('v1') }, { agent: { session } })
    await Promise.resolve()
    expect(skipped).toHaveLength(0)
    stop()

    const allowed = authority('ro')
    const authorized = vi.spyOn(allowed, 'authorize')
    const allowedFrames: unknown[] = []
    const allowedStop = subscribeWorkspaceFileChanges(ctx, {
      authority: allowed, signal: new AbortController().signal,
      publish: (frame) => { allowedFrames.push(frame) }, fail: vi.fn(), validateRoot: async cwd => cwd,
    })
    ctx.emit('fs/observed', target, { kind: 'present', version: FsVersion('allowed') }, { agent: { session } })
    await vi.waitFor(() => { expect(allowedFrames).toHaveLength(1) })
    expect(authorized).toHaveBeenCalledWith(session.id, 'read')
    allowedStop()

    const denied = authority('ro')
    denied.authorize = async () => { throw new CollaborationError('not-member') }
    const failed = vi.fn()
    const end = subscribeWorkspaceFileChanges(ctx, {
      authority: denied, signal: new AbortController().signal,
      publish: () => {}, fail: failed, validateRoot: async cwd => cwd,
    })
    ctx.emit('fs/observed', target, { kind: 'present', version: FsVersion('v1') }, { agent: { session } })
    await vi.waitFor(() => { expect(failed).toHaveBeenCalled() })
    end()

    const overflow = vi.fn()
    const bounded = subscribeWorkspaceFileChanges(ctx, {
      authority: undefined, signal: new AbortController().signal,
      publish: () => {}, fail: overflow, validateRoot: async cwd => cwd,
    })
    ctx.emit('fs/observed', { targetKey: 'x'.repeat(9000), displayPath: root } as never, { kind: 'absent' }, { agent: { session } })
    expect(overflow).toHaveBeenCalled()
    bounded()
  })


  it('reads nested paths and rejects missing, symlinked, and wrong-kind paths', async () => {
    const { api, ctx, root, session } = await harness()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'file'), 'last line')
    symlinkSync(join(root, 'src', 'file'), join(root, 'alias'))
    const payload = { sessionId: session.id }
    const signal = new AbortController().signal
    expectOk(await api.workspaceFiles.list(request({ ...payload, path: 'src' })))
    expect(expectOk(await api.workspaceFiles.read(request({ ...payload, path: 'src/file' }), signal)).text).toBe('last line')
    expect((await api.workspaceFiles.stat(request({ ...payload, path: 'missing' }))).result).toMatchObject({ ok: false, error: { code: 'workspace-file/not-found' } })
    expect((await api.workspaceFiles.stat(request({ ...payload, path: 'alias' }))).result).toMatchObject({ ok: false, error: { code: 'workspace-file/outside-workspace' } })
    expect((await api.workspaceFiles.stat(request({ ...payload, path: 'src/file/child' }))).result.ok).toBe(false)
    expect((await api.workspaceFiles.list(request({ ...payload, path: 'src/file' }))).result).toMatchObject({ ok: false, error: { code: 'workspace-file/not-directory' } })
    const originalLstat = ctx.fs.lstat.bind(ctx.fs)
    vi.spyOn(ctx.fs, 'lstat').mockImplementation(async (path, ...args) =>
      path === 'src/file' ? { type: 'file', version: FsVersion('race') } : originalLstat(path, ...args))
    const originalResolve = ctx.fs.resolve.bind(ctx.fs)
    vi.spyOn(ctx.fs, 'resolve').mockImplementation(async (path, options) =>
      path === 'src/file/child' ? originalResolve('src/file', options) : originalResolve(path, options))
    expect((await api.workspaceFiles.stat(request({ ...payload, path: 'src/file/child' }))).result).toMatchObject({ ok: false, error: { code: 'workspace-file/not-directory' } })
    const readText = api.workspaceFiles.read.bind(api.workspaceFiles)
    const readBytes = api.workspaceFiles.readBytes.bind(api.workspaceFiles)
    for (const method of [readText, readBytes]) {
      expect((await method(request({ ...payload, path: 'src' }), signal)).result).toMatchObject({ ok: false, error: { code: 'workspace-file/not-regular-file' } })
    }
  })

  it('rejects invalid direct-call page coordinates and byte versions', async () => {
    const { api, root, session } = await harness()
    writeFileSync(join(root, 'file'), 'data')
    const payload = { sessionId: session.id, path: 'file' }
    const signal = new AbortController().signal
    expect((await api.workspaceFiles.read(request({ ...payload, offset: 0 }), signal)).result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect((await api.workspaceFiles.readBytes(request({ ...payload, offset: -1 }), signal)).result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect((await api.workspaceFiles.readBytes(request({ ...payload, version: 'stale' }), signal)).result).toMatchObject({ ok: false, error: { code: 'workspace-file/stale-version' } })
  })

  it.each([
    ['FS_NOT_FOUND', 'workspace-file/not-found'], ['FS_NOT_DIRECTORY', 'workspace-file/not-directory'],
    ['FS_NOT_REGULAR_FILE', 'workspace-file/not-regular-file'], ['FS_TOO_LARGE', 'workspace-file/too-large'],
    ['FS_STALE_VERSION', 'workspace-file/stale-version'], ['FS_ABORTED', 'cancelled'],
    ['FS_SANDBOX_DENIED', 'collaboration-forbidden'], ['FS_IO_ERROR', 'internal'],
  ] as const)('maps %s without returning provider diagnostics', async (code, expected) => {
    const { api, ctx, root, session } = await harness()
    writeFileSync(join(root, 'file'), 'data')
    vi.spyOn(ctx.fs, 'stat').mockRejectedValueOnce(new FsError('/host/private/diagnostic', code))
    const result = await api.workspaceFiles.stat(request({ sessionId: session.id, path: 'file' }))
    expect(result.result).toMatchObject({ ok: false, error: { code: expected } })
    expect(JSON.stringify(result)).not.toContain('/host/private')
  })

  it('keeps directory metadata bounded and skips invalid provider children', async () => {
    const { api, ctx, root, session } = await harness()
    writeFileSync(join(root, 'file'), 'data')
    symlinkSync(join(root, 'file'), join(root, 'alias'))
    const original = ctx.fs.listDir.bind(ctx.fs)
    vi.spyOn(ctx.fs, 'listDir').mockImplementationOnce(async (...args) => {
      const children = await original(...args)
      return [...children, { ...children[0]!, name: '../invalid' }]
    })
    const listed = expectOk(await api.workspaceFiles.list(request({ sessionId: session.id })))
    expect(listed.entries.map(entry => entry.name)).toEqual(['file'])
  })

  it('supports provider metadata without byte size and contains generic I/O failures', async () => {
    const { api, ctx, root, session } = await harness()
    writeFileSync(join(root, 'file'), 'abc')
    const stat = ctx.fs.stat.bind(ctx.fs)
    vi.spyOn(ctx.fs, 'stat').mockImplementation(async (...args) => {
      const info = await stat(...args)
      if (info === undefined || info.type !== 'file') return info
      return { type: 'file', version: info.version }
    })
    const payload = { sessionId: session.id, path: 'file' }
    expect(expectOk(await api.workspaceFiles.stat(request(payload))).bytes).toBeUndefined()
    const window = expectOk(await api.workspaceFiles.readBytes(request({ ...payload, length: 4 }), new AbortController().signal))
    expect(window.eof).toBe(true)
    vi.spyOn(ctx.fs, 'resolve').mockRejectedValueOnce(new Error('private-path'))
    expect((await api.workspaceFiles.stat(request(payload))).result).toMatchObject({ ok: false, error: { code: 'internal' } })
  })


  it('returns directory metadata and rejects a special provider type', async () => {
    const { api, ctx, root, session } = await harness()
    mkdirSync(join(root, 'dir'))
    const directory = expectOk(await api.workspaceFiles.stat(request({ sessionId: session.id, path: 'dir' })))
    expect(directory).toEqual({ path: 'dir', type: 'directory', version: directory.version })
    writeFileSync(join(root, 'other'), 'placeholder')
    const original = ctx.fs.stat.bind(ctx.fs)
    vi.spyOn(ctx.fs, 'stat').mockImplementationOnce(async (...args) => {
      const info = await original(...args)
      return info === undefined ? undefined : { ...info, type: 'other' }
    })
    expect((await api.workspaceFiles.stat(request({ sessionId: session.id, path: 'other' }))).result).toMatchObject({ ok: false, error: { code: 'workspace-file/not-regular-file' } })
  })

  it('returns an authorization error before filesystem access', async () => {
    const blocked = authority('ro')
    blocked.authorize = async () => { throw new CollaborationError('not-member') }
    const { api, ctx, root, session } = await harness({ authority: blocked })
    writeFileSync(join(root, 'file'), 'data')
    const resolve = vi.spyOn(ctx.fs, 'resolve')
    const response = await api.workspaceFiles.stat(request({ sessionId: session.id, path: 'file' }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'collaboration-forbidden' } })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('reports absent and malformed event actors without opening a stream', async () => {
    const { ctx, root, session } = await harness()
    writeFileSync(join(root, 'file'), 'data')
    const target = await ctx.fs.resolve('file')
    const published: unknown[] = []
    const stop = subscribeWorkspaceFileChanges(ctx, {
      authority: undefined, signal: new AbortController().signal,
      publish: (frame) => { published.push(frame) }, fail: () => {}, validateRoot: async cwd => cwd,
    })
    ctx.emit('fs/observed', target, { kind: 'absent' }, undefined)
    ctx.emit('fs/observed', target, { kind: 'absent' }, {})
    const other = ctx.sessions.create(SessionId('no-cwd'))
    ctx.emit('fs/observed', target, { kind: 'absent' }, { agent: { session: other } })
    await Promise.resolve()
    expect(published).toHaveLength(0)
    stop()
    void session
  })

  it('fails closed when no filesystem provider is composed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('no-fs'), { meta: { cwd: '/tmp' } })
    const api = createWorkspaceFilesApi(ctx, {
      maxBytes: undefined, maxLines: undefined, maxEntries: undefined,
      authorize: async () => ({ authority: undefined }),
      validateRoot: async (cwd: string) => cwd,
      principalSignal: (signal: AbortSignal) => signal,
    })
    const response = await api.stat(request({ sessionId: session.id, path: 'file' }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'internal' } })
    const failed = vi.fn()
    const stop = subscribeWorkspaceFileChanges(ctx, {
      authority: undefined, signal: new AbortController().signal,
      publish: () => {}, fail: failed, validateRoot: async cwd => cwd,
    })
    ctx.emit('fs/observed', { targetKey: '/tmp/no-fs', displayPath: '/tmp/no-fs' } as never,
      { kind: 'absent' }, { agent: { session } })
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
    expect(failed).not.toHaveBeenCalled()
    stop()
    await ctx.fiber.dispose()
  })

  it('rejects invalid construction limits instead of silently clamping them', async () => {
    const { ctx } = await harness()
    const options = {
      maxBytes: 0, maxLines: undefined, maxEntries: undefined,
      authorize: async () => ({ authority: undefined }),
      validateRoot: async (cwd: string) => cwd,
      principalSignal: (signal: AbortSignal) => signal,
    }
    expect(() => createWorkspaceFilesApi(ctx, options)).toThrow('maxBytes')
    expect(() => createWorkspaceFilesApi(ctx, { ...options, maxBytes: Number.MAX_SAFE_INTEGER })).toThrow('maxBytes')
  })

  it('rejects an aborted or failing change publication without leaking a raw error', async () => {
    const { ctx, root, session } = await harness()
    writeFileSync(join(root, 'file'), 'data')
    const target = await ctx.fs.resolve('file')
    const controller = new AbortController()
    const fail = vi.fn()
    const stop = subscribeWorkspaceFileChanges(ctx, {
      authority: undefined, signal: controller.signal, publish: () => { throw new Error('/private/host') }, fail, validateRoot: async cwd => cwd,
    })
    ctx.emit('fs/observed', target, { kind: 'present', version: FsVersion('v1') }, { agent: { session } })
    await vi.waitFor(() => { expect(fail).toHaveBeenCalled() })
    expect(JSON.stringify(fail.mock.calls)).not.toContain('/private/host')
    controller.abort()
    stop()
  })


  it('handles path races, unusual child metadata, and NUL content', async () => {
    const { api, ctx, root, session } = await harness()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'file'), 'data')
    writeFileSync(join(root, 'nul'), `${'x'.repeat(9000)}\0tail`)
    const originalResolve = ctx.fs.resolve.bind(ctx.fs)
    const outside = await ctx.fs.resolve('/tmp')
    vi.spyOn(ctx.fs, 'listDir').mockResolvedValueOnce([{
      name: 'outside', type: 'file', target: outside, version: FsVersion('outside'), size: 5,
    }])
    expect(expectOk(await api.workspaceFiles.list(request({ sessionId: session.id }))).entries).toEqual([])
    vi.spyOn(ctx.fs, 'listDir').mockResolvedValueOnce([{
      name: 'file', type: 'file', target: await ctx.fs.resolve('src/file'), version: FsVersion('file'),
    }])
    const lstat = ctx.fs.lstat.bind(ctx.fs)
    vi.spyOn(ctx.fs, 'lstat').mockImplementation(async (path, ...args) =>
      path === 'src/file' ? { type: 'file', version: FsVersion('file') } : lstat(path, ...args))
    expect(expectOk(await api.workspaceFiles.list(request({ sessionId: session.id, path: 'src' }))).entries[0]?.bytes).toBeUndefined()
    const hidden = await api.workspaceFiles.read(request({ sessionId: session.id, path: 'nul' }), new AbortController().signal)
    expect(hidden.result).toMatchObject({ ok: false, error: { code: 'workspace-file/not-text' } })
    vi.spyOn(ctx.fs, 'resolve').mockImplementationOnce(async (...args) => originalResolve(...args))
    vi.spyOn(ctx.fs, 'stat').mockResolvedValueOnce(undefined)
    expect((await api.workspaceFiles.stat(request({ sessionId: session.id, path: 'src/file' }))).result).toMatchObject({ ok: false, error: { code: 'workspace-file/not-found' } })
    const nested = await api.workspaceFiles.stat(request({ sessionId: session.id, path: 'src/file/child' }))
    expect(nested.result.ok).toBe(false)
  })

  it('filters changes outside the root, selects Windows relative paths, and skips an empty relative path', async () => {
    const { ctx, root, session } = await harness()
    writeFileSync(join(root, 'file'), 'data')
    const inside = await ctx.fs.resolve('file')
    const outside = await ctx.fs.resolve('/tmp')
    const frames: unknown[] = []
    const stop = subscribeWorkspaceFileChanges(ctx, {
      authority: undefined, signal: new AbortController().signal,
      publish: (frame) => { frames.push(frame) }, fail: vi.fn(), validateRoot: async cwd => cwd,
    })
    ctx.emit('fs/observed', outside, { kind: 'absent' }, { agent: { session } })
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
    expect(frames).toHaveLength(0)
    const processPath = vi.spyOn(ctx.fs, 'processPath').mockImplementation(target =>
      target.targetKey === inside.targetKey ? 'C:\\workspace\\file' : 'C:\\workspace')
    vi.spyOn(ctx.fs, 'contains').mockReturnValue(true)
    ctx.emit('fs/observed', inside, { kind: 'absent' }, { agent: { session } })
    await vi.waitFor(() => { expect(frames).toHaveLength(1) })
    expect(frames[0]).toMatchObject({ path: 'file', present: false })
    processPath.mockImplementation(() => 'C:\\workspace')
    ctx.emit('fs/observed', inside, { kind: 'present', version: FsVersion('same') }, { agent: { session } })
    await Promise.resolve()
    expect(frames).toHaveLength(1)
    processPath.mockImplementation(target =>
      target.targetKey === inside.targetKey ? 'C:\\workspace\\..\\escape' : 'C:\\workspace')
    ctx.emit('fs/observed', inside, { kind: 'present', version: FsVersion('escape') }, { agent: { session } })
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
    expect(frames).toHaveLength(1)
    stop()
  })

  it('does not report a canceled change operation and bounds pending observations', async () => {
    const { ctx, root, session } = await harness()
    const controller = new AbortController()
    let rejectRoot!: (error: unknown) => void
    const failed = vi.fn()
    const stop = subscribeWorkspaceFileChanges(ctx, {
      authority: undefined, signal: controller.signal,
      publish: () => {}, fail: failed,
      validateRoot: async () => new Promise<string>((_resolve, reject) => { rejectRoot = reject }),
    })
    const target = { targetKey: 'queued', displayPath: root } as never
    ctx.emit('fs/observed', target, { kind: 'absent' }, { agent: { session } })
    controller.abort()
    rejectRoot(new Error('canceled'))
    await Promise.resolve()
    expect(failed).not.toHaveBeenCalled()
    stop()

    const overflow = vi.fn()
    const bounded = subscribeWorkspaceFileChanges(ctx, {
      authority: undefined, signal: new AbortController().signal,
      publish: () => {}, fail: overflow, validateRoot: async cwd => cwd,
    })
    ctx.emit('fs/observed', { targetKey: 'x'.repeat(9000), displayPath: root } as never,
      { kind: 'absent' }, { agent: { session } })
    expect(overflow).toHaveBeenCalledWith(expect.any(Error))
    bounded()
  })

})
