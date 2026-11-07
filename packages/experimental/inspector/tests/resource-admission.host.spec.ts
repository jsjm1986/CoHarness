/** Real Inspector Workers cannot start before their node process admission. */

import { afterEach, expect, it, vi } from 'vitest'
import { InspectorStartupCleanupError, startInspector, type InspectorHandle } from '../src/host/bridge/controller.ts'
import { ResourceAdmissionError, type ResourceLease, type ResourceRequest } from '@deepseek-ai/dsh-resource-budget'
import type { Worker } from 'node:worker_threads'

const threads = vi.hoisted(() => ({
  workers: [] as Worker[], allocationError: undefined as Error | undefined, pauseStartup: false,
}))
vi.mock('node:worker_threads', async (importActual) => {
  const actual = await importActual<typeof import('node:worker_threads')>()
  return { ...actual, Worker: class extends actual.Worker {
    constructor(entry: URL, options: import('node:worker_threads').WorkerOptions) {
      if (threads.allocationError !== undefined) throw threads.allocationError
      super(threads.pauseStartup ? new URL('data:text/javascript,setInterval(() => {}, 1000)') : entry, options)
      threads.workers.push(this)
    }
  } }
})

const inspectors: InspectorHandle[] = []
afterEach(async () => {
  await Promise.allSettled(inspectors.splice(0).map(inspector => inspector.close()))
  await Promise.all(threads.workers.splice(0).map(worker => worker.terminate()))
  threads.allocationError = undefined
  threads.pauseStartup = false
})

function managed() {
  const grant = Promise.withResolvers<ResourceLease>(), requested = Promise.withResolvers<ResourceRequest>()
  const controller = new AbortController()
  const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
  const lease: ResourceLease = { signal: controller.signal, release, uncertain }
  const acquire = vi.fn((request: ResourceRequest) => { requested.resolve(request); return grant.promise })
  return { grant, requested, controller, release, uncertain, lease, budget: { acquire } }
}

it.each(['failure', 'cancellation'] as const)('returns unused admission after the caller ownership check causes %s', async (mode) => {
  const owner = managed(), controller = new AbortController()
  const reason = new ResourceAdmissionError('unavailable', 'Inspector owner changed')
  owner.grant.resolve(owner.lease)
  const assertOwnership = vi.fn(() => {
    if (mode === 'cancellation') controller.abort(reason)
    else throw reason
  })
  await expect(startInspector({ port: 0, captureFetch: false }, {
    budget: owner.budget, signal: controller.signal, assertOwnership,
  })).rejects.toBe(reason)
  expect(assertOwnership).toHaveBeenCalledOnce()
  expect(threads.workers).toEqual([])
  expect(owner.release).toHaveBeenCalledOnce()
  expect(owner.uncertain).not.toHaveBeenCalled()
})

it('checks an independent caller after the asynchronous admission handoff', async () => {
  const reason = new ResourceAdmissionError('unavailable', 'Independent ownership changed')
  await expect(startInspector({ port: 0, captureFetch: false }, {
    budget: undefined, assertOwnership() { throw reason },
  })).rejects.toBe(reason)
  expect(threads.workers).toEqual([])
})

it('transfers failed unused-grant accounting and coalesces its explicit retry', async () => {
  const owner = managed(), completed = Promise.withResolvers<undefined>()
  const reason = new ResourceAdmissionError('unavailable', 'Inspector owner changed'), reporting = new Error('coordinator unavailable')
  let recovered = false
  owner.release.mockImplementation(async () => {
    if (!recovered) throw reporting
    await completed.promise
  })
  owner.grant.resolve(owner.lease)
  const failure = await startInspector({ port: 0, captureFetch: false }, {
    budget: owner.budget, assertOwnership() { throw reason },
  }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(InspectorStartupCleanupError)
  if (!(failure instanceof InspectorStartupCleanupError)) throw new Error('Unused grant did not retain cleanup')
  expect(failure.cause).toMatchObject({ errors: [reason, reporting] })
  expect(threads.workers).toEqual([])
  expect(owner.release).toHaveBeenCalledOnce()
  expect(owner.uncertain).not.toHaveBeenCalled()
  recovered = true
  const first = failure.cleanup(), second = failure.cleanup()
  expect(first).toBe(second)
  completed.resolve(undefined)
  await Promise.all([first, second])
  await failure.cleanup()
  expect(owner.release).toHaveBeenCalledTimes(2)
})

it('refuses a denied infrastructure Worker before publishing an endpoint', async () => {
  const acquire = vi.fn().mockRejectedValue(new Error('node process queue full'))
  const opening = startInspector({ port: 0, captureFetch: false }, { budget: { acquire } }).then((inspector) => {
    inspectors.push(inspector)
    return inspector
  })
  await expect(opening).rejects.toThrow('node process queue full')
  expect(acquire).toHaveBeenCalledWith({ kind: 'process', origin: 'infrastructure' })
  expect(threads.workers).toEqual([])
})

it('returns a canceled late grant before creating its infrastructure Worker', async () => {
  const owner = managed(), controller = new AbortController()
  const opening = startInspector({ port: 0, captureFetch: false }, { budget: owner.budget, signal: controller.signal })
  const rejected = expect(opening).rejects.toThrow('cancel Inspector startup')
  try {
    expect(await owner.requested.promise).toMatchObject({ kind: 'process', origin: 'infrastructure' })
    expect(threads.workers).toEqual([])
    controller.abort(new Error('cancel Inspector startup'))
    owner.grant.resolve(owner.lease)
    await rejected
    expect(threads.workers).toEqual([])
    expect(owner.release).toHaveBeenCalledOnce()
    expect(owner.uncertain).not.toHaveBeenCalled()
  } finally { controller.abort(); owner.grant.resolve(owner.lease); await opening.catch(() => {}) }
})

it('holds infrastructure capacity through actual Worker exit and disconnects every endpoint', async () => {
  const owner = managed()
  owner.grant.resolve(owner.lease)
  const inspector = await startInspector({ port: 0, captureFetch: false }, { budget: owner.budget })
  inspectors.push(inspector)
  expect(await fetch(new URL('json/list', inspector.endpoint.httpUrl)).then(response => response.status)).toBe(200)
  expect(owner.release).not.toHaveBeenCalled()
  await inspector.close()
  expect(threads.workers[0]?.threadId).toBe(-1)
  expect(owner.release).toHaveBeenCalledOnce()
  await expect(fetch(inspector.endpoint.httpUrl)).rejects.toThrow()
})

it('closes the published Inspector when its infrastructure permit is withdrawn', async () => {
  const owner = managed()
  owner.grant.resolve(owner.lease)
  const inspector = await startInspector({ port: 0, captureFetch: false }, { budget: owner.budget })
  inspectors.push(inspector)
  owner.controller.abort(new Error('node resource policy changed'))
  await inspector.close()
  expect(threads.workers[0]?.threadId).toBe(-1)
  expect(owner.release).toHaveBeenCalledOnce()
})

it('retries unacknowledged resource completion after its published Worker and HTTP endpoint have stopped', async () => {
  const owner = managed()
  let connected = false, occupied = true
  owner.release.mockImplementation(async () => {
    if (!connected) throw new Error('resource coordinator unavailable')
    occupied = false
  })
  owner.grant.resolve(owner.lease)
  const inspector = await startInspector({ port: 0, captureFetch: false }, { budget: owner.budget })
  inspectors.push(inspector)
  const warning = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const first = inspector.close(), concurrent = inspector.close()
    await expect(first).rejects.toThrow('shutdown failed')
    await expect(concurrent).rejects.toThrow('shutdown failed')
    expect(threads.workers[0]?.threadId).toBe(-1)
    await expect(fetch(inspector.endpoint.httpUrl)).rejects.toThrow()
    expect(occupied).toBe(true)
    connected = true
    await Promise.all([inspector.close(), inspector.close()])
    expect(occupied).toBe(false)
    const acknowledged = owner.release.mock.calls.length
    await inspector.close()
    expect(owner.release).toHaveBeenCalledTimes(acknowledged)
  } finally { connected = true; warning.mockRestore() }
})

it('allows transferred startup cleanup to retry accounting after physical Worker exit', async () => {
  const owner = managed(), controller = new AbortController()
  let connected = false, occupied = true
  owner.release.mockImplementation(async () => {
    if (!connected) throw new Error('resource coordinator unavailable')
    occupied = false
  })
  owner.grant.resolve(owner.lease)
  threads.pauseStartup = true
  const warning = vi.spyOn(console, 'error').mockImplementation(() => {})
  const opening = startInspector({ port: 0, captureFetch: false }, { budget: owner.budget, signal: controller.signal })
    .catch((error: unknown) => error)
  try {
    await vi.waitFor(() => { expect(threads.workers).toHaveLength(1) })
    controller.abort(new Error('cancel Inspector readiness'))
    const failure = await opening
    expect(failure).toBeInstanceOf(InspectorStartupCleanupError)
    expect(threads.workers[0]?.threadId).toBe(-1)
    expect(occupied).toBe(true)
    connected = true
    if (!(failure instanceof InspectorStartupCleanupError)) throw new Error('Startup failure did not transfer cleanup')
    await failure.cleanup()
    expect(occupied).toBe(false)
  } finally { connected = true; controller.abort(); await opening; warning.mockRestore() }
})

it('retains uncertain accounting when native Worker construction throws', async () => {
  const owner = managed()
  owner.grant.resolve(owner.lease)
  threads.allocationError = new Error('Native Worker allocation failed')
  await expect(startInspector({ port: 0, captureFetch: false }, { budget: owner.budget })).rejects.toThrow('Native Worker allocation failed')
  expect(threads.workers).toEqual([])
  expect(owner.uncertain).toHaveBeenCalledOnce()
  expect(owner.release).not.toHaveBeenCalled()
})

it('transfers failed startup cleanup while retaining capacity until actual termination', async () => {
  const owner = managed(), controller = new AbortController()
  owner.grant.resolve(owner.lease)
  threads.pauseStartup = true
  const opening = startInspector({ port: 0, captureFetch: false }, { budget: owner.budget, signal: controller.signal })
    .catch((error: unknown) => error)
  await vi.waitFor(() => { expect(threads.workers).toHaveLength(1) })
  const worker = threads.workers[0]!
  const terminate = vi.spyOn(worker, 'terminate').mockRejectedValueOnce(new Error('Native termination refused'))
  try {
    controller.abort(new Error('cancel Inspector readiness'))
    const failure = await opening
    expect(failure).toBeInstanceOf(InspectorStartupCleanupError)
    expect(worker.threadId).not.toBe(-1)
    expect(owner.uncertain).toHaveBeenCalledOnce()
    expect(owner.release).not.toHaveBeenCalled()
    terminate.mockRestore()
    if (failure instanceof InspectorStartupCleanupError) await failure.cleanup()
    expect(worker.threadId).toBe(-1)
    expect(owner.release).toHaveBeenCalledOnce()
  } finally { terminate.mockRestore(); controller.abort(); await worker.terminate() }
})
