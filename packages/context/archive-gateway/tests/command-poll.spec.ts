/** Online command delivery is independent of local Session activity and does not rescan idle history. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import ArchiveGateway from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

async function fixture(request: (path: string, init?: RequestInit) => Promise<Response>) {
  const ctx = new Context(), root = SessionId('archived-root')
  contexts.push(ctx)
  const entries = vi.fn(async () => [])
  const restore = vi.fn(async () => {})
  ctx.provide('connection', { http: { handlePrefix: () => () => {} } } as never)
  ctx.provide('gatewayRuntime', { request } as never)
  ctx.provide('workspaceRegistry', {
    archiveSnapshot: () => ({ revision: 1, archivedSessionIds: [] }), archivedEntries: entries,
    archivedSessionIds: [root], restoreSession: restore,
  } as never)
  ctx.provide('sessionPersistence', {
    list: async () => [{ header: { id: root, parentSession: undefined } }],
  } as never)
  await ctx.plugin(ArchiveGateway, { commandPollMs: 100 })
  await vi.advanceTimersByTimeAsync(0)
  return { ctx, entries, restore }
}

it('applies a remote command without a local event and keeps empty probes out of the history pipeline', async () => {
  vi.useFakeTimers()
  let pending = false
  const request = vi.fn(async (path: string) => {
    if (path.endsWith('/pending')) return json({ pending })
    if (path.endsWith('/ack')) { pending = false; return json({ acknowledged: true }) }
    return json({ commands: pending ? [{ id: 'remote-command', rootSessionId: 'archived-root', action: 'restore' }] : [] })
  })
  const { entries, restore } = await fixture(request)
  expect(entries).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(300)
  expect(request.mock.calls.filter(([path]) => path.endsWith('/pending'))).toHaveLength(3)
  expect(entries).toHaveBeenCalledOnce()
  pending = true
  await vi.advanceTimersByTimeAsync(100)
  expect(restore).toHaveBeenCalledWith('archived-root')
  expect(request.mock.calls.some(([path]) => path.endsWith('/ack'))).toBe(true)
  expect(pending).toBe(false)
})

it('never overlaps probes and aborts an outstanding probe before disposal completes', async () => {
  vi.useFakeTimers()
  const started: AbortSignal[] = []
  const waiting = Promise.withResolvers<Response>()
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (!path.endsWith('/pending')) return json({ commands: [] })
    const signal = init?.signal
    if (signal === undefined || signal === null) throw new Error('Probe must own cancellation')
    started.push(signal)
    signal.addEventListener('abort', () => { waiting.reject(new Error('aborted probe')) }, { once: true })
    return waiting.promise
  })
  const { ctx } = await fixture(request)
  await vi.advanceTimersByTimeAsync(100)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(started).toHaveLength(1)
  await ctx.fiber.dispose()
  expect(started[0]?.aborted).toBe(true)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(started).toHaveLength(1)
})

it.each([null, { pending: 'yes' }, [], 'http-failure', 'empty-http-failure'])('retries after an invalid probe without applying commands (%j)', async (bad) => {
  vi.useFakeTimers()
  let attempts = 0
  const request = vi.fn(async (path: string) => {
    if (!path.endsWith('/pending')) return json({ commands: [] })
    attempts++
    if (attempts > 1) return json({ pending: false })
    if (bad === 'http-failure') return new Response('unavailable', { status: 503 })
    if (bad === 'empty-http-failure') return new Response(null, { status: 503 })
    return json(bad)
  })
  const { entries, restore } = await fixture(request)
  await vi.advanceTimersByTimeAsync(200)
  expect(attempts).toBe(2)
  expect(entries).toHaveBeenCalledOnce()
  expect(restore).not.toHaveBeenCalled()
})
