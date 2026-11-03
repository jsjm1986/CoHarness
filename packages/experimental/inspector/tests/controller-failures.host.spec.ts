/** Real Inspector Workers retain physical cleanup when Host initialization or observation fails. */
import type { Worker, WorkerOptions } from 'node:worker_threads'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { startInspector, InspectorStartupCleanupError, type InspectorHandle } from '../src/host/bridge/controller.ts'
import * as network from '../src/host/inspection/network.ts'
import type { HostInspectorSource } from '../src/host/bridge/transport.ts'

const state = vi.hoisted(() => ({
  workers: [] as Worker[], sources: [] as HostInspectorSource[], options: [] as WorkerOptions[],
  sourceFailure: undefined as Error | undefined,
}))
vi.mock('node:worker_threads', async (importActual) => {
  const actual = await importActual<typeof import('node:worker_threads')>()
  return { ...actual, Worker: class extends actual.Worker {
    constructor(entry: URL, options: import('node:worker_threads').WorkerOptions) {
      super(entry, options)
      state.workers.push(this)
      state.options.push(options)
    }
  } }
})
vi.mock('../src/host/bridge/transport.ts', async (importActual) => {
  const actual = await importActual<typeof import('../src/host/bridge/transport.ts')>()
  return { ...actual, HostInspectorSource: class extends actual.HostInspectorSource {
    constructor(...args: ConstructorParameters<typeof actual.HostInspectorSource>) {
      if (state.sourceFailure !== undefined) throw state.sourceFailure
      super(...args)
      state.sources.push(this)
    }
  } }
})
vi.mock('../src/host/inspection/network.ts', async (importActual) => {
  const actual = await importActual<typeof import('../src/host/inspection/network.ts')>()
  return { ...actual, installFetchObserver: vi.fn(actual.installFetchObserver) }
})
const actualNetwork = await vi.importActual<typeof import('../src/host/inspection/network.ts')>('../src/host/inspection/network.ts')
const handles: InspectorHandle[] = []
afterEach(async () => {
  state.sourceFailure = undefined
  vi.restoreAllMocks()
  await Promise.allSettled(handles.splice(0).map(handle => handle.close()))
  await Promise.all(state.workers.splice(0).map(worker => worker.terminate()))
  state.options = []
  state.sources = []
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

async function open(captureFetch: boolean): Promise<InspectorHandle> {
  const handle = await startInspector({ port: 0, captureFetch })
  handles.push(handle)
  return handle
}

function observer(): network.FetchObserver {
  const result = vi.mocked(network.installFetchObserver).mock.results.at(-1)
  if (result?.type !== 'return') throw new Error('Fetch observer did not initialize')
  return result.value
}

it('passes explicit TypeScript configuration and Windows temporary directories to a source Worker', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const config = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)), temporary = tmpdir()
  vi.stubEnv('TSX_TSCONFIG_PATH', config)
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
  const opening = open(false)
  try {
    await vi.waitFor(() => { expect(state.workers).toHaveLength(1) })
    expect(state.options[0]?.env).toEqual({ TSX_TSCONFIG_PATH: config, TMP: temporary, TEMP: temporary })
  } finally { Object.defineProperty(process, 'platform', descriptor) }
  await opening
})

it('terminates the allocated Worker when the Host source cannot initialize', async () => {
  const reason = new Error('Host message port allocation failed')
  state.sourceFailure = reason
  await expect(startInspector({ port: 0, captureFetch: false })).rejects.toBe(reason)
  expect(state.workers[0]?.threadId).toBe(-1)
})

it('rolls back the Worker when another fetch accessor prevents observation', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')!
  const fetch = globalThis.fetch
  Object.defineProperty(globalThis, 'fetch', { configurable: true, get: () => fetch })
  try {
    await expect(startInspector({ port: 0, captureFetch: true })).rejects.toThrow('accessor and cannot be observed safely')
    expect(state.workers[0]?.threadId).toBe(-1)
  } finally { Object.defineProperty(globalThis, 'fetch', descriptor) }
})

it.each([false, true])('contains Host cleanup failures after an unexpected Worker exit with fetch capture=%s', async (capture) => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const handle = await open(capture), reason = new Error('observation cleanup failed')
  if (capture) {
    const active = observer(), stop = active.stop.bind(active)
    vi.spyOn(active, 'stop').mockImplementationOnce(async () => { await stop(); throw reason })
  } else {
    const source = state.sources.at(-1)!, close = source.close.bind(source)
    vi.spyOn(source, 'close').mockImplementationOnce(() => { close(); throw reason })
  }
  await state.workers[0]!.terminate()
  await vi.waitFor(() => {
    expect(error).toHaveBeenCalledWith('dsh inspector: Worker stopped unexpectedly', expect.any(Error))
    expect(error).toHaveBeenCalledWith(capture
      ? 'dsh inspector: fetch cleanup after Worker failure failed'
      : 'dsh inspector: Host source cleanup after Worker failure failed', reason)
  })
  await handle.close()
})

it('aggregates observer and source failures while still terminating the Worker', async () => {
  const handle = await open(true), active = observer()
  const source = state.sources.at(-1)!, stop = active.stop.bind(active), close = source.close.bind(source)
  const captureFailure = new Error('capture stop failed'), sourceFailure = new Error('source close failed')
  vi.spyOn(active, 'stop').mockImplementationOnce(async () => { await stop(); throw captureFailure })
  vi.spyOn(source, 'close').mockImplementationOnce(() => { close(); throw sourceFailure })
  await expect(handle.close()).rejects.toMatchObject({ errors: [captureFailure, sourceFailure] })
  expect(state.workers[0]?.threadId).toBe(-1)
  await handle.close()
})

it.each([false, true])('joins cancellation before ready publication with accounting failure=%s', async (fails) => {
  const controller = new AbortController(), reason = new Error('startup publication canceled')
  const release = vi.fn(async () => {})
  if (fails) release.mockRejectedValueOnce(new Error('resource completion failed'))
  vi.mocked(network.installFetchObserver).mockImplementationOnce((publisher, options) => {
    const active = actualNetwork.installFetchObserver(publisher, options)
    controller.abort(reason)
    return active
  })
  const outcome = await startInspector({ port: 0, captureFetch: true }, {
    budget: { acquire: async () => ({ signal: new AbortController().signal, release, uncertain: async () => {} }) },
    signal: controller.signal,
  }).catch((error: unknown) => error)
  expect(state.workers[0]?.threadId).toBe(-1)
  if (fails) {
    expect(outcome).toBeInstanceOf(InspectorStartupCleanupError)
    if (!(outcome instanceof InspectorStartupCleanupError)) throw new Error('Startup did not transfer cleanup')
    expect(outcome.cause).toMatchObject({ errors: [reason, expect.any(AggregateError)] })
    await outcome.cleanup()
    expect(release).toHaveBeenCalledTimes(2)
  } else {
    expect(outcome).toBe(reason)
    expect(release).toHaveBeenCalledOnce()
  }
})

it('reports failed withdrawal cleanup and permits the retained handle to retry', async () => {
  const controller = new AbortController(), reporting = new Error('resource completion failed')
  const release = vi.fn(async () => {}), error = vi.spyOn(console, 'error').mockImplementation(() => {})
  release.mockRejectedValueOnce(reporting)
  const handle = await startInspector({ port: 0, captureFetch: false }, {
    budget: { acquire: async () => ({ signal: controller.signal, release, uncertain: async () => {} }) },
  })
  handles.push(handle)
  controller.abort(new Error('permit withdrawn'))
  await vi.waitFor(() => { expect(error).toHaveBeenCalledWith('dsh inspector: withdrawn Worker cleanup failed', expect.any(AggregateError)) })
  expect(state.workers[0]?.threadId).toBe(-1)
  await handle.close()
  expect(release).toHaveBeenCalledTimes(2)
})
