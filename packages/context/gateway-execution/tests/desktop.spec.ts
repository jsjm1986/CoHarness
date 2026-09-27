/** Desktop workflow isolation, cancellation and external lease observations. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { GatewayDesktopPolicy, type DesktopExecutionHost } from '../src/desktop.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(pollMs = 60_000) {
  const root = {} as Agent, child = {} as Agent
  let idle = false
  const calls: Array<{ agent: Agent; action: string; body: object }> = []
  const granted = { status: 'granted', grantId: 'grant-1', fencing: 1, grantTtlMs: 300_000 }
  const authorize = vi.fn<DesktopExecutionHost['authorize']>().mockResolvedValue()
  const request = vi.fn<DesktopExecutionHost['request']>(async (agent, action, body) => {
    calls.push({ agent, action, body })
    if (action === 'acquire' || action === 'status') return granted
    if (action === 'heartbeat') return { status: 'held' }
    return {}
  })
  const rootOf = vi.fn<DesktopExecutionHost['root']>(() => root)
  const policy = new GatewayDesktopPolicy({ root: rootOf, authorize, request, idle: () => idle }, pollMs, 1000)
  onTestFinished(async () => { await policy.dispose() })
  const execution = (agent = child, signal = new AbortController().signal) => ({ agent, signal }) as ToolExecution
  return { policy, root, child, calls, request, authorize, granted, rootOf, execution, setIdle: () => { idle = true } }
}

describe('Gateway desktop workflow', () => {
  it('retains one grant across calls and releases only when the root settles', async () => {
    const f = fixture()
    await expect(f.policy.run(f.execution(), async () => 'first')).resolves.toBe('first')
    await f.policy.settled(f.root)
    expect(f.calls.map(call => call.action)).toEqual(['acquire', 'heartbeat', 'heartbeat'])
    await f.policy.run(f.execution(f.root), async () => 'second')
    expect(f.calls.filter(call => call.action === 'acquire')).toHaveLength(1)
    f.setIdle()
    await f.policy.settled(f.root)
    expect(f.calls.at(-1)).toMatchObject({ agent: f.root, action: 'release', body: { grantId: 'grant-1' } })
    await f.policy.settled(f.root)
    expect(f.calls.filter(call => call.action === 'release')).toHaveLength(1)
  })

  it('serializes concurrent child effects while sharing the root lease', async () => {
    const f = fixture(), entered = deferred<undefined>(), finish = deferred<undefined>()
    const first = f.policy.run(f.execution(), async () => { entered.resolve(undefined); await finish.promise; return 1 })
    await entered.promise
    const effect = vi.fn(async () => 2)
    const second = f.policy.run(f.execution(f.root), effect)
    f.setIdle()
    await f.policy.settled(f.root)
    expect(effect).not.toHaveBeenCalled()
    expect(f.calls.some(call => call.action === 'release')).toBe(false)
    finish.resolve(undefined)
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(f.calls.filter(call => call.action === 'acquire')).toHaveLength(1)
    expect(f.calls.at(-1)?.action).toBe('release')
  })

  it('waits for an earlier cleanup before reacquiring the same root', async () => {
    const f = fixture(), releasing = deferred<undefined>(), release = deferred<undefined>()
    await f.policy.run(f.execution(), async () => 1)
    f.setIdle()
    f.request.mockImplementationOnce(async () => { releasing.resolve(undefined); await release.promise; return {} })
    const closing = f.policy.settled(f.root)
    await releasing.promise
    const effect = vi.fn(async () => 2)
    const next = f.policy.run(f.execution(), effect)
    expect(effect).not.toHaveBeenCalled()
    release.resolve(undefined)
    await closing
    await expect(next).resolves.toBe(2)
    expect(f.calls.filter(call => call.action === 'acquire')).toHaveLength(2)
  })

  it('rejects ownership changed while waiting for the coordinator', async () => {
    const f = fixture(), effect = vi.fn()
    f.request.mockImplementationOnce(async () => { f.rootOf.mockReturnValue(f.child); return f.granted })
    await expect(f.policy.run(f.execution(), effect)).rejects.toThrow('ownership changed')
    expect(effect).not.toHaveBeenCalled()
    expect(f.calls.at(-1)?.action).toBe('release')
  })

  it('refuses further effects when renewal is lost between driver calls', async () => {
    const f = fixture(5), lost = deferred<undefined>()
    await f.policy.run(f.execution(), async () => 1)
    f.request.mockImplementationOnce(async () => { lost.resolve(undefined); return { status: 'lost' } })
    await lost.promise
    const effect = vi.fn()
    await expect(f.policy.run(f.execution(), effect)).rejects.toThrow('stopping or lost')
    expect(effect).not.toHaveBeenCalled()
  })

  it('waits for queue admission and rechecks authority before the effect', async () => {
    const f = fixture(5)
    f.request.mockImplementationOnce(async () => ({ status: 'queued', queueId: 'q1', position: 1 }))
    f.setIdle()
    const effect = vi.fn(async () => 'effect')
    await expect(f.policy.run(f.execution(), effect)).resolves.toBe('effect')
    expect(f.calls.some(call => call.action === 'status')).toBe(true)
    expect(f.authorize).toHaveBeenCalledTimes(3)
    expect(effect).toHaveBeenCalledOnce()
  })

  it('cancels a queued request without entering the driver', async () => {
    const f = fixture(60_000), entered = deferred<undefined>(), abort = new AbortController()
    f.request.mockImplementationOnce(async () => { entered.resolve(undefined); return { status: 'queued', queueId: 'q1', position: 1 } })
    const effect = vi.fn()
    const run = f.policy.run(f.execution(f.child, abort.signal), effect)
    const refused = expect(run).rejects.toThrow()
    await entered.promise
    abort.abort(new Error('request cancelled'))
    await refused
    expect(effect).not.toHaveBeenCalled()
    expect(f.calls.at(-1)).toMatchObject({ agent: f.root, action: 'cancel' })
  })

  it('keeps uncertain cancelled input stopping until the coordinator receives independent drainage proof', async () => {
    const f = fixture(), entered = deferred<undefined>(), finish = deferred<undefined>(), abort = new AbortController()
    const run = f.policy.run(f.execution(f.child, abort.signal), async (signal) => {
      entered.resolve(undefined)
      await finish.promise
      expect(signal.aborted).toBe(true)
      return 'late result'
    })
    const refused = expect(run).rejects.toThrow('cancelled')
    await entered.promise
    abort.abort(new Error('cancelled'))
    expect(f.calls.some(call => call.action === 'stop')).toBe(false)
    finish.resolve(undefined)
    await refused
    expect(f.calls.at(-1)?.action).toBe('stop')
    expect(f.calls.some(call => call.action === 'release' || call.action === 'confirm-stopped')).toBe(false)
  })

  it('does not publish output after permission is withdrawn during the effect', async () => {
    const f = fixture()
    await expect(f.policy.run(f.execution(), async () => {
      f.authorize.mockRejectedValue(new Error('permission revoked'))
      return 'sensitive output'
    })).rejects.toThrow('permission revoked')
    expect(f.calls.at(-1)?.action).toBe('stop')
  })

  it('rejects a revoked lease before entering the next effect', async () => {
    const f = fixture()
    await f.policy.run(f.execution(), async () => undefined)
    f.request.mockImplementationOnce(async () => ({ status: 'stopping' }))
    const effect = vi.fn()
    await expect(f.policy.run(f.execution(), effect)).rejects.toThrow('stopping or lost')
    expect(effect).not.toHaveBeenCalled()
  })

  it('renews long-running effects and propagates a lost lease to the driver signal', async () => {
    const f = fixture(5), entered = deferred<undefined>(), lost = deferred<undefined>()
    let heartbeats = 0
    f.request.mockImplementation(async (agent, action, body) => {
      f.calls.push({ agent, action, body })
      if (action === 'acquire') return f.granted
      if (action === 'heartbeat') return { status: ++heartbeats === 1 ? 'held' : 'lost' }
      return {}
    })
    const run = f.policy.run(f.execution(), async (signal) => {
      entered.resolve(undefined)
      signal.addEventListener('abort', () => { lost.resolve(undefined) }, { once: true })
      await lost.promise
      return 'late'
    })
    const refused = expect(run).rejects.toThrow('stopping or lost')
    await entered.promise
    await refused
    expect(f.calls.at(-1)?.action).toBe('stop')
  })

  it('refuses changed ownership and malformed admission without invoking the driver', async () => {
    const f = fixture(), effect = vi.fn()
    f.rootOf.mockReturnValueOnce(f.root).mockReturnValueOnce(f.child)
    await expect(f.policy.run(f.execution(), effect)).rejects.toThrow('ownership changed')
    expect(effect).not.toHaveBeenCalled()
    f.request.mockImplementationOnce(async () => ({ status: 'granted', grantId: 'g', fencing: 0, grantTtlMs: 0 }))
    await expect(f.policy.run(f.execution(), effect)).rejects.toThrow()
    expect(effect).not.toHaveBeenCalled()
    expect(f.calls.at(-1)?.action).toBe('cancel')
  })

  it('preserves admission failure without sending cleanup for an unrequested lease', async () => {
    const f = fixture(), effect = vi.fn()
    f.authorize.mockRejectedValueOnce(new Error('qualification denied'))
    f.request.mockRejectedValue(new Error('coordinator unavailable'))
    await expect(f.policy.run(f.execution(), effect)).rejects.toThrow('qualification denied')
    expect(effect).not.toHaveBeenCalled()
    expect(f.request).not.toHaveBeenCalled()
  })

  it('rejects missing callers and new work after disposal', async () => {
    const f = fixture(), effect = vi.fn()
    await expect(f.policy.run({ signal: new AbortController().signal } as ToolExecution, effect)).rejects.toThrow('unavailable')
    await expect(f.policy.run(f.execution(f.root, AbortSignal.abort()), effect)).rejects.toThrow()
    await f.policy.dispose()
    await expect(f.policy.run(f.execution(), effect)).rejects.toThrow('unavailable')
    expect(effect).not.toHaveBeenCalled()
  })

  it('waits for active driver settlement when the provider is disposed', async () => {
    const f = fixture(), entered = deferred<undefined>(), finish = deferred<undefined>()
    const run = f.policy.run(f.execution(), async () => { entered.resolve(undefined); await finish.promise })
    const refused = expect(run).rejects.toThrow('policy stopped')
    await entered.promise
    const dispose = f.policy.dispose()
    expect(f.calls.some(call => call.action === 'stop')).toBe(false)
    finish.resolve(undefined)
    await Promise.all([dispose, refused])
    expect(f.calls.filter(call => call.action === 'stop')).toHaveLength(1)
  })
})
