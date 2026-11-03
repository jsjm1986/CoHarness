/** Model catalog invalidation and reconnects stay with the owning Runtime. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { createScope, createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import { ModelDirectoryResolver } from '../src/client/service.ts'

function events() {
  const listeners = new Map<string, Set<() => void>>()
  return {
    $on: (event: string, listener: () => void) => {
      const set = listeners.get(event) ?? new Set<() => void>()
      listeners.set(event, set); set.add(listener)
      return () => { set.delete(listener) }
    },
    dispatch: (event: string) => { for (const listener of [...listeners.get(event) ?? []]) listener() },
  }
}

it('does not reload another computer after model changes or a reconnect, and releases per-Session subscriptions', async () => {
  const ctx = new Context(), a = 'a' as SessionId, b = 'b' as SessionId
  const first = createScope(ctx, a), second = createScope(ctx, b)
  const target: SessionRuntimeTarget = { kind: 'personal', runtimeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as never }
  const models = () => vi.fn(async () => ({ result: { ok: true, value: { current: null, routable: true, groups: [], failures: [] } } }))
  const modelsA = models(), modelsB = models(), baseEvents = events(), remoteEvents = events()
  const state = createSnapshotStore<'connected' | 'disconnected'>('connected'), start = vi.fn()
  const other = { api: { sessions: { models: modelsB } }, state, start }
  ctx.provide('connection', { api: { sessions: { models: modelsA } }, forTarget: () => other, start } as never)
  ctx.provide('remote', { $forTarget: (owner?: SessionRuntimeTarget) => owner === undefined ? baseEvents : remoteEvents } as never)
  ctx.provide('sessions', { scope: (id: SessionId) => id === a ? first.ctx : second.ctx,
    runtimeTargetFor: (id: SessionId) => id === b ? target : undefined, subagentAddress: () => undefined } as never)
  const resolver = new ModelDirectoryResolver(ctx, { blockReason: () => 'Unavailable' })
  try {
    const directoryA = resolver.directoryFor(a), directoryB = resolver.directoryFor(b)
    await Promise.all([directoryA.load(), directoryB.load()])
    remoteEvents.dispatch('llm/adapters-updated')
    await vi.waitFor(() => { expect(modelsB).toHaveBeenCalledTimes(2) })
    expect(modelsA).toHaveBeenCalledOnce()
    ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(modelsA).toHaveBeenCalledTimes(2) })
    expect(modelsB).toHaveBeenCalledTimes(2)
    state.set('disconnected'); state.set('connected')
    await vi.waitFor(() => { expect(modelsB).toHaveBeenCalledTimes(3) })
    expect(modelsA).toHaveBeenCalledTimes(2)
    await second.fiber.dispose()
    remoteEvents.dispatch('settings/document-updated')
    expect(modelsB).toHaveBeenCalledTimes(3)
    expect(start).not.toHaveBeenCalled()
  } finally { await second.fiber.dispose(); await first.fiber.dispose(); await ctx.fiber.dispose() }
})
