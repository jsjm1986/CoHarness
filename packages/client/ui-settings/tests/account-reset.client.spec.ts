// @vitest-environment jsdom
/** Account read freshness through the settings plugin's actual reset and document listeners. */
import { Context } from '@deepseek-ai/cordis'
import type { AccountPreferencesTransport, AccountPreferencesView } from '@deepseek-ai/dsh-client-connection/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

function accountView(revision: number, preference: 'light' | 'dark' = 'light'): AccountPreferencesView {
  return {
    revision, migrated: true,
    values: {
      locale: { preference: 'en' },
      'ui-theme': { preference },
      'ui-conversation': {
        busyEnter: 'queue', chatContentWidth: 748, chatFullWidth: false, chatFontSize: 14,
        transcriptView: 'detailed', performanceUsage: 'detailed', linkOpening: 'sidebar',
      },
    },
    overrides: { locale: { preference: 'en' }, 'ui-theme': { preference }, 'ui-conversation': {} },
  }
}

interface AccountRead {
  readonly signal: AbortSignal
  readonly result: ReturnType<typeof Promise.withResolvers<AccountPreferencesView>>
}

interface AccountFixture {
  readonly ctx: Context
  readonly first: AccountRead
  readonly reads: readonly AccountRead[]
  readonly scopes: Record<'locale' | 'theme' | 'conversation', SettingsScope<unknown>>
  readonly reset: (initial?: boolean) => Promise<void>
  readonly ready: (revision: number, preference?: 'light' | 'dark') => Promise<void>
  readonly dispose: () => Promise<void>
}

/** Account transport admission is deferred by one microtask after a synchronous invalidation callback. */
async function admissionBarrier(): Promise<void> {
  await new Promise<void>((resolve) => { queueMicrotask(resolve) })
}

async function withAccountPlugin(operation: (fixture: AccountFixture) => Promise<void>): Promise<void> {
  const ctx = new Context()
  const reads: AccountRead[] = []
  const pendingDisposals: Promise<PromiseSettledResult<void>[]>[] = []
  let endProvider: () => Promise<void> = () => Promise.resolve()
  const hostDescribe = vi.fn(async () => ({
    rpcId: 'account-reset-host' as never,
    result: { ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } },
  }))
  const mutate = vi.fn<AccountPreferencesTransport['mutate']>(async () => {
    throw new Error('Account reset fixture does not accept writes')
  })
  const transport: AccountPreferencesTransport = {
    describe: (signal) => {
      if (signal === undefined) throw new Error('Account reads require an owner cancellation signal')
      const read = { signal, result: Promise.withResolvers<AccountPreferencesView>() }
      reads.push(read)
      return read.result.promise
    },
    mutate,
  }
  ctx.provide('connection', {
    api: { settings: { describe: hostDescribe } }, accountPreferences: transport, isLoopback: false,
  } as never)
  new TestRemote(ctx)
  const failures: unknown[] = []
  const dispose = (): Promise<void> => {
    const pending = endProvider()
    pendingDisposals.push(Promise.allSettled([pending]))
    return pending
  }
  try {
    const provider = ctx.plugin({ inject: [...inject], apply })
    endProvider = () => provider.dispose()
    await provider.await()
    const binding: { scopes?: AccountFixture['scopes'] } = {}
    await ctx.plugin({
      inject: ['settingsScope'],
      apply: (consumer: Context) => {
        binding.scopes = {
          locale: consumer.settingsScope.bind({ namespace: 'locale', source: 'account-or-host' }),
          theme: consumer.settingsScope.bind({ namespace: 'ui-theme', source: 'account-or-host' }),
          conversation: consumer.settingsScope.bind({ namespace: 'ui-conversation', source: 'account-or-host' }),
        }
      },
    }).await()
    if (binding.scopes === undefined) throw new Error('Account reset consumer did not bind its scopes')
    const bound = binding.scopes
    await vi.waitFor(() => { expect(reads).toHaveLength(1) })
    const first = reads[0]!
    await operation({
      ctx, first, reads, scopes: bound, dispose,
      reset: async (initial) => {
        const before = hostDescribe.mock.calls.length
        if (initial === undefined) ctx.emit('connection/reset')
        else ctx.emit('connection/reset', initial)
        await vi.waitFor(() => { expect(hostDescribe).toHaveBeenCalledTimes(before + 1) })
        await admissionBarrier()
      },
      ready: async (revision, preference = 'light') => {
        await vi.waitFor(() => {
          expect(bound.theme.getSnapshot()).toMatchObject({ status: 'ready', revision, value: { preference } })
        })
      },
    })
    expect(mutate).not.toHaveBeenCalled()
  } catch (error) {
    failures.push(error)
  } finally {
    for (const read of reads) read.result.resolve(accountView(100))
    try { await dispose() } catch (error) { failures.push(error) }
    try { await ctx.fiber.dispose() } catch (error) { failures.push(error) }
    await Promise.all(pendingDisposals)
    vi.restoreAllMocks()
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Account reset fixture failed')
}

describe('account preference plugin resets', () => {
  it.each(['pending', 'ready'] as const)('initial account preference reset preserves the %s read', async (state) => {
    await withAccountPlugin(async ({ first, reads, scopes, reset, ready }) => {
      if (state === 'ready') {
        first.result.resolve(accountView(2, 'dark'))
        await ready(2, 'dark')
      }
      await reset(true)
      expect(reads).toHaveLength(1)
      expect(first.signal.aborted).toBe(false)
      first.result.resolve(accountView(2, 'dark'))
      await ready(2, 'dark')
      expect(scopes.locale.getSnapshot()).toMatchObject({ status: 'ready', revision: 2, value: { preference: 'en' } })
      expect(scopes.conversation.getSnapshot()).toMatchObject({ status: 'ready', revision: 2, value: { busyEnter: 'queue' } })
    })
  })

  it.each([
    { initial: false, state: 'pending' }, { initial: false, state: 'ready' },
    { initial: undefined, state: 'pending' }, { initial: undefined, state: 'ready' },
  ] as const)('forces an account read on reset($initial) after $state', async ({ initial, state }) => {
    await withAccountPlugin(async ({ first, reads, reset, ready }) => {
      if (state === 'ready') {
        first.result.resolve(accountView(1))
        await ready(1)
      }
      await reset(initial)
      expect(reads).toHaveLength(2)
      expect(first.signal.aborted).toBe(state === 'pending')
      const fresh = reads[1]!
      expect(fresh.signal.aborted).toBe(false)
      fresh.result.resolve(accountView(2, 'dark'))
      await ready(2, 'dark')
      first.result.resolve(accountView(1))
      await admissionBarrier()
      await ready(2, 'dark')
    })
  })

  it.each([
    { event: 'focus', state: 'pending' }, { event: 'focus', state: 'ready' },
    { event: 'visible', state: 'pending' }, { event: 'visible', state: 'ready' },
  ] as const)('forces an account read on $event after $state', async ({ event, state }) => {
    await withAccountPlugin(async ({ first, reads, ready }) => {
      if (state === 'ready') {
        first.result.resolve(accountView(1))
        await ready(1)
      }
      if (event === 'focus') window.dispatchEvent(new Event('focus'))
      else {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        document.dispatchEvent(new Event('visibilitychange'))
      }
      await admissionBarrier()
      expect(reads).toHaveLength(2)
      expect(first.signal.aborted).toBe(state === 'pending')
      reads[1]!.result.resolve(accountView(2, 'dark'))
      await ready(2, 'dark')
      first.result.resolve(accountView(1))
      await admissionBarrier()
      await ready(2, 'dark')
    })
  })

  it('keeps a pending account read when the document becomes hidden', async () => {
    await withAccountPlugin(async ({ first, reads, ready }) => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      await admissionBarrier()
      expect(reads).toHaveLength(1)
      expect(first.signal.aborted).toBe(false)
      first.result.resolve(accountView(1))
      await ready(1)
    })
  })

  it('retries a settled failed account read on the initial reset', async () => {
    await withAccountPlugin(async ({ first, reads, scopes, reset, ready }) => {
      first.result.reject(new Error('Synthetic account read failure'))
      await vi.waitFor(() => { expect(scopes.theme.getSnapshot().status).toBe('unavailable') })
      await reset(true)
      expect(reads).toHaveLength(2)
      reads[1]!.result.resolve(accountView(2, 'dark'))
      await ready(2, 'dark')
    })
  })

  it('waits for an abort-ignoring account read and removes document listeners on disposal', async () => {
    await withAccountPlugin(async ({ ctx, first, reads, dispose }) => {
      const settled = vi.fn()
      const pending = dispose()
      const observed = pending.then(settled, settled)
      await vi.waitFor(() => { expect(first.signal.aborted).toBe(true) })
      expect(settled).not.toHaveBeenCalled()
      first.result.resolve(accountView(1))
      await pending
      await observed
      expect(ctx.get('settingsScope')).toBeUndefined()
      const count = reads.length
      ctx.emit('connection/reset', true)
      window.dispatchEvent(new Event('focus'))
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      await admissionBarrier()
      expect(reads).toHaveLength(count)
    })
  })
})
