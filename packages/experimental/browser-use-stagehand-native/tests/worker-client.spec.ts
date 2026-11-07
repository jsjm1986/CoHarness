/** Real Workers pin explicit configuration, initialization, drainage, and termination. */

import { once } from 'node:events'
import { AsyncLocalStorage } from 'node:async_hooks'
import { connect } from 'node:net'
import type { Worker } from 'node:worker_threads'
import type { ResourceLease, ResourceRequest } from '@deepseek-ai/dsh-resource-budget'
import { ResourceAcquisitionCleanupError } from '@deepseek-ai/dsh-experimental-browser-use-runtime'
import { afterEach, expect, it, vi } from 'vitest'
import { openBrowserWorker, type BrowserWorkerAdmission } from '../src/worker-client.ts'
import type { NativeBrowserConfig, NativeBrowserRuntime } from '../src/native.ts'
import { nativeModel } from './fixtures/stagehand.ts'

const state = vi.hoisted(() => ({ workers: [] as Worker[], entries: [] as string[], allocationError: undefined as Error | undefined }))
vi.mock('node:worker_threads', async (importActual) => {
  const actual = await importActual<typeof import('node:worker_threads')>()
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(entry: URL, options: import('node:worker_threads').WorkerOptions) {
        if (state.allocationError !== undefined) throw state.allocationError
        super(new URL('./fixtures/attachment-worker.mjs', import.meta.url), options)
        state.entries.push(entry.href)
        state.workers.push(this)
      }
    },
  }
})

const runtimes: NativeBrowserRuntime[] = []
const warn = vi.fn()
const model = vi.fn(async () => ({ role: 'assistant', outputFormat: 'text', content: { type: 'text', text: '{}' } }))
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()))
  await Promise.all(state.workers.splice(0).map(worker => worker.terminate()))
  state.entries = []
  state.allocationError = undefined
  vi.unstubAllEnvs()
  warn.mockClear()
  model.mockClear()
})

function config(scenario = 'ready'): NativeBrowserConfig {
  return { model: nativeModel, mode: 'attach', cdpEndpoint: `fixture://${scenario}`, headless: true, operationTimeoutMs: 30000, shutdownGraceMs: 1000 }
}

async function open(scenario = 'ready') {
  const runtime = await openBrowserWorker(config(scenario), new AbortController().signal, warn, model)
  runtimes.push(runtime)
  return runtime
}

function event(worker: Worker, name: string): Promise<void> {
  return new Promise((resolve) => {
    const receive = (value: { event?: string }) => {
      if (value.event !== name) return
      worker.off('message', receive)
      resolve()
    }
    worker.on('message', receive)
  })
}

function managed() {
  const grant = Promise.withResolvers<ResourceLease>(), requested = Promise.withResolvers<ResourceRequest>()
  const cancelled = new AbortController()
  const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
  const lease: ResourceLease = { signal: cancelled.signal, release, uncertain }
  const acquire = vi.fn((request: ResourceRequest) => { requested.resolve(request); return grant.promise })
  const admission: BrowserWorkerAdmission = { budget: { acquire }, sessionId: 'browser-owner' as BrowserWorkerAdmission['sessionId'] }
  return { grant, requested, cancelled, release, uncertain, lease, acquire, admission }
}

it('refuses a rejected Worker admission before allocation', async () => {
  const owner = managed()
  owner.acquire.mockRejectedValueOnce(new Error('node queue full'))
  await expect(openBrowserWorker(config(), new AbortController().signal, warn, model, owner.admission)).rejects.toThrow('node queue full')
  expect(state.workers).toEqual([])
  expect(owner.release).not.toHaveBeenCalled()
})

it('returns the original grant when its owner changes during admission', async () => {
  const owner = managed()
  let current = true
  const admission = { ...owner.admission, assertOwnership() {
    if (!current) throw new Error('browser resource owner changed')
  } }
  const opening = openBrowserWorker(config(), new AbortController().signal, warn, model, admission).then((runtime) => {
    runtimes.push(runtime)
    return runtime
  })
  try {
    await owner.requested.promise
    current = false
    owner.grant.resolve(owner.lease)
    await expect(opening).rejects.toThrow('browser resource owner changed')
    expect(state.workers).toEqual([])
    expect(owner.release).toHaveBeenCalledOnce()
    expect(owner.uncertain).not.toHaveBeenCalled()
  } finally {
    owner.grant.resolve(owner.lease)
    await opening.catch(() => { /* The assertion owns the rejected acquisition. */ })
  }
})

it('terminates a ready Worker before publishing it when its owner changes', async () => {
  const owner = managed()
  owner.grant.resolve(owner.lease)
  const admission = { ...owner.admission, assertOwnership() {
    if (state.workers.length > 0) throw new Error('browser owner changed during connection')
  } }
  const opening = openBrowserWorker(config(), new AbortController().signal, warn, model, admission).then((runtime) => {
    runtimes.push(runtime)
    return runtime
  })
  await expect(opening).rejects.toThrow('browser owner changed during connection')
  expect(state.workers).toHaveLength(1)
  expect(state.workers[0]?.threadId).toBe(-1)
  expect(owner.release).toHaveBeenCalledOnce()
  expect(owner.uncertain).not.toHaveBeenCalled()
})

it('retains retryable completion when a cancelled unused grant cannot be returned', async () => {
  const owner = managed(), controller = new AbortController()
  owner.release.mockRejectedValueOnce(new Error('accountant offline'))
  const opening = openBrowserWorker(config(), controller.signal, warn, model, owner.admission)
  const failure = opening.catch((error: unknown) => error)
  await owner.requested.promise
  controller.abort(new Error('cancel browser acquisition'))
  owner.grant.resolve(owner.lease)
  const error = await failure
  expect(error).toBeInstanceOf(ResourceAcquisitionCleanupError)
  const retained = error as ResourceAcquisitionCleanupError
  expect(retained.cause).toBeInstanceOf(AggregateError)
  expect((retained.cause as AggregateError).errors.map((item: Error) => item.message))
    .toEqual(['cancel browser acquisition', 'accountant offline'])
  expect(state.workers).toEqual([])
  const completing: PromiseWithResolvers<undefined> = Promise.withResolvers()
  owner.release.mockImplementationOnce(() => completing.promise)
  const first = retained.cleanup(), second = retained.cleanup()
  completing.resolve(undefined)
  await Promise.all([first, second, retained.cleanup()])
  expect(owner.release).toHaveBeenCalledTimes(2)
  expect(owner.uncertain).not.toHaveBeenCalled()
})

it.each(['before admission', 'before allocation', 'before publication'])('observes cancellation from the ownership guard %s', async (phase) => {
  const owner = managed(), controller = new AbortController()
  owner.grant.resolve(owner.lease)
  let checks = 0
  const target = { 'before admission': 1, 'before allocation': 2, 'before publication': 3 }[phase]
  await expect(openBrowserWorker(config(), controller.signal, warn, model, {
    ...owner.admission,
    assertOwnership() { if (++checks === target) controller.abort(new Error('ownership check canceled browser')) },
  })).rejects.toThrow('ownership check canceled browser')
  expect(state.workers).toHaveLength(phase === 'before publication' ? 1 : 0)
  expect(state.workers.every(worker => worker.threadId === -1)).toBe(true)
  expect(owner.release).toHaveBeenCalledTimes(phase === 'before admission' ? 0 : 1)
})

it('retains uncertain occupation when Worker allocation throws', async () => {
  const owner = managed()
  owner.grant.resolve(owner.lease)
  state.allocationError = new Error('Worker allocation unavailable')
  await expect(openBrowserWorker(config(), new AbortController().signal, warn, model, owner.admission)).rejects.toThrow('Worker allocation unavailable')
  expect(state.workers).toEqual([])
  expect(owner.uncertain).toHaveBeenCalledOnce()
  expect(owner.release).not.toHaveBeenCalled()
})

it('retains allocation and accounting failures until its original uncertain report succeeds', async () => {
  const owner = managed(), allocation = new Error('Worker allocation unavailable'), accounting = new Error('accountant offline')
  owner.grant.resolve(owner.lease)
  state.allocationError = allocation
  owner.uncertain.mockRejectedValueOnce(accounting)
  const failure = await openBrowserWorker(config(), new AbortController().signal, warn, model, owner.admission)
    .catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(ResourceAcquisitionCleanupError)
  const retained = failure as ResourceAcquisitionCleanupError
  expect(retained.cause).toBeInstanceOf(AggregateError)
  expect((retained.cause as AggregateError).errors).toEqual([allocation, accounting])
  expect(state.workers).toEqual([])
  const retrying = Promise.withResolvers<undefined>()
  owner.uncertain.mockImplementationOnce(() => retrying.promise)
  const first = retained.cleanup(), second = retained.cleanup()
  retrying.resolve(undefined)
  await Promise.all([first, second, retained.cleanup()])
  expect(owner.uncertain).toHaveBeenCalledTimes(2)
  expect(owner.release).not.toHaveBeenCalled()
})

it('returns a cancelled late grant before allocating a browser Worker', async () => {
  const owner = managed(), controller = new AbortController()
  const opening = openBrowserWorker(config(), controller.signal, warn, model, owner.admission).then((runtime) => {
    runtimes.push(runtime)
    return runtime
  })
  try {
    expect(await Promise.race([owner.requested.promise.then(() => 'waiting'), opening.then(() => 'allocated')])).toBe('waiting')
    expect(await owner.requested.promise).toMatchObject({ kind: 'process', sessionId: 'browser-owner', signal: controller.signal })
    expect(state.workers).toEqual([])
    const rejected = expect(opening).rejects.toThrow('cancel browser admission')
    controller.abort(new Error('cancel browser admission'))
    owner.grant.resolve(owner.lease)
    await rejected
    expect(state.workers).toEqual([])
    expect(owner.release).toHaveBeenCalledOnce()
    expect(owner.uncertain).not.toHaveBeenCalled()
  } finally {
    controller.abort()
    owner.grant.resolve(owner.lease)
    await opening.catch(() => { /* the assertion owns the expected opening rejection */ })
  }
})

it('holds a granted Worker permit until the thread terminates', async () => {
  const owner = managed()
  owner.grant.resolve(owner.lease)
  const runtime = await openBrowserWorker(config(), new AbortController().signal, warn, model, owner.admission)
  runtimes.push(runtime)
  expect(state.workers[0]?.threadId).not.toBe(-1)
  expect(owner.release).not.toHaveBeenCalled()
  await runtime.close()
  expect(state.workers[0]?.threadId).toBe(-1)
  expect(owner.release).toHaveBeenCalledOnce()
  expect(owner.uncertain).not.toHaveBeenCalled()
})

it('terminates a published Worker when its node permit is withdrawn', async () => {
  const owner = managed()
  owner.grant.resolve(owner.lease)
  const runtime = await openBrowserWorker(config(), new AbortController().signal, warn, model, owner.admission)
  runtimes.push(runtime)
  owner.cancelled.abort(new Error('node permit withdrawn'))
  await vi.waitFor(() => { expect(state.workers[0]?.threadId).toBe(-1) })
  expect(owner.release).toHaveBeenCalledOnce()
  await expect(runtime.execute('tabs', { action: 'list' })).rejects.toThrow('node permit withdrawn')
})

it('retains uncertain accounting after termination failure and can retry its owned cleanup', async () => {
  const owner = managed()
  owner.grant.resolve(owner.lease)
  const runtime = await openBrowserWorker(config(), new AbortController().signal, warn, model, owner.admission)
  runtimes.push(runtime)
  const worker = state.workers[0]!
  const termination = vi.spyOn(worker, 'terminate').mockRejectedValueOnce(new Error('Worker termination unavailable'))
  try {
    await expect(runtime.close()).rejects.toThrow('Worker termination unavailable')
    expect(worker.threadId).not.toBe(-1)
    expect(() => worker.emit('error', new Error('late Worker failure'))).not.toThrow()
    expect(owner.release).not.toHaveBeenCalled()
    expect(owner.uncertain).toHaveBeenCalledOnce()
  } finally { termination.mockRestore() }
  await expect(runtime.close()).resolves.toBeUndefined()
  await vi.waitFor(() => { expect(owner.release).toHaveBeenCalledOnce() })
})

it('reports a failed completion after proving the Worker stopped', async () => {
  const owner = managed()
  owner.grant.resolve(owner.lease)
  owner.release.mockRejectedValueOnce(new Error('coordinator offline'))
  const runtime = await openBrowserWorker(config(), new AbortController().signal, warn, model, owner.admission)
  runtimes.push(runtime)
  await expect(runtime.close()).rejects.toThrow('coordinator offline')
  expect(state.workers[0]?.threadId).toBe(-1)
  expect(warn).toHaveBeenCalledWith('Stagehand Worker resource completion could not be confirmed.')
  await expect(runtime.close()).resolves.toBeUndefined()
  expect(owner.release).toHaveBeenCalledTimes(2)
})

it('retains a Worker whose acquisition cancellation cannot terminate its thread', async () => {
  const owner = managed(), controller = new AbortController()
  owner.grant.resolve(owner.lease)
  const opening = openBrowserWorker(config('opening'), controller.signal, warn, model, owner.admission)
  const rejected = expect(opening).rejects.toBeInstanceOf(ResourceAcquisitionCleanupError)
  await vi.waitFor(() => { expect(state.workers).toHaveLength(1) })
  const worker = state.workers[0]!
  const termination = vi.spyOn(worker, 'terminate').mockRejectedValue(new Error('Worker termination unavailable'))
  try {
    controller.abort(new Error('cancel opening'))
    await rejected
    expect(worker.threadId).not.toBe(-1)
    expect(owner.uncertain).toHaveBeenCalled()
    expect(owner.release).not.toHaveBeenCalled()
  } finally { termination.mockRestore(); await worker.terminate() }
})

it.each([false, true])('retains failed initialization cleanup until confirmed exit (exit before retry: %s)', async (alreadyExited) => {
  const controller = new AbortController()
  const opening = openBrowserWorker(config('opening'), controller.signal, warn, model)
    .catch((error: unknown) => error)
  await vi.waitFor(() => { expect(state.workers).toHaveLength(1) })
  const worker = state.workers[0]!
  const termination = vi.spyOn(worker, 'terminate').mockRejectedValue(new Error('Worker termination unavailable'))
  try {
    controller.abort(new Error('cancel opening'))
    const failure = await opening
    expect(worker.threadId).not.toBe(-1)
    expect(failure).toBeInstanceOf(ResourceAcquisitionCleanupError)
    expect(typeof (failure as ResourceAcquisitionCleanupError).cleanup).toBe('function')
    await expect((failure as { cleanup: () => Promise<void> }).cleanup()).rejects.toThrow('Worker termination unavailable')
    termination.mockRestore()
    if (alreadyExited) await worker.terminate()
    await (failure as { cleanup: () => Promise<void> }).cleanup()
    expect(worker.threadId).toBe(-1)
  } finally { termination.mockRestore(); await worker.terminate() }
})

it('passes only its non-secret model route without ambient environment and awaits Worker listener release', async () => {
  vi.stubEnv('STAGEHAND_FIXTURE_TOKEN', 'ambient-secret')
  vi.stubEnv('HTTP_PROXY', 'https://ambient-proxy.example')
  const runtime = await open()
  const worker = state.workers[0]!
  expect(decodeURIComponent(state.entries[0]!)).toContain('tsx')
  const { port, model, env } = await runtime.execute('tabs', { action: 'list' }) as { port: number; model: unknown; env: Record<string, string> }
  expect(model).toEqual(nativeModel)
  expect(env.STAGEHAND_FIXTURE_TOKEN).toBeUndefined()
  expect(env.HTTP_PROXY).toBeUndefined()
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  socket.destroy()
  const exited = once(worker, 'exit')
  await runtime.close()
  await exited
  expect(worker.threadId).toBe(-1)
  const disconnected = connect(port, '127.0.0.1')
  const [error] = await once(disconnected, 'error') as [Error]
  expect((error as NodeJS.ErrnoException).code).toBe('ECONNREFUSED')
})

it('runs every model callback under its current tool operation context', async () => {
  const actors = new AsyncLocalStorage<string>()
  const seen: string[] = []
  const inference = vi.fn(async (_input: unknown, signal: AbortSignal) => {
    signal.throwIfAborted()
    seen.push(actors.getStore() ?? 'missing actor')
    return actors.getStore()
  })
  const runtime = await actors.run('connection-creator', () => openBrowserWorker(config('model'), new AbortController().signal, warn, inference))
  runtimes.push(runtime)
  expect(await actors.run('first actor', () => runtime.execute('extract', { instruction: 'First' }))).toEqual(['first actor', 'first actor'])
  expect(await actors.run('second actor', () => runtime.execute('extract', { instruction: 'Second' }))).toEqual(['second actor', 'second actor'])
  expect(seen).toEqual(['first actor', 'first actor', 'second actor', 'second actor'])
  expect(inference).toHaveBeenCalledTimes(4)
})

it('refuses inference during Worker initialization before a tool operation exists', async () => {
  await expect(open('early-model')).rejects.toThrow('require an active browser operation')
  expect(model).not.toHaveBeenCalled()
  expect(state.workers[0]?.threadId).toBe(-1)
})

it('closes the Worker after a malformed inference envelope without dispatching a model', async () => {
  const runtime = await open('malformed-model')
  await expect(runtime.execute('extract', { instruction: 'Malformed request' })).rejects.toThrow()
  await vi.waitFor(() => { expect(state.workers[0]?.threadId).toBe(-1) })
  await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('Stagehand Worker protocol cleanup failed.') })
  expect(warn).toHaveBeenCalledWith('Stagehand Worker model protocol failed; its connection is closing.')
  expect(model).not.toHaveBeenCalled()
})

it('refuses overlapping tool operations without changing the active inference owner', async () => {
  const entered = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<string>()
  const inference = vi.fn(async () => { entered.resolve(undefined); return finish.promise })
  const runtime = await openBrowserWorker(config('model'), new AbortController().signal, warn, inference)
  runtimes.push(runtime)
  const active = runtime.execute('extract', { instruction: 'Active request' })
  try {
    await entered.promise
    await expect(runtime.execute('tabs', { action: 'list' })).rejects.toThrow('already has an active operation')
    finish.resolve('Original owner')
    expect(await active).toEqual(['Original owner', 'Original owner'])
  } finally {
    finish.resolve('Original owner')
    await active
  }
})

it('cancels host inference and waits for its settlement before connection shutdown completes', async () => {
  const entered = Promise.withResolvers<undefined>(), canceled = Promise.withResolvers<undefined>()
  const settled = Promise.withResolvers<undefined>()
  const controller = new AbortController()
  const inference = vi.fn(async (_input: unknown, signal: AbortSignal) => {
    entered.resolve(undefined)
    signal.addEventListener('abort', () => { canceled.resolve(undefined) }, { once: true })
    await settled.promise
    signal.throwIfAborted()
    return 'unreachable inference'
  })
  const runtime = await openBrowserWorker(config('model'), controller.signal, warn, inference)
  runtimes.push(runtime)
  const operation = runtime.execute('extract', { instruction: 'Wait for inference' }, controller.signal)
  const rejected = expect(operation).rejects.toThrow('connection is closing')
  let closed = false
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    closing = runtime.close().then(() => { closed = true })
    await canceled.promise
    expect(closed).toBe(false)
    expect(state.workers[0]?.threadId).not.toBe(-1)
    settled.resolve(undefined)
    await closing
    await rejected
    expect(state.workers[0]?.threadId).toBe(-1)
    expect(inference).toHaveBeenCalledOnce()
  } finally {
    settled.resolve(undefined)
    controller.abort()
    await operation.catch(() => { /* expected operation cancellation */ })
    await closing
  }
})

it('bounds a queued model callback by the browser operation timeout', async () => {
  const entered = Promise.withResolvers<undefined>(), canceled = Promise.withResolvers<undefined>()
  const inference = vi.fn(async (_input: unknown, signal: AbortSignal) => {
    entered.resolve(undefined)
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { canceled.resolve(undefined); resolve() }, { once: true }) })
    signal.throwIfAborted()
    return 'unreachable inference'
  })
  const runtime = await openBrowserWorker({ ...config('model'), operationTimeoutMs: 20 }, new AbortController().signal, warn, inference)
  runtimes.push(runtime)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const operation = runtime.execute('extract', { instruction: 'Wait for capacity' })
    const rejected = expect(operation).rejects.toThrow('operation timed out')
    await entered.promise
    await vi.advanceTimersByTimeAsync(20)
    await canceled.promise
    await rejected
    await runtime.close()
    expect(state.workers[0]?.threadId).toBe(-1)
  } finally { vi.useRealTimers() }
})

it('preserves initialization failures while terminating the failed Worker', async () => {
  await expect(open('failure')).rejects.toThrow('Extension initialization failed')
  expect(state.workers[0]?.threadId).toBe(-1)
})

it('terminates a Worker whose initialization overlaps acquisition cancellation', async () => {
  const controller = new AbortController()
  const opening = openBrowserWorker(config('opening'), controller.signal, warn, model)
  const observed = expect(opening).rejects.toThrow('Acquisition canceled')
  await vi.waitFor(() => { expect(state.workers).toHaveLength(1) })
  controller.abort(new Error('Acquisition canceled'))
  await observed
  expect(state.workers[0]?.threadId).toBe(-1)
})

it('fails active and later operations when the Worker exits', async () => {
  const runtime = await open('crash')
  const exited = once(state.workers[0]!, 'exit')
  await expect(runtime.execute('tabs', { action: 'list' })).rejects.toThrow(/Worker (exited|reply channel closed)/u)
  await exited
  await expect(runtime.execute('tabs', { action: 'list' })).rejects.toThrow('Worker exited (23)')
  await expect(runtime.close()).rejects.toThrow('Worker exited (23)')
})

it.each(['closing', 'close-failure'])('rejects cleanup after an undrained extension (%s) even though its Worker terminates', async (scenario) => {
  const runtime = await openBrowserWorker({ ...config(scenario), shutdownGraceMs: 20 }, new AbortController().signal, warn, model)
  runtimes.push(runtime)
  const closing = runtime.close()
  const rejected = expect(closing).rejects.toThrow(/cleanup timed out|did not drain/u)
  await expect(runtime.execute('tabs', { action: 'list' })).rejects.toThrow('Worker is closed')
  await rejected
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('SDK cleanup did not finish'))
  expect(state.workers[0]?.threadId).toBe(-1)
  await expect(runtime.close()).rejects.toThrow()
})

it('rejects cleanup after a Worker crashes', async () => {
  const runtime = await open('error')
  await expect(runtime.execute('tabs', { action: 'list' })).rejects.toThrow()
  await expect(runtime.close()).rejects.toThrow()
  expect(state.workers[0]?.threadId).toBe(-1)
})

it('preserves the explicit source tsconfig for its Worker', async () => {
  vi.stubEnv('TSX_TSCONFIG_PATH', '/fixture/tsconfig.json')
  const runtime = await open()
  expect(await runtime.execute('tabs', { action: 'list' })).toMatchObject({ env: { TSX_TSCONFIG_PATH: '/fixture/tsconfig.json' } })
})

it('waits for the active extension request to drain after cancellation', async () => {
  const runtime = await open()
  const worker = state.workers[0]!
  const entered = event(worker, 'operation-started')
  const closing = event(worker, 'close-started')
  const controller = new AbortController()
  const operation = runtime.execute('act', { instruction: 'Read the page' }, controller.signal)
  const canceled = expect(operation).rejects.toThrow('Cancel browser call')
  await entered
  controller.abort(new Error('Cancel browser call'))
  await closing
  let closed = false
  const drainage = runtime.close().then(() => { closed = true })
  try {
    expect(closed).toBe(false)
    expect(worker.threadId).not.toBe(-1)
  } finally {
    worker.postMessage({ method: 'fixture-release' })
    await canceled
    await drainage
  }
  expect(worker.threadId).toBe(-1)
})

it('reports failed Worker termination during canceled request cleanup', async () => {
  const runtime = await open()
  const worker = state.workers[0]!
  const terminate = worker.terminate.bind(worker)
  const refused = vi.spyOn(worker, 'terminate').mockRejectedValueOnce(new Error('Worker shutdown refused'))
  const entered = event(worker, 'operation-started')
  const controller = new AbortController()
  const operation = runtime.execute('act', {}, controller.signal)
  const canceled = expect(operation).rejects.toThrow('Cancel active call')
  try {
    await entered
    controller.abort(new Error('Cancel active call'))
    const cleanup = expect(runtime.close()).rejects.toThrow('Worker shutdown refused')
    worker.postMessage({ method: 'fixture-release' })
    await canceled
    await cleanup
  } finally {
    refused.mockRestore()
    await terminate()
  }
})
