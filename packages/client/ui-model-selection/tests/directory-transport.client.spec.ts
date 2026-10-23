/** Model operations settle through the real unary carrier after rejected transport reads. */
import { expect, it, onTestFinished } from 'vitest'
import { ApiTransportError, InProcessApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { ModelSelection, SessionId, SessionModels } from '@deepseek-ai/dsh-api-remotes/client'
import { ModelDirectory } from '../src/client/directory.ts'

const SESSION = 'synthetic-model-recovery' as SessionId
const INITIAL: ModelSelection = { provider: 'synthetic', model: 'first' }
const SELECTED: ModelSelection = { provider: 'synthetic', model: 'second' }
const MESSAGES = {
  load: 'Reload the model list',
  select: 'Selection result is unconfirmed; reload the model list',
}

interface Request {
  rpcId: string
  method: string
  payload: ModelSelection
}

function fixture() {
  let current = INITIAL
  let next: ((request: Request) => Promise<Response>) | undefined
  const calls: string[] = []
  const directoryValue = (): SessionModels => ({
    current, routable: true, failures: [],
    groups: [{ id: 'synthetic', name: 'Synthetic', models: [
      { id: 'first', name: 'First model' }, { id: 'second', name: 'Second model' },
    ] }],
  })
  const reply = (request: Request, value: unknown): Response =>
    Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } })
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
    const request = JSON.parse(init.body) as Request
    calls.push(request.method)
    const read = next
    next = undefined
    if (read !== undefined) return read(request)
    if (request.method === 'session.selectModel') {
      current = { provider: request.payload.provider, model: request.payload.model }
      return reply(request, { selected: current })
    }
    return reply(request, directoryValue())
  }
  const client = new InProcessApiClient({ fetch })
  const directory = new ModelDirectory(client.sessions, SESSION, () => true, undefined, operation => MESSAGES[operation])
  onTestFinished(() => { directory.dispose() })
  return {
    directory, calls,
    next: (read: (request: Request) => Promise<Response>) => { next = read },
    current: () => current,
    commit: (selection: ModelSelection) => { current = selection },
  }
}

const failures = [
  { name: 'fetch rejection', type: TypeError, read: async (): Promise<Response> => { throw new TypeError('Synthetic network failure') } },
  { name: 'HTTP refusal', type: ApiTransportError, read: async () => new Response('Synthetic gateway failure', { status: 503 }) },
  { name: 'malformed response body', type: SyntaxError, read: async () => new Response('{synthetic-invalid-json', { status: 200 }) },
  { name: 'aborted request', type: DOMException, read: async (): Promise<Response> => { throw new DOMException('Synthetic request cancelled', 'AbortError') } },
]

it.each(failures)('settles a cold model read after $name and accepts a later read', async ({ read, type }) => {
  const f = fixture()
  f.next(read)
  await expect(f.directory.load()).rejects.toBeInstanceOf(type)
  expect(f.directory.store.getSnapshot()).toMatchObject({
    status: 'error', error: MESSAGES.load, current: null, routable: null, groups: [], pending: null,
  })
  expect(f.calls).toEqual(['session.models'])
  await f.directory.load()
  expect(f.directory.store.getSnapshot()).toMatchObject({ status: 'ready', error: null, current: INITIAL })
})

it('retains the last successful directory when a refresh response is lost', async () => {
  const f = fixture()
  await f.directory.load()
  const previous = f.directory.store.getSnapshot()
  const reason = new TypeError('Synthetic private response content')
  f.next(async () => { throw reason })
  await expect(f.directory.load()).rejects.toBe(reason)
  const failed = f.directory.store.getSnapshot()
  expect(failed.status).toBe('error')
  expect(failed.error).toBe(MESSAGES.load)
  expect(failed.current).toBe(previous.current)
  expect(failed.groups).toBe(previous.groups)
  expect(failed.routable).toBe(true)
})

it.each(failures)('clears pending selection after $name without repeating the write', async ({ read, type }) => {
  const f = fixture()
  await f.directory.load()
  const previous = f.directory.store.getSnapshot()
  f.next(read)
  await expect(f.directory.select(SELECTED)).rejects.toBeInstanceOf(type)
  const failed = f.directory.store.getSnapshot()
  expect(failed).toMatchObject({ status: 'error', error: MESSAGES.select, pending: null, current: INITIAL })
  expect(failed.groups).toBe(previous.groups)
  expect(f.calls).toEqual(['session.models', 'session.selectModel'])
})

it('reads back the Host choice after a committed selection response is lost', async () => {
  const f = fixture()
  await f.directory.load()
  const reason = new TypeError('Synthetic selection reply lost')
  f.next(async () => {
    f.commit(SELECTED)
    throw reason
  })
  await expect(f.directory.select(SELECTED)).rejects.toBe(reason)
  expect(f.current()).toEqual(SELECTED)
  expect(f.directory.store.getSnapshot()).toMatchObject({ status: 'error', current: INITIAL, pending: null, error: MESSAGES.select })
  expect(f.calls).toEqual(['session.models', 'session.selectModel'])
  await f.directory.load()
  expect(f.directory.store.getSnapshot()).toMatchObject({ status: 'ready', current: SELECTED, error: null })
})

it.each(['load', 'select'] as const)('retains structured %s refusals', async (operation) => {
  const f = fixture()
  f.next(async request => Response.json({ type: 'server-response', rpcId: request.rpcId,
    result: { ok: false, error: { code: 'model-unavailable', message: 'Synthetic route unavailable', details: { provider: 'synthetic', model: 'second' } } },
  }))
  const result = operation === 'load' ? f.directory.load() : f.directory.select(SELECTED)
  await expect(result).rejects.toThrow('model-unavailable: Synthetic route unavailable')
  expect(f.directory.store.getSnapshot()).toMatchObject({
    status: 'error', error: 'model-unavailable: Synthetic route unavailable', pending: null,
  })
})

it.each(['load', 'select'] as const)('ignores a rejected old %s after a newer read or disposal', async (operation) => {
  for (const replace of ['read', 'reset', 'dispose'] as const) {
    const f = fixture()
    await f.directory.load()
    const pending = Promise.withResolvers<Response>()
    onTestFinished(() => { pending.resolve(new Response('ended', { status: 503 })) })
    f.next(() => pending.promise)
    const started = operation === 'load' ? f.directory.load() : f.directory.select(SELECTED)
    const outcome = started.catch((error: unknown) => error)
    if (replace === 'read') await f.directory.load()
    else if (replace === 'reset') {
      f.directory.resetConnected()
      await expect.poll(() => f.directory.store.getSnapshot().status).toBe('ready')
    } else f.directory.dispose()
    const established = f.directory.store.getSnapshot()
    if (operation === 'select' && replace !== 'dispose') expect(established.pending).toBeNull()
    pending.reject(new TypeError('Synthetic abandoned operation'))
    await expect(outcome).resolves.toBeInstanceOf(TypeError)
    expect(f.directory.store.getSnapshot()).toBe(established)
  }
})

it('clears an older selection when a directory read takes ownership', async () => {
  const f = fixture()
  await f.directory.load()
  const selection = Promise.withResolvers<Response>()
  const read = Promise.withResolvers<Response>()
  f.next(() => selection.promise)
  const selecting = f.directory.select(SELECTED).catch((error: unknown) => error)
  f.next(() => read.promise)
  const loading = f.directory.load().catch((error: unknown) => error)
  onTestFinished(async () => {
    selection.resolve(new Response('ended', { status: 503 }))
    read.resolve(new Response('ended', { status: 503 }))
    await Promise.all([selecting, loading])
  })
  expect(f.directory.store.getSnapshot()).toMatchObject({ status: 'loading', pending: null })
  selection.reject(new TypeError('Synthetic old selection failure'))
  await selecting
  expect(f.directory.store.getSnapshot()).toMatchObject({ status: 'loading', pending: null, error: null })
  read.reject(new TypeError('Synthetic current read failure'))
  await loading
  expect(f.directory.store.getSnapshot()).toMatchObject({ status: 'error', pending: null, error: MESSAGES.load })
})

it('keeps the newer selection pending when an older directory read rejects', async () => {
  const f = fixture()
  await f.directory.load()
  const read = Promise.withResolvers<Response>()
  const selection = Promise.withResolvers<Response>()
  f.next(() => read.promise)
  const loading = f.directory.load().catch((error: unknown) => error)
  f.next(() => selection.promise)
  const selecting = f.directory.select(SELECTED).catch((error: unknown) => error)
  onTestFinished(async () => {
    read.resolve(new Response('ended', { status: 503 }))
    selection.resolve(new Response('ended', { status: 503 }))
    await Promise.all([loading, selecting])
  })
  const current = f.directory.store.getSnapshot()
  expect(current).toMatchObject({ status: 'selecting', pending: SELECTED })
  read.reject(new TypeError('Synthetic superseded read failure'))
  await loading
  expect(f.directory.store.getSnapshot()).toBe(current)
  selection.reject(new TypeError('Synthetic current selection failure'))
  await selecting
  expect(f.directory.store.getSnapshot()).toMatchObject({ status: 'error', pending: null, error: MESSAGES.select })
})
