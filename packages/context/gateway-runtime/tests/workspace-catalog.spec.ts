/** Settled Workspace metadata publication, coalescing and scope-owned cancellation. @module */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import type { GatewayRuntime } from '../src/index.ts'
import { publishWorkspaceCatalog } from '../src/workspace-catalog.ts'
import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy/api'

it('publishes personal roots, including ungrouped histories, without archived rows or log contents', async () => {
  const ctx = new Context()
  await ctx.plugin(() => {}).await()
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: ['archived'] } as never)
  const published = Promise.withResolvers<Record<string, unknown>>()
  const request = vi.fn(async (_url: string, init: RequestInit) => {
    published.resolve(JSON.parse(init.body as string) as Record<string, unknown>)
    return Response.json({ synchronized: true })
  })
  const root = { sessionId: 'ungrouped', cwd: '/home/me', updatedAt: 1, running: true, blank: false,
    visibleContentSeq: 4, projections: { asOfSeq: 4, values: { title: 'Personal title', sessionListMetadata: { blank: false, visibleContentSeq: 4, lastPromptAt: 1 } } } }
  const read = vi.fn(async () => [root, { ...root, sessionId: 'archived' },
    { ...root, sessionId: 'child', parentSessionId: 'ungrouped' }, { ...root, sessionId: 'agent', origin: 'subagent' }] as unknown as SessionSummary[])
  try {
    publishWorkspaceCatalog(ctx, { request } as unknown as GatewayRuntime, 1000, read)
    expect(await published.promise).toEqual({ revision: 1, items: [], conversations: [{ sessionId: 'ungrouped',
      cwd: '/home/me', updatedAt: 1, blank: false, visibleContentSeq: 4, title: 'Personal title', lastPromptAt: 1 }] })
    expect(read).toHaveBeenCalledOnce()
  } finally { await ctx.fiber.dispose() }
})

it('coalesces registry changes behind one publication and publishes only the latest metadata', async () => {
  const ctx = new Context()
  let title = 'First', resolve!: (value: Response) => void
  const pending = new Promise<Response>((done) => { resolve = done })
  const request = vi.fn().mockImplementationOnce(() => pending).mockResolvedValue(new Response(null, { status: 200 }))
  ctx.provide('workspaceRegistry', { list: () => [{ id: 'work', path: '/work', title, sessionIds: ['session'],
    createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' }] } as never)
  await ctx.plugin(() => {}).await()
  try {
    publishWorkspaceCatalog(ctx, { request } as unknown as GatewayRuntime, 1000)
    expect(request).toHaveBeenCalledOnce()
    title = 'Second'; ctx.emit('workspace/catalog-changed')
    title = 'Latest'; ctx.emit('workspace/catalog-changed')
    expect(request).toHaveBeenCalledOnce()
    resolve(new Response(null, { status: 200 }))
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(2) })
    const [path, init] = request.mock.calls[1] as [string, RequestInit]
    expect(path).toBe('/internal/runtime/workspace/catalog')
    expect(JSON.parse(init.body as string)).toEqual({ revision: 2, items: [{ workspaceId: 'work', path: '/work', title: 'Latest',
      sessionIds: ['session'], createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' }] })
  } finally { await ctx.fiber.dispose() }
})

it('aborts and settles an in-flight publication before disposing the registry scope', async () => {
  const ctx = new Context()
  let signal: AbortSignal | undefined
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  await ctx.plugin(() => {}).await()
  const request = vi.fn((_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    signal = init.signal ?? undefined
    signal!.addEventListener('abort', () => { reject(signal!.reason as Error) }, { once: true })
  }))
  publishWorkspaceCatalog(ctx, { request } as unknown as GatewayRuntime, 1000)
  await ctx.fiber.dispose()
  expect(signal?.aborted).toBe(true)
  expect(request).toHaveBeenCalledOnce()
})

it('keeps publication revisions newer than the accepted catalog after registry scope remount', async () => {
  const ctx = new Context()
  let title = 'First', accepted = { revision: 0, title: '' }
  const revisions: number[] = []
  ctx.provide('workspaceRegistry', { list: () => [{ id: 'work', path: '/work', title, sessionIds: [],
    createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' }] } as never)
  const request = vi.fn(async (_path: string, init: RequestInit) => {
    const value = JSON.parse(init.body as string) as { revision: number; items: { title: string }[] }
    revisions.push(value.revision)
    if (value.revision > accepted.revision) accepted = { revision: value.revision, title: value.items[0]!.title }
    return new Response(null, { status: 200 })
  })
  const runtime = { request } as unknown as GatewayRuntime
  const mount = () => ctx.inject(['workspaceRegistry'], (scope) => { publishWorkspaceCatalog(scope, runtime, 1000) })
  try {
    const first = mount()
    await first.await()
    title = 'Before remount'
    ctx.emit('workspace/catalog-changed')
    await vi.waitFor(() => { expect(accepted.title).toBe('Before remount') })
    await first.dispose()
    title = 'After remount'
    const replacement = mount()
    await replacement.await()
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(3) })
    expect(revisions).toEqual([1, 2, 3])
    expect(accepted.title).toBe('After remount')
  } finally { await ctx.fiber.dispose() }
})

it('gives a replacement transport a newer revision than an abandoned old publication', async () => {
  const ctx = new Context()
  let title = 'Old', accepted = { revision: 0, title: '' }
  const late = Promise.withResolvers<undefined>()
  const settled = Promise.withResolvers<undefined>()
  const commit = (value: { revision: number; items: { title: string }[] }): void => {
    if (value.revision > accepted.revision) accepted = { revision: value.revision, title: value.items[0]!.title }
  }
  ctx.provide('workspaceRegistry', { list: () => [{ id: 'work', path: '/work', title, sessionIds: [],
    createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' }] } as never)
  let oldCommit: Promise<void> | undefined
  const oldRequest = vi.fn((_path: string, init: RequestInit) => {
    const value = JSON.parse(init.body as string) as { revision: number; items: { title: string }[] }
    oldCommit = late.promise.then(() => { commit(value) })
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => { reject(init.signal!.reason as Error) }, { once: true })
    })
  })
  const replacementRequest = vi.fn(async (_path: string, init: RequestInit) => {
    commit(JSON.parse(init.body as string) as { revision: number; items: { title: string }[] })
    settled.resolve(undefined)
    return new Response(null, { status: 200 })
  })
  try {
    const first = ctx.inject(['workspaceRegistry'], (scope) => { publishWorkspaceCatalog(scope, { request: oldRequest } as unknown as GatewayRuntime, 1000) })
    await first.await()
    expect(oldRequest).toHaveBeenCalledOnce()
    await first.dispose()
    title = 'Current'
    const replacement = ctx.inject(['workspaceRegistry'], (scope) => {
      publishWorkspaceCatalog(scope, { request: replacementRequest } as unknown as GatewayRuntime, 1000)
    })
    await replacement.await()
    await settled.promise
    expect(accepted).toEqual({ revision: 2, title: 'Current' })
    late.resolve(undefined)
    await oldCommit
    expect(accepted).toEqual({ revision: 2, title: 'Current' })
  } finally {
    late.resolve(undefined)
    await oldCommit
    await ctx.fiber.dispose()
  }
})

it('stops publication at the safe-integer limit without wrapping its ordering', async () => {
  const ctx = new Context(), request = vi.fn(async () => new Response(null, { status: 200 }))
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  try {
    publishWorkspaceCatalog(ctx, { request } as unknown as GatewayRuntime, 1000)
    await vi.waitFor(() => { expect(request).toHaveBeenCalledOnce() })
    ctx.root.get('gatewayWorkspaceCatalogRevision')!.value = Number.MAX_SAFE_INTEGER
    ctx.emit('workspace/catalog-changed')
    await vi.waitFor(() => { expect(error).toHaveBeenCalledWith(expect.any(String), expect.any(RangeError)) })
    expect(request).toHaveBeenCalledOnce()
    expect(ctx.root.get('gatewayWorkspaceCatalogRevision')!.value).toBe(Number.MAX_SAFE_INTEGER)
  } finally {
    await ctx.fiber.dispose()
    error.mockRestore()
  }
})

it('keeps publication ordering independent between application roots', async () => {
  const roots = [new Context(), new Context()]
  const revisions: number[] = []
  try {
    for (const ctx of roots) {
      ctx.provide('workspaceRegistry', { list: () => [] } as never)
      publishWorkspaceCatalog(ctx, { request: async (_path: string, init: RequestInit) => {
        revisions.push((JSON.parse(init.body as string) as { revision: number }).revision)
        return new Response(null, { status: 200 })
      } } as unknown as GatewayRuntime, 1000)
    }
    expect(revisions).toEqual([1, 1])
    expect(roots[0]!.get('gatewayWorkspaceCatalogRevision')).not.toBe(roots[1]!.get('gatewayWorkspaceCatalogRevision'))
  } finally { await Promise.all(roots.map(ctx => ctx.fiber.dispose())) }
})

it('retries pending metadata after a refused publication with a newer revision', async () => {
  const ctx = new Context(), first = Promise.withResolvers<Response>()
  let title = 'Old'
  const request = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(new Response(null, { status: 200 }))
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  ctx.provide('workspaceRegistry', { list: () => [{ id: 'work', path: '/work', title, sessionIds: [],
    createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' }] } as never)
  try {
    publishWorkspaceCatalog(ctx, { request } as unknown as GatewayRuntime, 1000)
    title = 'Latest'
    ctx.emit('workspace/catalog-changed')
    first.resolve(new Response(null, { status: 503 }))
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(2) })
    const init = request.mock.calls[1]![1] as RequestInit
    expect(JSON.parse(init.body as string)).toMatchObject({ revision: 2, items: [{ title: 'Latest' }] })
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: 'Workspace catalog publication returned HTTP 503' }))
  } finally {
    first.resolve(new Response(null, { status: 503 }))
    await ctx.fiber.dispose()
    error.mockRestore()
  }
})

it('does not reopen publication when abort cleanup changes the registry', async () => {
  const ctx = new Context()
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  const request = vi.fn((_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => {
      ctx.emit('workspace/catalog-changed')
      reject(init.signal!.reason as Error)
    }, { once: true })
  }))
  publishWorkspaceCatalog(ctx, { request } as unknown as GatewayRuntime, 1000)
  await ctx.fiber.dispose()
  expect(request).toHaveBeenCalledOnce()
})
