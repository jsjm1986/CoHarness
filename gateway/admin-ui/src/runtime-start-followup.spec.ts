/** Only the original allocation and expected active generation may confirm a lost start reply. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { adminRequest, type RuntimeCatalogEntry } from './api.ts'
import { runtimeFixture } from './components/runtime-fixture.ts'
import { startAdminRuntime } from './runtime-start-followup.ts'

const ready = runtimeFixture('user', 5)
const stopped = { ...ready, generation: ready.generation - 1, observedState: 'stopped' }
const url = `/admin/api/runtimes/${ready.id}`
const reply = (body: unknown, status = 200) => Response.json(body, { status })
const missing = () => reply({ error: 'node-service/unavailable' }, 503)
const fetchMock = vi.fn<typeof fetch>()
const start = () => adminRequest(url + '/start', { method: 'POST' })
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('fetch', fetchMock.mockReset()) })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('submits once and polls past the old stopped generation, an interrupted read and the new starting process', async () => {
  const scope = new AbortController(), checking = vi.fn()
  fetchMock.mockResolvedValueOnce(missing()).mockResolvedValueOnce(reply(stopped))
    .mockRejectedValueOnce(new TypeError('Disconnected')).mockResolvedValueOnce(reply({ ...ready, observedState: 'starting' }))
    .mockResolvedValueOnce(reply(ready))
  const result = startAdminRuntime(stopped, start, scope.signal, checking)
  await vi.advanceTimersByTimeAsync(3_000)
  await expect(result).resolves.toBe('observed')
  expect(checking).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls.map(([path, init]) => [path, init?.method ?? 'GET'])).toEqual([
    [url + '/start', 'POST'], ...Array.from({ length: 4 }, () => [url, 'GET']),
  ])
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  { ...ready, owner: { ...ready.owner, id: 6 } },
  { ...ready, owner: { ...ready.owner, kind: 'project' } },
  { ...ready, id: 'other-allocation' },
  { ...ready, node: { ...ready.node, id: 'other-node' } },
  { ...ready, generation: ready.generation + 1 },
  { ...ready, generation: stopped.generation - 1 },
])('ends observation when current identity or generation changes', async row => {
  fetchMock.mockResolvedValueOnce(missing()).mockResolvedValueOnce(reply(row))
  await expect(startAdminRuntime(stopped, start, new AbortController().signal, vi.fn())).rejects.toThrow('代次')
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it.each(['failed', 'stopping', 'stopped'])('reports the requested generation becoming %s', async observedState => {
  fetchMock.mockResolvedValueOnce(missing()).mockResolvedValueOnce(reply({ ...ready, observedState }))
  await expect(startAdminRuntime(stopped, start, new AbortController().signal, vi.fn())).rejects.toThrow('运行')
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it.each([{ error: 'forbidden', status: 403 }, { error: 'INSTANCE_CAPACITY', status: 503 }])('preserves a definitive $error', async ({ error, status }) => {
  fetchMock.mockResolvedValueOnce(reply({ error }, status))
  await expect(startAdminRuntime(stopped, start, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: error })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('honors loss of read permission and leaves an unpinned start unconfirmed', async () => {
  fetchMock.mockResolvedValueOnce(missing()).mockResolvedValueOnce(reply({ error: 'forbidden' }, 403)).mockResolvedValueOnce(missing())
  await expect(startAdminRuntime(stopped, start, new AbortController().signal, vi.fn())).rejects.toMatchObject({ status: 403 })
  await expect(startAdminRuntime(undefined, start, new AbortController().signal, vi.fn())).rejects.toThrow('无法确认')
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

it('expires without claiming success from an offline node reporting last-known ready', async () => {
  fetchMock.mockResolvedValueOnce(missing()).mockImplementation(async () => reply({ ...ready, node: { ...ready.node, status: 'offline' } }))
  const result = expect(startAdminRuntime(stopped, start, new AbortController().signal, vi.fn())).rejects.toThrow('无法确认')
  await vi.advanceTimersByTimeAsync(60_001)
  await result
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('aborts an in-flight read when the selected page is disposed', async () => {
  const scope = new AbortController(), reading = Promise.withResolvers<void>()
  fetchMock.mockResolvedValueOnce(missing()).mockImplementation(async (_, init) => {
    reading.resolve()
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }))
  })
  const result = expect(startAdminRuntime(stopped, start, scope.signal, vi.fn())).rejects.toMatchObject({ name: 'AbortError' })
  await reading.promise
  scope.abort()
  await result
  await vi.advanceTimersByTimeAsync(60_001)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('recognizes the displayed generation when an already-starting project becomes ready', async () => {
  const project: RuntimeCatalogEntry = { ...ready, owner: { ...ready.owner, kind: 'project' }, observedState: 'starting' }
  fetchMock.mockResolvedValueOnce(missing()).mockResolvedValueOnce(reply({ ...project, observedState: 'ready' }))
  await expect(startAdminRuntime(project, start, new AbortController().signal, vi.fn())).resolves.toBe('observed')
})
