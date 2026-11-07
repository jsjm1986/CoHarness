/** Failed one-shot cleanup must finish before another exact-parent provider admission. */
import { Context, FiberState } from '@deepseek-ai/cordis'
import AgentRegistry, { agentCarrier } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, expect, it, vi } from 'vitest'
import SubagentRuntime from '../src/index.ts'
import { withSubagentForeground } from '../src/internal.ts'
import type { SubagentProvider, SubagentRun, SubagentStartRequest } from '../src/types.ts'
import { createSubagentCleanupRecovery } from '../src/retained-cleanup.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  provideWorkingDirectoryFixture(ctx)
  const service = ctx.plugin(SubagentRuntime)
  await service.await()
  const parent = (id: string): Agent => ({ id: SessionId(id), ctx: ctx.plugin(() => {}).ctx,
    session: Session.create(SessionId(id)), options: {} } as unknown as Agent)
  const request = (owner: Agent, signal = new AbortController().signal): SubagentStartRequest => ({
    parent: owner, signal, prompt: [{ type: 'text', text: 'work' }],
  })
  return { ctx, parent, request, service }
}

it.each(['published', 'catalog-failure'] as const)('retries retained cleanup and blocks allocation after %s failure', async (mode) => {
  const { ctx, parent, request } = await fixture(), owner = parent('cleanup-owner')
  let starts = 0, attempts = 0, allowCleanup = false, oldResourceLive = false
  const cleanupFailure = Object.create(null) as object
  const catalogFailure = new Error('catalog storage unavailable')
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const raw: SubagentRun[] = []
  ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: () => {
      const ordinal = ++starts
      if (ordinal === 1) oldResourceLive = true
      else expect(oldResourceLive).toBe(false)
      const run: SubagentRun = { id: SessionId(`child-${ordinal}`), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: () => {
          if (ordinal === 1) {
            attempts++
            if (!allowCleanup) throw cleanupFailure
            oldResourceLive = false
          }
          return Promise.resolve(undefined)
        } }
      raw.push(run)
      return Promise.resolve(run)
    } })
  let first: SubagentRun | undefined
  try {
    if (mode === 'catalog-failure') {
      vi.spyOn(owner.session, 'append').mockImplementationOnce(() => { throw catalogFailure })
      await expect(ctx.subagents.start('child', request(owner))).rejects.toBe(catalogFailure)
      expect(warn).toHaveBeenCalled()
    } else {
      first = await ctx.subagents.start('child', request(owner))
      await expect(Promise.resolve(undefined).then(() => first!.dispose())).rejects.toBe(cleanupFailure)
      void ctx.subagents.retainFailedCleanup(owner, first)
    }
    expect(attempts).toBe(1)
    expect(ctx.bail(agentCarrier(owner), 'agent/idle-release-check', { agent: owner })).toBe('busy')
    await expect(ctx.subagents.start('child', request(owner))).rejects.toThrow('cleanup')
    expect(starts).toBe(1)
    expect(attempts).toBe(2)
    expect(oldResourceLive).toBe(true)
    allowCleanup = true
    const next = await ctx.subagents.start('child', request(owner))
    expect(attempts).toBe(3)
    expect(starts).toBe(2)
    await first?.dispose()
    expect(attempts).toBe(3)
    await next.dispose()
    expect(ctx.bail(agentCarrier(owner), 'agent/idle-release-check', { agent: owner })).toBeUndefined()
  } finally {
    allowCleanup = true
    await Promise.allSettled(raw.map(run => Promise.resolve(undefined).then(() => run.dispose())))
    warn.mockRestore()
  }
})

it.each(['refused', 'recovered'] as const)('rechecks cleanup handed back during the retry-listener snapshot: %s', async (mode) => {
  const { ctx, parent, request } = await fixture(), owner = parent('reentrant-cleanup-owner')
  let starts = 0, attempts = 0, live = false, allowCleanup = false, transferred = false
  ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => {
      const ordinal = ++starts
      if (ordinal === 1) live = true
      else expect(live).toBe(false)
      return { id: SessionId(`reentrant-child-${ordinal}`), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => {
          if (ordinal !== 1) return
          attempts++
          if (!allowCleanup) throw new Error('original child remains live')
          live = false
        } }
    } })
  const first = await ctx.subagents.start('child', request(owner))
  let confirmation: Promise<void> | undefined, next: SubagentRun | undefined
  try {
    await expect(first.dispose()).rejects.toThrow('original child remains live')
    ctx.on('subagent/cleanup-retry', (target) => {
      if (target !== owner || transferred) return
      transferred = true
      confirmation = ctx.subagents.retainFailedCleanup(owner, first)
    }, { global: true })
    allowCleanup = mode === 'recovered'
    if (mode === 'refused') {
      await expect(ctx.subagents.start('child', request(owner))).rejects.toThrow('cleanup is unconfirmed')
      expect(starts).toBe(1)
      expect(attempts).toBe(2)
      expect(live).toBe(true)
      expect(ctx.bail(agentCarrier(owner), 'agent/idle-release-check', { agent: owner })).toBe('busy')
      allowCleanup = true
    }
    next = await ctx.subagents.start('child', request(owner))
    await confirmation
    expect(transferred).toBe(true)
    expect(starts).toBe(2)
    expect(attempts).toBe(mode === 'refused' ? 3 : 2)
    await next.dispose()
    expect(ctx.bail(agentCarrier(owner), 'agent/idle-release-check', { agent: owner })).toBeUndefined()
  } finally {
    allowCleanup = true
    await Promise.allSettled([first.dispose(), next?.dispose(), confirmation])
  }
})

it.each(['published', 'catalog-failure'] as const)('retains exact-parent recovery across a runtime replacement after %s failure', async (mode) => {
  const { ctx, parent, request, service } = await fixture(), owner = parent('replacement-cleanup-owner')
  const original = ctx.subagents
  let starts = 0, live = false, allowCleanup = false
  const raw: SubagentRun[] = []
  const provider: SubagentProvider = { name: 'replacement-child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => {
      const ordinal = ++starts
      if (ordinal === 1) live = true
      const run: SubagentRun = { id: SessionId(`replacement-child-${ordinal}`), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => {
          if (ordinal !== 1) return
          if (!allowCleanup) throw new Error('original child remains live')
          live = false
        } }
      raw.push(run)
      return run
    } }
  original.registerProvider(provider)
  let first: SubagentRun | undefined
  try {
    if (mode === 'catalog-failure') {
      vi.spyOn(owner.session, 'append').mockImplementationOnce(() => { throw new Error('catalog unavailable') })
      await expect(original.start(provider.name, request(owner))).rejects.toThrow('catalog unavailable')
    } else {
      first = await original.start(provider.name, request(owner))
      await expect(first.dispose()).rejects.toThrow('remains live')
      void original.retainFailedCleanup(owner, first)
    }
    await Promise.allSettled([service.dispose()])
    const busy = ctx.bail(agentCarrier(owner), 'agent/idle-release-check', { agent: owner }) === 'busy'
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider(provider)
    const refused = await Promise.allSettled([ctx.subagents.start(provider.name, request(owner))])
    expect({ busy, state: refused[0].status, starts, live })
      .toEqual({ busy: true, state: 'rejected', starts: 1, live: true })
    const unrelated = parent('unrelated-replacement-owner')
    const other = await ctx.subagents.start(provider.name, request(unrelated))
    await other.dispose()
    expect(live).toBe(true)
    allowCleanup = true
    const next = await ctx.subagents.start(provider.name, request(owner))
    expect(live).toBe(false)
    expect(starts).toBe(3)
    await next.dispose()
    expect(ctx.bail(agentCarrier(owner), 'agent/idle-release-check', { agent: owner })).toBeUndefined()
  } finally {
    allowCleanup = true
    await first?.dispose()
    await Promise.allSettled(raw.map(run => run.dispose()))
  }
})

it('confirms retained cleanup only after original resource release', async () => {
  const { ctx, parent, request } = await fixture(), owner = parent('release-owner')
  let allowCleanup = false, confirmed = false
  ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => ({ id: SessionId('release-child'), localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed' }),
      dispose: async () => { if (!allowCleanup) throw new Error('resource still live') } }) })
  const run = await ctx.subagents.start('child', request(owner))
  try {
    await expect(run.dispose()).rejects.toThrow('resource still live')
    const released = ctx.subagents.retainFailedCleanup(owner, run)
    expect(ctx.subagents.retainFailedCleanup(owner, run)).toBe(released)
    void released.then(() => { confirmed = true })
    await expect(run.dispose()).rejects.toThrow('resource still live')
    expect(confirmed).toBe(false)
    allowCleanup = true
    await run.dispose()
    await released
    expect(confirmed).toBe(true)
    await ctx.subagents.retainFailedCleanup(owner, run)
  } finally {
    allowCleanup = true
    await run.dispose()
  }
})

it('keeps untouched concurrent runs with their holders', async () => {
  const { ctx, parent, request } = await fixture(), owner = parent('live-owner')
  const disposed: number[] = []
  let starts = 0
  ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => {
      const ordinal = ++starts
      return { id: SessionId(`live-child-${ordinal}`), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => { disposed.push(ordinal) } }
    } })
  const first = await ctx.subagents.start('child', request(owner))
  const second = await ctx.subagents.start('child', request(owner))
  expect(starts).toBe(2)
  expect(disposed).toEqual([])
  try {
    await first.dispose()
    void ctx.subagents.retainFailedCleanup(owner, first)
    expect(disposed).toEqual([1])
    expect(ctx.bail(agentCarrier(owner), 'agent/idle-release-check', { agent: owner })).toBe('busy')
    await second.dispose()
    expect(disposed).toEqual([1, 2])
    expect(ctx.bail(agentCarrier(owner), 'agent/idle-release-check', { agent: owner })).toBeUndefined()
  } finally { await first.dispose(); await second.dispose() }
})

it.each(['refused', 'recovered'] as const)('rechecks newly transferred cleanup while admission is waiting: %s', async (mode) => {
  const { ctx, parent, request } = await fixture(), owner = parent('queued-owner')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let starts = 0, firstAttempts = 0, secondAttempts = 0, allowSecond = false
  const live = new Set<number>()
  const handles: SubagentRun[] = []
  ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => {
      const id = ++starts
      if (id > 2) expect(live.has(2)).toBe(false)
      live.add(id)
      return { id: SessionId(`queued-child-${id}`), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => {
          if (id === 1 && live.has(id)) {
            if (++firstAttempts === 1) throw new Error('first cleanup unconfirmed')
            entered.resolve(undefined)
            await release.promise
          }
          if (id === 2 && live.has(id)) {
            secondAttempts++
            if (!allowSecond) throw new Error('second cleanup unconfirmed')
          }
          live.delete(id)
        } }
    } })
  const first = await ctx.subagents.start('child', request(owner))
  const second = await ctx.subagents.start('child', request(owner))
  handles.push(first, second)
  let pending: Promise<SubagentRun> | undefined
  try {
    await expect(first.dispose()).rejects.toThrow('first cleanup unconfirmed')
    void ctx.subagents.retainFailedCleanup(owner, first)
    pending = ctx.subagents.start('child', request(owner))
    const result = Promise.allSettled([pending])
    await entered.promise
    await expect(second.dispose()).rejects.toThrow('second cleanup unconfirmed')
    void ctx.subagents.retainFailedCleanup(owner, second)
    allowSecond = mode === 'recovered'
    release.resolve(undefined)
    const settled = (await result)[0]
    if (settled.status === 'fulfilled') handles.push(settled.value)
    if (mode === 'refused') {
      expect(settled.status).toBe('rejected')
      expect(starts).toBe(2)
      expect(live.has(2)).toBe(true)
    } else {
      expect(settled.status).toBe('fulfilled')
      expect(starts).toBe(3)
      expect(live.has(2)).toBe(false)
    }
    expect(secondAttempts).toBe(2)
  } finally {
    allowSecond = true
    release.resolve(undefined)
    await pending?.then(run => run.dispose(), () => {})
    await Promise.all(handles.map(run => run.dispose()))
  }
})

it.each(['refused', 'recovered'] as const)('rechecks late retired-runtime cleanup while replacement admission waits: %s', async (mode) => {
  const { ctx, parent, request, service } = await fixture(), owner = parent('queued-owner')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let starts = 0, firstAttempts = 0, secondAttempts = 0, allowSecond = false
  const live = new Set<number>()
  const handles: SubagentRun[] = []
  const provider: SubagentProvider = { name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => {
      const id = ++starts
      if (id > 2) expect(live.has(2)).toBe(false)
      live.add(id)
      return { id: SessionId(`queued-child-${id}`), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => {
          if (id === 1 && live.has(id)) {
            if (++firstAttempts <= 2) throw new Error('first cleanup unconfirmed')
            entered.resolve(undefined)
            await release.promise
          }
          if (id === 2 && live.has(id)) {
            secondAttempts++
            if (!allowSecond) throw new Error('second cleanup unconfirmed')
          }
          live.delete(id)
        } }
    } }
  ctx.subagents.registerProvider(provider)
  const original = ctx.subagents
  const first = await ctx.subagents.start('child', request(owner))
  const second = await ctx.subagents.start('child', request(owner))
  handles.push(first, second)
  let pending: Promise<SubagentRun> | undefined
  try {
    await expect(first.dispose()).rejects.toThrow('first cleanup unconfirmed')
    void original.retainFailedCleanup(owner, first)
    await service.dispose()
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider(provider)
    pending = ctx.subagents.start('child', request(owner))
    const result = Promise.allSettled([pending])
    await entered.promise
    await expect(second.dispose()).rejects.toThrow('second cleanup unconfirmed')
    void original.retainFailedCleanup(owner, second)
    allowSecond = mode === 'recovered'
    release.resolve(undefined)
    const settled = (await result)[0]
    if (settled.status === 'fulfilled') handles.push(settled.value)
    if (mode === 'refused') {
      expect(settled.status).toBe('rejected')
      expect(starts).toBe(2)
      expect(live.has(2)).toBe(true)
    } else {
      expect(settled.status).toBe('fulfilled')
      expect(starts).toBe(3)
      expect(live.has(2)).toBe(false)
    }
    expect(secondAttempts).toBe(2)
  } finally {
    allowSecond = true
    release.resolve(undefined)
    await pending?.then(run => run.dispose(), () => {})
    await Promise.all(handles.map(run => run.dispose()))
  }
})

it.each(['current', 'replaced', 'removed'] as const)(
  'shares cleanup and rechecks cancellation and a %s provider before dispatch', async (providerState) => {
    const { ctx, parent, request } = await fixture(), owner = parent('concurrent-owner')
    const release = Promise.withResolvers<undefined>(), retryStarted = Promise.withResolvers<undefined>()
    let starts = 0, attempts = 0
    const remove = ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      start: async () => {
        const ordinal = ++starts
        return { id: SessionId(`child-${ordinal}`), localAgent: undefined,
          result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {
            if (ordinal !== 1) return
            attempts++
            if (attempts === 1) throw new Error('transport still open')
            retryStarted.resolve(undefined)
            await release.promise
          } }
      } })
    const first = await ctx.subagents.start('child', request(owner))
    await expect(first.dispose()).rejects.toThrow('transport still open')
    void ctx.subagents.retainFailedCleanup(owner, first)
    const cancelled = new AbortController(), reason = new Error('new delegation cancelled')
    const one = ctx.subagents.start('child', request(owner, cancelled.signal))
    const two = ctx.subagents.start('child', request(owner))
    const results = Promise.allSettled([one, two])
    try {
      const firstAction = await Promise.race([
        retryStarted.promise.then(() => 'cleanup'), results.then(() => 'dispatched'),
      ])
      expect(firstAction).toBe('cleanup')
      const same = first.dispose()
      expect(first.dispose()).toBe(same)
      expect(starts).toBe(1)
      expect(attempts).toBe(2)
      expect(ctx.bail(agentCarrier(owner), 'agent/idle-release-check', { agent: owner })).toBe('busy')
      if (providerState !== 'current') {
        remove()
        if (providerState === 'replaced') ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
          capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
          start: async () => { starts++; return { id: SessionId('replacement-child'), localAgent: undefined,
            result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} } } })
      }
      cancelled.abort(reason)
      release.resolve(undefined)
      const settled = await results
      expect(settled[0]).toEqual({ status: 'rejected', reason })
      if (providerState === 'current') {
        expect(settled[1].status).toBe('fulfilled')
        expect(starts).toBe(2)
        if (settled[1].status === 'fulfilled') await settled[1].value.dispose()
      } else {
        expect(settled[1].status).toBe('rejected')
        if (settled[1].status === 'rejected') expect(settled[1].reason).toMatchObject({ code: 'PROVIDER_CHANGED' })
        expect(starts).toBe(1)
      }
      await same
      expect(attempts).toBe(2)
      expect(ctx.bail(agentCarrier(owner), 'agent/idle-release-check', { agent: owner })).toBeUndefined()
    } finally { release.resolve(undefined); await results; await first.dispose() }
  },
)

it('keeps failed cleanup with its exact parent while other parents and replacements delegate', async () => {
  const { ctx, parent, request } = await fixture(), original = parent('same-id')
  const other = parent('other-id'), replacement = parent('same-id')
  let attempts = 0, allowCleanup = false
  ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async spec => ({ id: SessionId(`child-${spec.parent === original ? 'old' : spec.parent === other ? 'other' : 'new'}`),
      localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {
        if (spec.parent !== original) return
        attempts++
        if (!allowCleanup) throw new Error('old parent cleanup pending')
      } }) })
  const old = await ctx.subagents.start('child', request(original))
  await expect(old.dispose()).rejects.toThrow('old parent cleanup pending')
  expect(() => { void ctx.subagents.retainFailedCleanup(replacement, old) }).toThrow('parent')
  void ctx.subagents.retainFailedCleanup(original, old)
  try {
    const unrelated = await ctx.subagents.start('child', request(other))
    const current = await ctx.subagents.start('child', request(replacement))
    expect(attempts).toBe(1)
    await unrelated.dispose(); await current.dispose()
    expect(ctx.bail(agentCarrier(original), 'agent/idle-release-check', { agent: original })).toBe('busy')
    expect(ctx.bail(agentCarrier(replacement), 'agent/idle-release-check', { agent: replacement })).toBeUndefined()
  } finally { allowCleanup = true; await old.dispose() }
})

it('leaves failed holder-owned runs with their controllers during another admission', async () => {
  const { ctx, parent, request } = await fixture(), owner = parent('holder-owner')
  let starts = 0, attempts = 0, allowCleanup = false
  ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => {
      const ordinal = ++starts
      return { id: SessionId(`holder-child-${ordinal}`), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {
          if (ordinal !== 1) return
          attempts++
          if (!allowCleanup) throw new Error('holder owns cleanup retry')
        } }
    } })
  const first = await ctx.subagents.start('child', request(owner))
  await expect(first.dispose()).rejects.toThrow('holder owns cleanup retry')
  try {
    const second = await ctx.subagents.start('child', request(owner))
    expect(starts).toBe(2)
    expect(attempts).toBe(1)
    await second.dispose()
  } finally { allowCleanup = true; await first.dispose() }
})

it('joins handed-back cleanup before its service scope disappears', async () => {
  const { ctx, parent, request, service } = await fixture(), owner = parent('unload-owner')
  let resourceLive = true, allowCleanup = false, attempts = 0
  ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => ({ id: SessionId('unload-child'), localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {
        attempts++
        if (!allowCleanup) throw new Error('cleanup unavailable')
        resourceLive = false
      } }) })
  const runtime = ctx.subagents, run = await runtime.start('child', request(owner))
  await expect(run.dispose()).rejects.toThrow('cleanup unavailable')
  void runtime.retainFailedCleanup(owner, run)
  allowCleanup = true
  await service.dispose()
  expect(resourceLive).toBe(false)
  expect(attempts).toBe(2)
  await run.dispose()
  expect(attempts).toBe(2)
})

it.each(['service', 'root'] as const)('joins cleanup handed back while its %s scope is already draining', async (scope) => {
  const { ctx, parent, request, service } = await fixture(), owner = parent('draining-owner')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const live = new Set<number>(), attempts = [0, 0]
  let starts = 0, allowCleanup = false
  ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => {
      const ordinal = starts++
      live.add(ordinal)
      return { id: SessionId(`draining-child-${ordinal}`), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {
          attempts[ordinal] = (attempts[ordinal] ?? 0) + 1
          if (!allowCleanup) throw new Error('cleanup unavailable')
          if (ordinal === 0) { entered.resolve(undefined); await release.promise }
          live.delete(ordinal)
        } }
    } })
  const runtime = ctx.subagents
  const first = await runtime.start('child', request(owner))
  const second = await runtime.start('child', request(owner))
  let unloading: Promise<void> | undefined
  try {
    await expect(first.dispose()).rejects.toThrow('cleanup unavailable')
    void runtime.retainFailedCleanup(owner, first)
    await expect(second.dispose()).rejects.toThrow('cleanup unavailable')
    allowCleanup = true
    unloading = scope === 'service' ? service.dispose() : ctx.fiber.dispose()
    await entered.promise
    void runtime.retainFailedCleanup(owner, second)
    expect(ctx.bail(agentCarrier(owner), 'agent/idle-release-check', { agent: owner })).toBe('busy')
    release.resolve(undefined)
    await unloading
    expect(live.size).toBe(0)
    expect(attempts).toEqual([2, 2])
    expect(ctx.bail(agentCarrier(owner), 'agent/idle-release-check', { agent: owner })).toBeUndefined()
  } finally {
    allowCleanup = true
    release.resolve(undefined)
    await unloading
    await first.dispose(); await second.dispose()
  }
})

it.each(['live', 'retired'] as const)('drains retained cleanup before the original parent leaves its %s runtime', async (phase) => {
  const { ctx, parent, request, service } = await fixture(), owner = parent('departing-owner')
  const runtime = ctx.subagents
  const closing = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
  let allowCleanup = false, live = true, attempts = 0, departed = false
  const reported = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  runtime.registerProvider({ name: 'departing-child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => ({ id: SessionId('departing-child'), localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {
        attempts++
        if (!allowCleanup) throw new Error('original resource is live')
        closing.resolve(undefined)
        await finish.promise
        live = false
      } }) })
  const run = await runtime.start('departing-child', request(owner))
  let withdrawal: Promise<void> | undefined
  try {
    await expect(run.dispose()).rejects.toThrow('original resource is live')
    const confirmation = runtime.retainFailedCleanup(owner, run)
    if (phase === 'retired') await service.dispose()
    allowCleanup = true
    withdrawal = owner.ctx.fiber.dispose().then(() => { departed = true })
    const cleanupStarted = await Promise.race([closing.promise.then(() => true), withdrawal.then(() => false)])
    expect({ cleanupStarted, live, departed }).toEqual({ cleanupStarted: true, live: true, departed: false })
    expect(ctx.bail(agentCarrier(owner), 'agent/idle-release-check', { agent: owner })).toBe('busy')
    finish.resolve(undefined)
    await withdrawal
    await confirmation
    expect(live).toBe(false)
    expect(attempts).toBe(phase === 'retired' ? 3 : 2)
  } finally {
    allowCleanup = true
    finish.resolve(undefined)
    await run.dispose()
    await withdrawal
    reported.mockRestore()
  }
})

it('keeps unconfirmed cleanup owned by the runtime after the parent retry fails', async () => {
  const { ctx, parent, request, service } = await fixture(), owner = parent('failed-parent-exit')
  const runtime = ctx.subagents
  let allowCleanup = false, live = true, attempts = 0, released = false
  const reported = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  runtime.registerProvider({ name: 'failed-parent-child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => ({ id: SessionId('failed-parent-child'), localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {
        attempts++
        if (!allowCleanup) throw new Error('resource closure is unconfirmed')
        live = false
      } }) })
  const run = await runtime.start('failed-parent-child', request(owner))
  try {
    await expect(run.dispose()).rejects.toThrow('closure is unconfirmed')
    void runtime.retainFailedCleanup(owner, run).then(() => { released = true })
    await owner.ctx.fiber.dispose()
    expect({ attempts, live, released }).toEqual({ attempts: 2, live: true, released: false })
    expect(reported).toHaveBeenCalled()
    allowCleanup = true
    await service.dispose()
    expect({ attempts, live, released }).toEqual({ attempts: 3, live: false, released: true })
  } finally { allowCleanup = true; await run.dispose(); reported.mockRestore() }
})

it.each(['same', 'retired'] as const)('joins a late hand-back from the %s runtime during parent cleanup', async (phase) => {
  const { ctx, parent, request, service } = await fixture(), owner = parent('late-parent-exit')
  const oldRuntime = ctx.subagents
  let starts = 0, allowCleanup = false
  const firstClosing = Promise.withResolvers<undefined>(), finishFirst = Promise.withResolvers<undefined>()
  const live = new Set<number>()
  const provider: SubagentProvider = { name: 'late-parent-child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => {
      const ordinal = ++starts
      live.add(ordinal)
      return { id: SessionId(`late-parent-child-${ordinal}`), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {
          if (!allowCleanup) throw new Error('resource closure is unconfirmed')
          if (ordinal === 2) { firstClosing.resolve(undefined); await finishFirst.promise }
          live.delete(ordinal)
        } }
    } }
  oldRuntime.registerProvider(provider)
  const lateRun = await oldRuntime.start(provider.name, request(owner))
  if (phase === 'retired') {
    await service.dispose()
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider(provider)
  }
  const runtime = ctx.subagents, first = await runtime.start(provider.name, request(owner))
  let withdrawal: Promise<void> | undefined
  try {
    await expect(first.dispose()).rejects.toThrow('closure is unconfirmed')
    void runtime.retainFailedCleanup(owner, first)
    await expect(lateRun.dispose()).rejects.toThrow('closure is unconfirmed')
    allowCleanup = true
    withdrawal = owner.ctx.fiber.dispose()
    await firstClosing.promise
    expect(owner.ctx.fiber.state).toBe(FiberState.UNLOADING)
    const lateReleased = oldRuntime.retainFailedCleanup(owner, lateRun)
    finishFirst.resolve(undefined)
    await withdrawal
    expect(live.size).toBe(0)
    await lateReleased
  } finally {
    allowCleanup = true
    finishFirst.resolve(undefined)
    await Promise.all([first.dispose(), lateRun.dispose()])
    await withdrawal
  }
})

it.each(['unloading', 'disposed'] as const)('retries first hand-back after the parent is %s without creating a recovery effect', async (phase) => {
  const { ctx, parent, request } = await fixture(), owner = parent('first-late-owner')
  const draining = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
  owner.ctx.effect(() => async () => { draining.resolve(undefined); await finish.promise })
  let allowCleanup = false, live = true
  const runtime = ctx.subagents
  runtime.registerProvider({ name: 'first-late-child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => ({ id: SessionId('first-late-child'), localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {
        if (!allowCleanup) throw new Error('resource closure is unconfirmed')
        live = false
      } }) })
  const run = await runtime.start('first-late-child', request(owner))
  let withdrawal: Promise<void> | undefined
  try {
    await expect(run.dispose()).rejects.toThrow('closure is unconfirmed')
    withdrawal = owner.ctx.fiber.dispose()
    await draining.promise
    if (phase === 'disposed') { finish.resolve(undefined); await withdrawal }
    allowCleanup = true
    const released = runtime.retainFailedCleanup(owner, run)
    await expect.poll(() => live).toBe(false)
    await released
  } finally {
    allowCleanup = true
    finish.resolve(undefined)
    await run.dispose()
    await withdrawal
  }
})

it('lets one existing recovery accept an offered operation while preserving a different recovery', async () => {
  const { ctx, parent, request } = await fixture(), owner = parent('shared-recovery-owner')
  const runtime = ctx.subagents
  let allowCleanup = false, attempts = 0
  runtime.registerProvider({ name: 'shared-recovery-child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => ({ id: SessionId('shared-recovery-child'), localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {
        attempts++
        if (!allowCleanup) throw new Error('resource closure is unconfirmed')
      } }) })
  const run = await runtime.start('shared-recovery-child', request(owner))
  await expect(run.dispose()).rejects.toThrow('closure is unconfirmed')
  const first = Promise.withResolvers<undefined>(), second = Promise.withResolvers<undefined>()
  const retryFirst = vi.fn(async () => { first.resolve(undefined) })
  const retrySecond = vi.fn(async () => { second.resolve(undefined) })
  createSubagentCleanupRecovery(owner).retain(retryFirst, first.promise)
  createSubagentCleanupRecovery(owner).retain(retrySecond, second.promise)
  const released = runtime.retainFailedCleanup(owner, run)
  try {
    allowCleanup = true
    await owner.ctx.fiber.dispose()
    await released
    expect(retryFirst).toHaveBeenCalledTimes(1)
    expect(retrySecond).toHaveBeenCalledTimes(1)
    expect(attempts).toBe(2)
  } finally { allowCleanup = true; await run.dispose() }
})

it('retains and reports a failed late retry after the parent has already left', async () => {
  const { ctx, parent, request, service } = await fixture(), owner = parent('closed-parent-retry')
  const runtime = ctx.subagents
  let allowCleanup = false, attempts = 0, released = false
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  runtime.registerProvider({ name: 'closed-parent-child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => ({ id: SessionId('closed-parent-child'), localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {
        attempts++
        if (!allowCleanup) throw new Error('resource closure is unconfirmed')
      } }) })
  const run = await runtime.start('closed-parent-child', request(owner))
  try {
    await expect(run.dispose()).rejects.toThrow('closure is unconfirmed')
    await owner.ctx.fiber.dispose()
    void runtime.retainFailedCleanup(owner, run).then(() => { released = true })
    await expect.poll(() => warn.mock.calls.length).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('late parent cleanup failed'))
    expect({ attempts, released }).toEqual({ attempts: 2, released: false })
    allowCleanup = true
    await service.dispose()
    expect({ attempts, released }).toEqual({ attempts: 3, released: true })
  } finally { allowCleanup = true; await run.dispose(); warn.mockRestore() }
})

it('accepts late cleanup transfer while its parent dependency scope is unloading', async () => {
  const { ctx, parent, request } = await fixture()
  const agents = ctx.plugin(AgentRegistry)
  await agents.await()
  const unloading = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
  const ownerScope = ctx.plugin({ inject: ['agents'], apply(inner: Context) {
    inner.effect(() => async () => { unloading.resolve(undefined); await finish.promise })
  } })
  await ownerScope.await()
  const owner: Agent = { ...parent('unloading-parent'), ctx: ownerScope.ctx }
  let allowCleanup = false
  ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => ({ id: SessionId('unloading-child'), localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed' }),
      dispose: async () => { if (!allowCleanup) throw new Error('cleanup unconfirmed') } }) })
  const runtime = ctx.subagents, run = await runtime.start('child', request(owner))
  let withdrawal: Promise<void> | undefined
  try {
    await expect(run.dispose()).rejects.toThrow('cleanup unconfirmed')
    withdrawal = agents.dispose()
    await unloading.promise
    expect(owner.ctx.fiber.uid).not.toBeNull()
    expect(owner.ctx.fiber.state).toBe(FiberState.UNLOADING)
    const confirmation = runtime.retainFailedCleanup(owner, run)
    allowCleanup = true
    await run.dispose()
    await confirmation
  } finally {
    allowCleanup = true
    finish.resolve(undefined)
    await run.dispose()
    await withdrawal
  }
})

it('retains parent occupation after reporting failed runtime cleanup', async () => {
  const { ctx, parent, request, service } = await fixture(), owner = parent('failed-unload-owner')
  const error = new Error('resource release unconfirmed')
  let allowCleanup = false, attempts = 0
  const reported = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => ({ id: SessionId('failed-unload-child'), localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {
        attempts++
        if (!allowCleanup) throw error
      } }) })
  const runtime = ctx.subagents, run = await runtime.start('child', request(owner))
  try {
    await expect(run.dispose()).rejects.toBe(error)
    void runtime.retainFailedCleanup(owner, run)
    await service.dispose()
    expect(attempts).toBe(2)
    expect(reported).toHaveBeenCalled()
    expect(ctx.bail(agentCarrier(owner), 'agent/idle-release-check', { agent: owner })).toBe('busy')
    allowCleanup = true
    await run.dispose()
    expect(ctx.bail(agentCarrier(owner), 'agent/idle-release-check', { agent: owner })).toBeUndefined()
  } finally { allowCleanup = true; await run.dispose() }
})

it.each(['withdrawn', 'preparing'] as const)('refuses one-shot dispatch through a %s runtime', async (phase) => {
  const { ctx, parent, request, service } = await fixture(), owner = parent('withdrawn-owner')
  const preparing = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const cwd = await ctx.workingDirectory.ensure(owner, new AbortController().signal)
  let starts = 0
  ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => {
      starts++
      return { id: SessionId('withdrawn-child'), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
    } })
  const runtime = ctx.subagents
  let pending: Promise<SubagentRun> | undefined
  const stopping = Promise.withResolvers<undefined>()
  service.ctx.effect(() => () => { stopping.resolve(undefined) })
  if (phase === 'preparing') {
    vi.spyOn(ctx.workingDirectory, 'ensure').mockImplementationOnce(async () => {
      preparing.resolve(undefined)
      await release.promise
      return cwd
    })
    pending = runtime.start('child', request(owner))
    await preparing.promise
  }
  try {
    const unloading = service.dispose()
    await stopping.promise
    pending ??= runtime.start('child', request(owner))
    release.resolve(undefined)
    const settled = await Promise.allSettled([pending])
    await unloading
    if (settled[0].status === 'fulfilled') await settled[0].value.dispose()
    expect(settled[0]).toMatchObject({ status: 'rejected', reason: { code: 'DRAINING' } })
    expect(starts).toBe(0)
  } finally {
    release.resolve(undefined)
    if (pending !== undefined) {
      const settled = await Promise.allSettled([pending])
      if (settled[0].status === 'fulfilled') await settled[0].value.dispose()
    }
  }
})

it.each(['confirmed', 'retry'] as const)('joins provider publication and %s rollback during withdrawal', async (mode) => {
  const { ctx, parent, request, service } = await fixture(), owner = parent('publishing-owner')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const stopping = Promise.withResolvers<undefined>()
  let resourceLive = true, attempts = 0, providerSignal: AbortSignal | undefined
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const raw: SubagentRun = { id: SessionId('publishing-child'), localAgent: undefined,
    result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {
      if (++attempts === 1 && mode === 'retry') throw new Error('rollback must retry')
      resourceLive = false
    } }
  const appended = vi.spyOn(owner.session, 'append')
  ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async (spec) => { providerSignal = spec.signal; entered.resolve(undefined); await release.promise; return raw } })
  service.ctx.effect(() => () => { stopping.resolve(undefined) })
  const pending = ctx.subagents.start('child', request(owner))
  const result = Promise.allSettled([pending])
  let unloading: Promise<void> | undefined
  try {
    await entered.promise
    unloading = service.dispose().then(() => { expect(resourceLive).toBe(false) })
    await stopping.promise
    expect(providerSignal?.aborted).toBe(true)
    expect(ctx.bail(agentCarrier(owner), 'agent/idle-release-check', { agent: owner })).toBe('busy')
    release.resolve(undefined)
    expect((await result)[0]).toMatchObject({ status: 'rejected', reason: { code: 'DRAINING' } })
    await unloading
    expect(attempts).toBe(mode === 'retry' ? 2 : 1)
    expect(appended).not.toHaveBeenCalled()
    if (mode === 'retry') expect(warn).toHaveBeenCalledWith(expect.stringContaining('disposal after start refusal also failed:'))
  } finally { release.resolve(undefined); await result; await unloading; await raw.dispose() }
})

it('cleans a provider publication after caller cancellation without a catalog entry', async () => {
  const { ctx, parent, request } = await fixture(), owner = parent('cancelled-publication-owner')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const controller = new AbortController(), reason = new Error('cancelled while publishing')
  let disposed = 0
  ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => {
      entered.resolve(undefined); await release.promise
      return { id: SessionId('cancelled-publication-child'), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => { disposed++ } }
    } })
  const appended = vi.spyOn(owner.session, 'append')
  const pending = ctx.subagents.start('child', request(owner, controller.signal))
  const result = Promise.allSettled([pending])
  try {
    await entered.promise
    controller.abort(reason)
    release.resolve(undefined)
    expect((await result)[0]).toEqual({ status: 'rejected', reason })
    expect(disposed).toBe(1)
    expect(appended).not.toHaveBeenCalled()
    expect(ctx.bail(agentCarrier(owner), 'agent/idle-release-check', { agent: owner })).toBeUndefined()
  } finally { release.resolve(undefined); await result }
})

it('leaves published holder-owned runs alive when the service withdraws', async () => {
  const { ctx, parent, request, service } = await fixture(), owner = parent('published-holder-owner')
  let disposed = 0, providerSignal: AbortSignal | undefined
  ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async (spec) => {
      providerSignal = spec.signal
      return { id: SessionId('published-holder-child'), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => { disposed++ } }
    } })
  const caller = new AbortController(), reason = new Error('holder cancellation')
  const run = await ctx.subagents.start('child', request(owner, caller.signal))
  try {
    await service.dispose()
    expect(disposed).toBe(0)
    expect(providerSignal?.aborted).toBe(false)
    caller.abort(reason)
    expect(providerSignal?.reason).toBe(reason)
  } finally { await run.dispose() }
  expect(disposed).toBe(1)
})

it('keeps a committed publication when its start observer withdraws the service', async () => {
  const { ctx, parent, request, service } = await fixture(), owner = parent('observer-withdrawal-owner')
  let providerSignal: AbortSignal | undefined, unloading: Promise<void> | undefined
  ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async (spec) => {
      providerSignal = spec.signal
      return { id: SessionId('observer-withdrawal-child'), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
    } })
  ctx.on('subagent/start', () => { unloading = service.dispose() }, { global: true })
  const run = await ctx.subagents.start('child', request(owner))
  try { await unloading; expect(providerSignal?.aborted).toBe(false) } finally { await run.dispose() }
})

it('refuses a new foreground operation after runtime withdrawal', async () => {
  const { ctx, parent, service } = await fixture(), owner = parent('closed-foreground-owner')
  const runtime = ctx.subagents
  const operation = vi.fn(async () => 'unreachable')
  await service.dispose()
  await expect(withSubagentForeground(runtime, owner, new AbortController().signal, operation))
    .rejects.toMatchObject({ code: 'DRAINING' })
  expect(operation).not.toHaveBeenCalled()
})

it('refuses cleanup transfer from another service instance', async () => {
  const first = await fixture(), second = await fixture(), owner = first.parent('same-id')
  first.ctx.subagents.registerProvider({ name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => ({ id: SessionId('service-child'), localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }) })
  const run = await first.ctx.subagents.start('child', first.request(owner))
  expect(() => { void second.ctx.subagents.retainFailedCleanup(owner, run) }).toThrow('runtime')
  await run.dispose()
})

it.each(['replacement', 'same-provider'] as const)('refuses the old registration after %s during directory preparation', async (providerState) => {
  const { ctx, parent, request } = await fixture(), owner = parent('provider-owner')
  const cwd = await ctx.workingDirectory.ensure(owner, new AbortController().signal)
  const preparing = Promise.withResolvers<undefined>(), ready = Promise.withResolvers<typeof cwd>()
  vi.spyOn(ctx.workingDirectory, 'ensure').mockImplementationOnce(() => { preparing.resolve(undefined); return ready.promise })
  const oldStart = vi.fn(async () => ({ id: SessionId('obsolete-child'), localAgent: undefined,
    result: Promise.resolve({ output: [], stopReason: 'completed' as const }), dispose: async () => {} }))
  const newStart = vi.fn(async () => ({ id: SessionId('current-child'), localAgent: undefined,
    result: Promise.resolve({ output: [], stopReason: 'completed' as const }), dispose: async () => {} }))
  const original = { name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }, start: oldStart }
  const remove = ctx.subagents.registerProvider(original)
  const pending = ctx.subagents.start('child', request(owner))
  await preparing.promise
  remove()
  ctx.subagents.registerProvider(providerState === 'same-provider' ? original : { name: 'child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }, start: newStart })
  ready.resolve(cwd)
  await expect(pending).rejects.toThrow('provider')
  expect(oldStart).not.toHaveBeenCalled()
  expect(newStart).not.toHaveBeenCalled()
  const current = await ctx.subagents.start('child', request(owner))
  expect(providerState === 'same-provider' ? oldStart : newStart).toHaveBeenCalledOnce()
  await current.dispose()
})

it('refuses a new one-shot producer while its parent identity is reserved for permanent removal', async () => {
  const { ctx, parent, request } = await fixture(), owner = parent('permanent-removal-owner')
  await ctx.plugin(AgentRegistry)
  await ctx.agents.register(owner)
  let starts = 0
  ctx.subagents.registerProvider({ name: 'removal-child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => {
      starts++
      return { id: SessionId('removal-child'), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
    } })
  const reservation = ctx.agents.reserveRemoval([owner.id])
  try {
    await expect(ctx.subagents.start('removal-child', request(owner))).rejects.toMatchObject({ code: 'DRAINING' })
    expect(starts).toBe(0)
  } finally { reservation[Symbol.dispose]() }
  const run = await ctx.subagents.start('removal-child', request(owner))
  expect(starts).toBe(1)
  await run.dispose()
})

it('observes a rejected unpublished result while preserving catalog failure and cleanup', async () => {
  const { ctx, parent, request } = await fixture(), owner = parent('unpublished-result-owner')
  const catalogFailure = new Error('catalog refused publication')
  let disposed = 0
  vi.spyOn(owner.session, 'append').mockImplementationOnce(() => { throw catalogFailure })
  ctx.subagents.registerProvider({ name: 'unpublished-result-child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => ({ id: SessionId('unpublished-result-child'), localAgent: undefined,
      result: Promise.reject(new Error('unpublished child infrastructure failed')),
      dispose: async () => { disposed++ } }) })
  await expect(ctx.subagents.start('unpublished-result-child', request(owner))).rejects.toBe(catalogFailure)
  expect(disposed).toBe(1)
})
