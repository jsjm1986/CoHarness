/** Worker lifecycle of index parsing, with a scripted Worker. */
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { ResourceLease } from '@deepseek-ai/dsh-resource-budget'

const workers: FakeWorker[] = []
let allocationFailure: Error | undefined

class FakeWorker extends EventEmitter {
  readonly terminate = vi.fn(() => Promise.resolve(0))
  constructor(readonly entry: URL, readonly options: { workerData: unknown; transferList: unknown[] }) {
    super()
    if (allocationFailure !== undefined) throw allocationFailure
    workers.push(this)
  }
}

vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }))

const { parseIndexInWorker } = await import('../src/parse-thread.ts')

afterEach(() => { workers.length = 0; allocationFailure = undefined; vi.restoreAllMocks() })

function start(signal = new AbortController().signal) {
  const body = new Uint8Array([1, 2, 3])
  const result = parseIndexInWorker(body, 'https://m.example/i.json', signal)
  const worker = workers.at(-1) as FakeWorker
  return { body, result, worker }
}

it('transfers the body, resolves with the first message, and terminates the Worker', async () => {
  const { body, result, worker } = start()
  expect(worker.options.workerData).toEqual({ body, url: 'https://m.example/i.json' })
  expect(worker.options.transferList).toEqual([body.buffer])
  worker.emit('message', { ok: false, path: '$', reason: 'r', message: 'r' })
  worker.emit('exit', 1)
  await expect(result).resolves.toEqual({ ok: false, path: '$', reason: 'r', message: 'r' })
  expect(worker.terminate).toHaveBeenCalledOnce()
})

it('reports unconfirmed termination instead of publishing a result', async () => {
  const { result, worker } = start()
  worker.terminate.mockImplementationOnce(() => Promise.reject(new Error('stuck')))
  worker.emit('message', { ok: true, index: {} })
  await expect(result).rejects.toThrow('index parser termination could not be confirmed')
})

it('waits for process admission and joins termination before releasing it', async () => {
  const admission = Promise.withResolvers<ResourceLease>()
  const termination = Promise.withResolvers<number>()
  const release = vi.fn(async () => {})
  const uncertain = vi.fn(async () => {})
  const budget = { acquire: vi.fn(() => admission.promise) }
  const lease = { signal: new AbortController().signal, release, uncertain }
  const result = parseIndexInWorker(new Uint8Array(1), 'https://m.example/i.json', new AbortController().signal, budget)
  const observed = result.then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    expect(budget.acquire).toHaveBeenCalledWith(expect.objectContaining({ kind: 'process' }))
    expect(workers).toHaveLength(0)
    admission.resolve(lease)
    await vi.waitFor(() => { expect(workers).toHaveLength(1) })
    const worker = workers[0]!
    worker.terminate.mockReturnValueOnce(termination.promise)
    worker.emit('message', { ok: true, index: {} })
    expect(release).not.toHaveBeenCalled()
    termination.resolve(0)
    expect(await observed).toEqual({ value: { ok: true, index: {} } })
    expect(release).toHaveBeenCalledOnce()
    expect(uncertain).not.toHaveBeenCalled()
  } finally {
    admission.resolve(lease)
    termination.resolve(0)
    for (const worker of workers) worker.emit('exit', 0)
    await observed
  }
})

it('does not allocate when cancellation wins immediately after a grant', async () => {
  const controller = new AbortController()
  const release = vi.fn(async () => {})
  const budget = { acquire: async () => {
    controller.abort(new Error('cancelled before allocation'))
    return { signal: new AbortController().signal, release, uncertain: vi.fn(async () => {}) }
  } }
  const result = parseIndexInWorker(new Uint8Array(1), 'https://m.example/i.json', controller.signal, budget)
  const observed = result.catch((error: unknown) => error)
  try {
    expect(workers).toHaveLength(0)
    expect(await observed).toMatchObject({ message: 'cancelled before allocation' })
    expect(release).toHaveBeenCalledOnce()
  } finally {
    for (const worker of workers) worker.emit('exit', 0)
    await observed
  }
})

it('retains an uncertain permit after termination failure and releases on the later exit proof', async () => {
  const release = vi.fn(async () => {})
  const uncertain = vi.fn(async () => {})
  const budget = { acquire: async () => ({ signal: new AbortController().signal, release, uncertain }) }
  const parsing = parseIndexInWorker(new Uint8Array(1), 'https://m.example/i.json', new AbortController().signal, budget)
  const observed = parsing.catch((error: unknown) => error)
  try {
    await vi.waitFor(() => { expect(workers).toHaveLength(1) })
    const worker = workers[0]!
    worker.terminate.mockRejectedValueOnce(new Error('stuck'))
    worker.emit('message', { ok: true, index: {} })
    expect(await observed).toMatchObject({ message: 'index parser termination could not be confirmed' })
    expect(uncertain).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
    worker.emit('exit', 0)
    await vi.waitFor(() => { expect(release).toHaveBeenCalledOnce() })
  } finally {
    for (const worker of workers) worker.emit('exit', 0)
    await observed
  }
})

it.each([new Error('resource owner withdrawn'), 'resource owner withdrawn'])('terminates the admitted Worker when its permit is withdrawn (%s)', async (reason) => {
  const owner = new AbortController()
  const termination = Promise.withResolvers<number>()
  const release = vi.fn(async () => {})
  const uncertain = vi.fn(async () => {})
  const budget = { acquire: async () => ({ signal: owner.signal, release, uncertain }) }
  const parsing = parseIndexInWorker(new Uint8Array(1), 'https://m.example/i.json', new AbortController().signal, budget)
  const observed = parsing.catch((error: unknown) => error)
  try {
    await vi.waitFor(() => { expect(workers).toHaveLength(1) })
    const worker = workers[0]!
    worker.terminate.mockReturnValueOnce(termination.promise)
    owner.abort(reason)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(uncertain).toHaveBeenCalledOnce() })
    expect(await observed).toMatchObject({ message: 'resource owner withdrawn' })
    expect(release).not.toHaveBeenCalled()
    termination.resolve(0)
    await vi.waitFor(() => { expect(release).toHaveBeenCalledOnce() })
  } finally {
    termination.resolve(0)
    for (const worker of workers) worker.emit('exit', 0)
    await observed
  }
})

it.each([true, false])('preserves the parsing outcome when resource completion fails (parse succeeded: %s)', async (succeeded) => {
  const completionFailure = new Error('resource completion unavailable')
  const parserFailure = new Error('parser crashed')
  const budget = { acquire: async () => ({
    signal: new AbortController().signal,
    release: async () => { throw completionFailure }, uncertain: vi.fn(async () => {}),
  }) }
  const observed = parseIndexInWorker(new Uint8Array(1), 'https://m.example/i.json', new AbortController().signal, budget)
    .catch((error: unknown) => error)
  try {
    await vi.waitFor(() => { expect(workers).toHaveLength(1) })
    if (succeeded) workers[0]!.emit('message', { ok: true, index: {} })
    else workers[0]!.emit('error', parserFailure)
    const failure: unknown = await observed
    if (succeeded) expect(failure).toBe(completionFailure)
    else {
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toEqual([parserFailure, completionFailure])
    }
  } finally {
    for (const worker of workers) worker.emit('exit', 0)
    await observed
  }
})

it('releases an already exited Worker when cancellation arrives before its termination callback', async () => {
  const controller = new AbortController()
  const termination = Promise.withResolvers<number>()
  const release = vi.fn(async () => {})
  const uncertain = vi.fn(async () => {})
  const budget = { acquire: async () => ({ signal: controller.signal, release, uncertain }) }
  const observed = parseIndexInWorker(new Uint8Array(1), 'https://m.example/i.json', new AbortController().signal, budget)
    .catch((error: unknown) => error)
  try {
    await vi.waitFor(() => { expect(workers).toHaveLength(1) })
    const worker = workers[0]!
    worker.terminate.mockReturnValueOnce(termination.promise)
    worker.emit('exit', 0)
    controller.abort(new Error('caller withdrawn after exit'))
    expect(await observed).toMatchObject({ message: 'caller withdrawn after exit' })
    expect(release).toHaveBeenCalledOnce()
    expect(uncertain).not.toHaveBeenCalled()
  } finally { termination.resolve(0); await observed }
})

it('reports termination rejection after cancellation has already retained an uncertain permit', async () => {
  const controller = new AbortController()
  const termination = Promise.withResolvers<number>()
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  const release = vi.fn(async () => {})
  const uncertain = vi.fn(async () => {})
  const budget = { acquire: async () => ({ signal: controller.signal, release, uncertain }) }
  const observed = parseIndexInWorker(new Uint8Array(1), 'https://m.example/i.json', new AbortController().signal, budget)
    .catch((error: unknown) => error)
  try {
    await vi.waitFor(() => { expect(workers).toHaveLength(1) })
    const worker = workers[0]!
    worker.terminate.mockReturnValueOnce(termination.promise)
    controller.abort(new Error('caller withdrawn'))
    await vi.waitFor(() => { expect(uncertain).toHaveBeenCalledOnce() })
    const cleanupFailure = new Error('native termination failed')
    termination.reject(cleanupFailure)
    await vi.waitFor(() => { expect(logged).toHaveBeenCalledWith('[plugin-market] index parser termination failed after cancellation:', cleanupFailure) })
    expect(release).not.toHaveBeenCalled()
  } finally {
    termination.resolve(0)
    for (const worker of workers) worker.emit('exit', 0)
    await observed
  }
})

it('keeps uncertain occupation when Worker construction fails', async () => {
  allocationFailure = new Error('Worker allocation failed')
  const uncertain = vi.fn(async () => {})
  const release = vi.fn(async () => {})
  const budget = { acquire: async () => ({ signal: new AbortController().signal, release, uncertain }) }
  await expect(parseIndexInWorker(new Uint8Array(1), 'https://m.example/i.json', new AbortController().signal, budget))
    .rejects.toMatchObject({ message: 'index parser allocation could not be confirmed', cause: allocationFailure })
  expect(uncertain).toHaveBeenCalledOnce()
  expect(release).not.toHaveBeenCalled()
})

it('reports a failed resource completion after a late Worker exit', async () => {
  const reportFailure = new Error('resource completion unavailable')
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  const budget = { acquire: async () => ({
    signal: new AbortController().signal,
    release: async () => { throw reportFailure }, uncertain: async () => {},
  }) }
  const observed = parseIndexInWorker(new Uint8Array(1), 'https://m.example/i.json', new AbortController().signal, budget)
    .catch((error: unknown) => error)
  try {
    await vi.waitFor(() => { expect(workers).toHaveLength(1) })
    const worker = workers[0]!
    worker.terminate.mockRejectedValueOnce(new Error('stuck'))
    worker.emit('message', { ok: true, index: {} })
    expect(await observed).toMatchObject({ message: 'index parser termination could not be confirmed' })
    worker.emit('exit', 0)
    await vi.waitFor(() => { expect(logged).toHaveBeenCalledWith('[plugin-market] index parser resource cleanup failed:', reportFailure) })
  } finally {
    for (const worker of workers) worker.emit('exit', 0)
    await observed
  }
})

it.each([
  null,
  { index: {} },
  { ok: true },
  { ok: true, index: null },
  { ok: false, path: '$', reason: 'r' },
])('refuses the Worker message %j', async (message) => {
  const { result, worker } = start()
  worker.emit('message', message)
  await expect(result).rejects.toThrow('index parser reported an unexpected value')
})

it('rejects when the Worker fails or exits without a result', async () => {
  const failing = start()
  failing.worker.emit('error', new Error('crashed'))
  await expect(failing.result).rejects.toThrow('crashed')
  const exiting = start()
  exiting.worker.emit('exit', 3)
  await expect(exiting.result).rejects.toThrow('index parser exited before reporting a result (code 3)')
})

it('terminates the Worker on abort and refuses an aborted signal', async () => {
  const controller = new AbortController()
  const { result, worker } = start(controller.signal)
  controller.abort(new Error('disposed'))
  await expect(result).rejects.toThrow('disposed')
  expect(worker.terminate).toHaveBeenCalledOnce()
  await expect(parseIndexInWorker(new Uint8Array(1), 'https://m.example/i.json', controller.signal)).rejects.toThrow('disposed')
})
