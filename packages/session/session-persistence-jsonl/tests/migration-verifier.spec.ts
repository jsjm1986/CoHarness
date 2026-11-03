import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonlMigrationVerifier } from '../src/migration-verifier.ts'
import ResourceBudget, { ResourceAdmissionError, resourceBudgetOf, type ResourceLease } from '@deepseek-ai/dsh-resource-budget'
import { scheduler } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'

const state = vi.hoisted(() => ({ workers: [] as unknown[], constructorFailure: undefined as Error | undefined }))

vi.mock('node:worker_threads', () => ({
  Worker: class {
    readonly listeners = new Map<string, (value: never) => void>()
    readonly terminate = vi.fn<() => Promise<number>>(() => Promise.resolve(0))

    constructor(readonly entry: string | URL, readonly options: unknown) {
      if (state.constructorFailure !== undefined) throw state.constructorFailure
      state.workers.push(this)
    }

    once(event: string, listener: (value: never) => void): this {
      this.listeners.set(event, listener)
      return this
    }

    emit(event: string, value: unknown): void {
      this.listeners.get(event)?.(value as never)
    }
  },
}))

interface FakeWorker {
  readonly entry: string | URL
  readonly options: { readonly workerData: unknown }
  readonly terminate: ReturnType<typeof vi.fn<() => Promise<number>>>
  emit(event: string, value: unknown): void
}

function worker(index = 0): FakeWorker {
  const candidate = state.workers[index]
  if (candidate === undefined) throw new Error('verification did not create a Worker')
  return candidate as FakeWorker
}

const result = {
  identity: { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n, ctimeNs: 5n },
  bytes: 3,
  digest: 'a'.repeat(64),
}

let verifier: JsonlMigrationVerifier
let budget: Pick<ResourceBudget, 'acquire'> | undefined
let reported: ReturnType<typeof vi.fn<(error: unknown) => void>>
beforeEach(() => {
  budget = undefined
  state.constructorFailure = undefined
  reported = vi.fn()
  verifier = new JsonlMigrationVerifier({ concurrency: 2, maxQueued: 128 }, { budget: () => budget, report: reported })
})
function verifyCurrentGenerationInWorker(...args: Parameters<JsonlMigrationVerifier['verify']>) {
  return verifier.verify(...args)
}

afterEach(async () => {
  for (const candidate of state.workers as FakeWorker[]) candidate.emit('exit', 0)
  await verifier.dispose()
  state.workers.length = 0
})

describe('migration verifier Worker lifecycle', () => {
  it('accepts fresh Cordis tracing proxies for the same live resource Service', async () => {
    const ctx = new Context(), release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
    class Budget extends ResourceBudget {
      override async acquire(): Promise<ResourceLease> {
        return { signal: new AbortController().signal, release, uncertain }
      }
    }
    try {
      await ctx.plugin(Budget)
      verifier = new JsonlMigrationVerifier({ concurrency: 1, maxQueued: 0 }, {
        budget: () => resourceBudgetOf(ctx), report: reported,
      })
      const observed = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0)
      await scheduler.yield()
      worker().emit('message', { ok: true, result })
      await expect(observed).resolves.toEqual(result)
      expect(release).toHaveBeenCalledOnce()
      expect(uncertain).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['withdrawn', 'replaced'] as const)('refuses a migration budget %s during queued admission', async (change) => {
    const grant = Promise.withResolvers<ResourceLease>(), release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
    const replacement = vi.fn(async () => ({ signal: new AbortController().signal, release, uncertain }))
    budget = { acquire: vi.fn(() => grant.promise) }
    const verification = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0)
    const observed = verification.then(value => ({ value }), (error: unknown) => ({ error }))
    budget = change === 'withdrawn' ? undefined : { acquire: replacement }
    grant.resolve({ signal: new AbortController().signal, release, uncertain })
    await scheduler.yield()
    for (const candidate of state.workers as FakeWorker[]) candidate.emit('message', { ok: true, result })
    expect(await observed).toMatchObject({ error: { reason: 'unavailable' } })
    expect(state.workers).toHaveLength(0)
    expect(release).toHaveBeenCalledOnce()
    expect(uncertain).not.toHaveBeenCalled()
    expect(replacement).not.toHaveBeenCalled()
  })

  it.each(['managed', 'independent'] as const)('retains the %s budget across the local verification queue', async (initial) => {
    const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
    const lease = { signal: new AbortController().signal, release, uncertain }
    const acquire = vi.fn(async () => lease), replacement = vi.fn(async () => lease)
    budget = initial === 'managed' ? { acquire } : undefined
    verifier = new JsonlMigrationVerifier({ concurrency: 1, maxQueued: 1 }, { budget: () => budget, report: reported })
    const first = verifyCurrentGenerationInWorker('/first', 'none', 'session', 0)
    await scheduler.yield()
    const queued = verifyCurrentGenerationInWorker('/queued', 'none', 'session', 0)
    const observed = queued.then(value => ({ value }), (error: unknown) => ({ error }))
    budget = { acquire: replacement }
    worker().emit('message', { ok: true, result })
    await first
    await scheduler.yield()
    if (state.workers.length > 1) worker(1).emit('message', { ok: true, result })
    expect(await observed).toMatchObject({ error: { reason: 'unavailable' } })
    expect(state.workers).toHaveLength(1)
    expect(replacement).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(initial === 'managed' ? 1 : 0)
    expect(uncertain).not.toHaveBeenCalled()
  })

  it('waits for a process permit before allocating and holds it through termination', async () => {
    const grant = Promise.withResolvers<ResourceLease>()
    const release = vi.fn(async () => {})
    const uncertain = vi.fn(async () => {})
    budget = { acquire: vi.fn(() => grant.promise) }
    const lease = { signal: new AbortController().signal, release, uncertain }
    const verification = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0)
    const observed = verification.catch((error: unknown) => error)
    try {
      expect(state.workers).toHaveLength(0)
      expect(budget.acquire).toHaveBeenCalledWith({ kind: 'process', origin: 'infrastructure' })
      grant.resolve(lease)
      await vi.waitFor(() => { expect(state.workers).toHaveLength(1) })
      worker().emit('message', { ok: true, result })
      expect(await verification).toEqual(result)
      expect(release).toHaveBeenCalledOnce()
      expect(uncertain).not.toHaveBeenCalled()
    } finally {
      grant.resolve(lease)
      for (const candidate of state.workers as FakeWorker[]) candidate.emit('exit', 0)
      await observed
    }
  })

  it('does not allocate when a grant and caller cancellation coincide', async () => {
    const caller = new AbortController()
    const reason = new Error('cancelled before allocation')
    const release = vi.fn(async () => {})
    const uncertain = vi.fn(async () => {})
    budget = { acquire: async () => {
      caller.abort(reason)
      return { signal: new AbortController().signal, release, uncertain }
    } }
    await expect(verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0, undefined, caller.signal)).rejects.toBe(reason)
    expect(state.workers).toHaveLength(0)
    expect(release).toHaveBeenCalledOnce()
    expect(uncertain).not.toHaveBeenCalled()
  })

  it('refuses a full local queue and removes a cancelled waiter', async () => {
    verifier = new JsonlMigrationVerifier({ concurrency: 1, maxQueued: 1 }, { budget: () => undefined, report: vi.fn() })
    const first = verifyCurrentGenerationInWorker('/first', 'none', 'session', 0)
    const controller = new AbortController()
    const queued = verifyCurrentGenerationInWorker('/queued', 'none', 'session', 0, undefined, controller.signal)
    await expect(verifyCurrentGenerationInWorker('/overflow', 'none', 'session', 0)).rejects.toMatchObject({ reason: 'refused' })
    controller.abort(new Error('queued caller cancelled'))
    await expect(queued).rejects.toThrow('queued caller cancelled')
    const next = verifyCurrentGenerationInWorker('/next', 'none', 'session', 0)
    const disposing = verifier.dispose()
    await expect(verifyCurrentGenerationInWorker('/after-close', 'none', 'session', 0)).rejects.toMatchObject({ reason: 'unavailable' })
    worker().emit('message', { ok: true, result })
    await first
    await vi.waitFor(() => { expect(state.workers).toHaveLength(2) })
    expect(worker(1).options.workerData).toMatchObject({ path: '/next' })
    worker(1).emit('message', { ok: true, result })
    await next
    await disposing
  })

  it('holds local capacity and its node permit after failed termination until the exit proof', async () => {
    const releases: Array<ReturnType<typeof vi.fn<() => Promise<void>>>> = []
    const uncertain = vi.fn(async () => {})
    budget = { acquire: async () => {
      const release = vi.fn(async () => {})
      releases.push(release)
      return { signal: new AbortController().signal, release, uncertain }
    } }
    const first = verifyCurrentGenerationInWorker('/first', 'none', 'session', 0).catch((error: unknown) => error)
    const second = verifyCurrentGenerationInWorker('/second', 'none', 'session', 0)
    const third = verifyCurrentGenerationInWorker('/third', 'none', 'session', 0)
    await vi.waitFor(() => { expect(state.workers).toHaveLength(2) })
    worker().terminate.mockRejectedValueOnce(new Error('unconfirmed termination'))
    worker().emit('message', { ok: true, result })
    expect(await first).toMatchObject({ reason: 'unavailable' })
    expect(uncertain).toHaveBeenCalledOnce()
    expect(releases[0]).not.toHaveBeenCalled()
    expect(state.workers).toHaveLength(2)
    worker().emit('exit', 0)
    await vi.waitFor(() => { expect(state.workers).toHaveLength(3) })
    expect(releases[0]).toHaveBeenCalledOnce()
    worker(1).emit('message', { ok: true, result })
    worker(2).emit('message', { ok: true, result })
    await Promise.all([second, third])
  })

  it('keeps a budget refusal operational rather than allocating a Worker', async () => {
    const reason = new ResourceAdmissionError('refused', 'node process capacity unavailable')
    budget = { acquire: async () => { throw reason } }
    await expect(verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0)).rejects.toBe(reason)
    expect(state.workers).toHaveLength(0)
  })

  it('wraps an admission transport failure without treating a file as corrupt', async () => {
    const failure = new Error('coordinator unavailable')
    budget = { acquire: async () => { throw failure } }
    await expect(verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0))
      .rejects.toMatchObject({ reason: 'unavailable', cause: failure })
    expect(state.workers).toHaveLength(0)
  })

  it('preserves cancellation when admission rejects after the caller aborts', async () => {
    const controller = new AbortController()
    const reason = new Error('caller stopped waiting')
    budget = { acquire: async () => {
      controller.abort(reason)
      throw new Error('request aborted')
    } }
    await expect(verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0, undefined, controller.signal)).rejects.toBe(reason)
    expect(state.workers).toHaveLength(0)
  })

  it('retains unknown construction failure for the enclosing process supervisor', async () => {
    const release = vi.fn(async () => {})
    const uncertain = vi.fn(async () => {})
    const owner = { acquire: async () => ({ signal: new AbortController().signal, release, uncertain }) }
    const independent = new JsonlMigrationVerifier({ concurrency: 1, maxQueued: 0 }, {
      budget: () => owner,
      report: reported,
    })
    state.constructorFailure = new Error('unknown native allocation failure')
    await expect(independent.verify('/stage', 'none', 'session', 0)).rejects.toMatchObject({ reason: 'unavailable' })
    expect(uncertain).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
    expect(state.workers).toHaveLength(0)
    let disposed = false
    // The scripted constructor creates no thread; its pending promises model unavailable supervisor proof.
    void independent.dispose().then(() => { disposed = true })
    await scheduler.yield()
    expect(disposed).toBe(false)
  })

  it.each([true, false])('preserves verification outcome when completion reporting fails (%s)', async (success) => {
    const reporting = new Error('completion transport unavailable')
    budget = { acquire: async () => ({
      signal: new AbortController().signal,
      release: async () => { throw reporting }, uncertain: async () => {},
    }) }
    const observed = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0).catch((error: unknown) => error)
    await vi.waitFor(() => { expect(state.workers).toHaveLength(1) })
    worker().emit('message', success ? { ok: true, result } : { ok: false, message: 'bad current generation' })
    const failure: unknown = await observed
    expect(failure).toMatchObject({ reason: 'unavailable' })
    const cause = (failure as Error).cause
    if (success) expect(cause).toBe(reporting)
    else {
      expect(cause).toBeInstanceOf(AggregateError)
      expect((cause as AggregateError).errors).toEqual([new Error('bad current generation'), reporting])
    }
  })

  it('reports a failed late completion and keeps both initial cleanup failures', async () => {
    const uncertainFailure = new Error('uncertain transport unavailable')
    const completionFailure = new Error('quiescent transport unavailable')
    budget = { acquire: async () => ({
      signal: new AbortController().signal,
      uncertain: async () => { throw uncertainFailure }, release: async () => { throw completionFailure },
    }) }
    const observed = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0).catch((error: unknown) => error)
    await vi.waitFor(() => { expect(state.workers).toHaveLength(1) })
    worker().terminate.mockRejectedValueOnce(new Error('termination unconfirmed'))
    worker().emit('message', { ok: true, result })
    const failure: unknown = await observed
    expect(failure).toMatchObject({ reason: 'unavailable' })
    const cause = (failure as Error).cause as AggregateError
    expect(cause.errors[1]).toBe(uncertainFailure)
    worker().emit('exit', 0)
    await vi.waitFor(() => { expect(reported).toHaveBeenCalledWith(completionFailure) })
  })

  it('resolves only after terminating a successful Worker', async () => {
    const expectedPrefix = { bytes: 3, digest: 'a'.repeat(64) }
    const verification = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 2, expectedPrefix)
    const instance = worker()
    expect(instance.options.workerData).toEqual({
      path: '/stage', compression: 'none', expectedId: 'session', expectedEventCount: 2,
      expectedPrefix,
    })
    instance.emit('message', { ok: true, result })

    await expect(verification).resolves.toEqual(result)
    expect(instance.terminate).toHaveBeenCalledOnce()
  })

  it('reconstructs a Worker-reported error', async () => {
    const verification = verifyCurrentGenerationInWorker('/stage', 'zstd', 'session', 0)
    worker().emit('message', { ok: false, message: 'invalid stage', stack: 'worker stack' })

    await expect(verification).rejects.toMatchObject({ message: 'invalid stage', stack: 'worker stack' })
  })

  it('accepts an error response without a stack', async () => {
    const verification = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0)
    worker().emit('message', { ok: false, message: 'invalid stage' })
    await expect(verification).rejects.toThrow('invalid stage')
  })

  it.each([
    ['invalid response', 'message', null, /invalid response/],
    ['non-object response', 'message', 'invalid', /invalid response/],
    ['missing discriminator', 'message', {}, /invalid response/],
    ['invalid discriminator', 'message', { ok: 'yes' }, /invalid response/],
    ['missing result', 'message', { ok: true }, /invalid response/],
    ['invalid result', 'message', { ok: true, result: { ...result, bytes: -1 } }, /invalid response/],
    ['invalid digest', 'message', { ok: true, result: { ...result, digest: 'invalid' } }, /invalid response/],
    ['invalid identity', 'message', { ok: true, result: { ...result, identity: {} } }, /invalid response/],
    ['invalid error message', 'message', { ok: false, message: 1 }, /invalid response/],
    ['invalid error stack', 'message', { ok: false, message: 'invalid', stack: {} }, /invalid response/],
    ['worker error', 'error', new Error('worker failed'), /worker failed/],
    ['early exit', 'exit', 7, /code 7/],
  ])('rejects an %s', async (_name, event, value, expected) => {
    const verification = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0)
    worker().emit(event, value)
    await expect(verification).rejects.toThrow(expected)
  })

  it('retains both Worker and termination failures as an unavailable resource', async () => {
    const verification = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0)
    const instance = worker()
    const cleanup = new Error('terminate failed')
    const failure = new Error('worker failed')
    instance.terminate.mockRejectedValueOnce(cleanup)
    instance.emit('error', failure)

    const error: unknown = await verification.catch((error: unknown) => error)
    expect(error).toMatchObject({ reason: 'unavailable' })
    const cause = (error as Error).cause
    expect(cause).toBeInstanceOf(AggregateError)
    const errors = (cause as AggregateError).errors as unknown[]
    expect(errors[0]).toMatchObject({ reason: 'unavailable', cause: failure })
    expect(errors[1]).toBe(cleanup)
  })

  it('rejects a successful result when termination fails', async () => {
    const verification = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0)
    const instance = worker()
    instance.terminate.mockRejectedValueOnce('terminate failed')
    instance.emit('message', { ok: true, result })

    await expect(verification).rejects.toThrow('terminate failed')
  })

  it('preserves an Error from successful-result termination', async () => {
    const verification = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0)
    const instance = worker()
    instance.terminate.mockRejectedValueOnce(new Error('terminate failed'))
    instance.emit('message', { ok: true, result })

    await expect(verification).rejects.toThrow('terminate failed')
  })

  it('ignores terminal signals after a result settles', async () => {
    const verification = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0)
    const instance = worker()
    instance.emit('message', { ok: true, result })
    instance.emit('error', new Error('late error'))
    instance.emit('exit', 1)
    instance.emit('message', null)

    await expect(verification).resolves.toEqual(result)
    expect(instance.terminate).toHaveBeenCalledOnce()
  })

  it('starts at most two verification Workers concurrently', async () => {
    const first = verifyCurrentGenerationInWorker('/first', 'none', 'session', 0)
    const second = verifyCurrentGenerationInWorker('/second', 'none', 'session', 0)
    const third = verifyCurrentGenerationInWorker('/third', 'none', 'session', 0)
    expect(state.workers).toHaveLength(2)

    worker(0).emit('message', { ok: true, result })
    await first
    await vi.waitFor(() => { expect(state.workers).toHaveLength(3) })

    worker(1).emit('message', { ok: true, result })
    worker(2).emit('message', { ok: true, result })
    await expect(Promise.all([second, third])).resolves.toEqual([result, result])
  })

  it('hands a released permit directly to the oldest waiter', async () => {
    const first = verifyCurrentGenerationInWorker('/first', 'none', 'session', 0)
    const second = verifyCurrentGenerationInWorker('/second', 'none', 'session', 0)
    const third = verifyCurrentGenerationInWorker('/third', 'none', 'session', 0)
    let fourth: Promise<typeof result> | undefined
    worker(0).terminate.mockReturnValueOnce({
      then(onFulfilled: (value: number) => unknown) {
        onFulfilled(0)
        queueMicrotask(() => {
          fourth = verifyCurrentGenerationInWorker('/fourth', 'none', 'session', 0)
        })
        return Promise.resolve()
      },
    } as unknown as Promise<number>)

    worker(0).emit('message', { ok: true, result })
    await first
    await vi.waitFor(() => { expect(state.workers).toHaveLength(3) })
    expect(worker(2).options.workerData).toMatchObject({ path: '/third' })

    worker(1).emit('message', { ok: true, result })
    await second
    await vi.waitFor(() => { expect(state.workers).toHaveLength(4) })
    expect(worker(3).options.workerData).toMatchObject({ path: '/fourth' })
    if (fourth === undefined) throw new Error('fourth verification was not scheduled')

    worker(2).emit('message', { ok: true, result })
    worker(3).emit('message', { ok: true, result })
    await expect(Promise.all([third, fourth])).resolves.toEqual([result, result])
  })

  it('removes an aborted waiter without starting another Worker', async () => {
    const first = verifyCurrentGenerationInWorker('/first', 'none', 'session', 0)
    const second = verifyCurrentGenerationInWorker('/second', 'none', 'session', 0)
    const controller = new AbortController()
    const reason = new Error('queued verification cancelled')
    const queued = verifyCurrentGenerationInWorker(
      '/queued', 'none', 'session', 0, undefined, controller.signal,
    )

    controller.abort(reason)
    await expect(queued).rejects.toBe(reason)
    expect(state.workers).toHaveLength(2)

    worker(0).emit('message', { ok: true, result })
    worker(1).emit('message', { ok: true, result })
    await expect(Promise.all([first, second])).resolves.toEqual([result, result])
    expect(state.workers).toHaveLength(2)
  })

  it('terminates an active Worker before rejecting cancellation', async () => {
    const controller = new AbortController()
    const reason = new Error('active verification cancelled')
    const verification = verifyCurrentGenerationInWorker(
      '/stage', 'none', 'session', 0, undefined, controller.signal,
    )
    const instance = worker()
    let finishTermination: ((value: number) => void) | undefined
    instance.terminate.mockReturnValueOnce(new Promise((resolve) => {
      finishTermination = resolve
    }))
    let settled = false
    void verification.then(
      () => { settled = true },
      () => { settled = true },
    )

    controller.abort(reason)
    expect(instance.terminate).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(settled).toBe(false)

    finishTermination?.(0)
    await expect(verification).rejects.toBe(reason)
  })

  it('wraps a non-Error active cancellation reason', async () => {
    const controller = new AbortController()
    const verification = verifyCurrentGenerationInWorker(
      '/stage', 'none', 'session', 0, undefined, controller.signal,
    )

    controller.abort('cancelled')
    await expect(verification).rejects.toMatchObject({
      message: 'migration verifier aborted',
      cause: 'cancelled',
    })
  })
})
