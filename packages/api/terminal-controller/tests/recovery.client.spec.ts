/** Reloaded tab identities and nonblocking close requests use independent lifetimes. */
import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteStream, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-terminal-controller/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WebTerminalId, WebTerminalInfo, TerminalEnvironment } from '../src/types.ts'
import { TerminalView, type TerminalRemote } from '../src/client/model.ts'
import { TerminalCloseRequests } from '../src/client/close-requests.ts'
import { TerminalBindings } from '../src/client/bindings.ts'
import * as TerminalClient from '../src/client/index.ts'

vi.mock('@deepseek-ai/dsh-api-terminal-controller/remote', () => ({ default: { package: '@deepseek-ai/dsh-api-terminal-controller', descriptors: [] } }))

const ownerKey = (id: SessionId): string => JSON.stringify(['local', id])

const sessionId = 'session' as SessionId
const info: WebTerminalInfo = { id: 'terminal' as WebTerminalId, shell: { name: 'zsh', path: '/bin/zsh', args: ['-i'] }, title: 'zsh', cwd: '/workspace', rows: 24, cols: 80, state: 'running', exitCode: null }
const environment: TerminalEnvironment = { cwd: info.cwd, maxInputBytes: 1000, maxCols: 200, maxRows: 100, scrollback: 100 }
const success = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const failure = (message: string): RemoteResult<never> => ({ ok: false, error: new RemoteError('gateway/bad-request', message, {}) })
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function storage() {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', { get length() { return data.size }, key: (index: number) => [...data.keys()][index] ?? null, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } })
  return data
}

function fixture(identity: TerminalClient.TerminalIdentitySource = { key: ownerKey, subscribe: () => () => {} }) {
  const remote: TerminalRemote = {
    retain: vi.fn<TerminalRemote['retain']>(async function* (_session, _id, signal) {
      yield { type: 'retained' }
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve()
        else signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }),
    shells: vi.fn<TerminalRemote['shells']>(async () => success([info.shell])),
    environment: vi.fn<TerminalRemote['environment']>(async () => success(environment)), list: vi.fn<TerminalRemote['list']>(async () => success([])),
    create: vi.fn<TerminalRemote['create']>(async (_session, request) => success({ ...info, id: request.id })),
    close: vi.fn<TerminalRemote['close']>(async () => success(undefined)), rename: vi.fn<TerminalRemote['rename']>(async () => success(undefined)),
    write: vi.fn<TerminalRemote['write']>(async () => success(undefined)), resize: vi.fn<TerminalRemote['resize']>(async () => success(undefined)),
    follow: vi.fn<TerminalRemote['follow']>(async function* (_session, id, controllerId, signal) {
      yield { type: 'snapshot', sequence: 0, screen: 'retained', info: { ...info, id, controllerId } }
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve()
        else signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }),
  }
  const gateway: Pick<ClientRemote, '$stream'> = { $stream: options => new RemoteStream({ generation: createSnapshotStore(undefined) }, options) }
  function view() {
    const model = new TerminalView(sessionId, remote, gateway, info.id, true, undefined, undefined, identity.key(sessionId))
    cleanups.push(() => model.dispose())
    return model
  }
  async function service() {
    const ctx = new Context()
    ctx.provide('remote', { ...gateway, terminal: remote } as never)
    ctx.provide('remote.terminal', remote)
    const fiber = ctx.plugin({ apply: (child) => { new TerminalClient.ClientTerminals(child, remote, identity) } })
    cleanups.push(async () => { await ctx.fiber.dispose() })
    await fiber
    return { service: ctx.webTerminals, dispose: () => fiber.dispose() }
  }
  return { remote, view, service }
}

it('starts automatically and deduplicates overlapping mounts and refreshes', async () => {
  const h = fixture()
  const model = h.view()
  const creation = Promise.withResolvers<RemoteResult<WebTerminalInfo>>()
  vi.mocked(h.remote.create).mockReturnValueOnce(creation.promise)
  model.mount()
  const loading = model.refresh()
  expect(model.refresh()).toBe(loading)
  await expect.poll(() => h.remote.create).toHaveBeenCalledOnce()
  const remounting = model.refresh()
  expect(vi.mocked(h.remote.create).mock.calls[0]?.[1]).toEqual({ id: info.id, shellPath: info.shell.path, cols: 80, rows: 24 })
  creation.resolve(success(info))
  await loading
  await remounting
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  expect(h.remote.create).toHaveBeenCalledOnce()
})

it('recovers a listed process without creating another, including its title and screen', async () => {
  const h = fixture()
  vi.mocked(h.remote.list).mockResolvedValue(success([{ ...info, title: 'Build' }]))
  const model = h.view()
  model.mount()
  await model.refresh()
  expect(h.remote.create).not.toHaveBeenCalled()
  await expect.poll(() => model.state.getSnapshot().render?.frame).toMatchObject({ type: 'snapshot', screen: 'retained' })
  expect(h.remote.follow).toHaveBeenCalledWith(sessionId, info.id, expect.any(String), expect.any(AbortSignal))
})

it('does not recreate a recovered terminal that disappeared after the recovery list was shown', async () => {
  const h = fixture()
  const { service } = await h.service()
  vi.mocked(h.remote.list).mockResolvedValueOnce(success([info]))
  expect(await service.recover(sessionId)).toEqual([info])
  const model = service.view(sessionId, 'recovered', 'recovered', info.id)
  await model.refresh()
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'failed', writable: false })
  expect(model.state.getSnapshot().issue).toBe('missingTerminal')
  expect(h.remote.create).not.toHaveBeenCalled()
  model.mount()
  await model.refresh()
  expect(h.remote.create).not.toHaveBeenCalled()
})

it('retries lost create acknowledgements with the saved id and closes after a refused allocation', async () => {
  const h = fixture()
  const model = h.view()
  vi.mocked(h.remote.create).mockResolvedValueOnce(failure('response lost'))
  await model.refresh()
  expect(model.state.getSnapshot().error).toBe('response lost')
  await model.refresh()
  expect(vi.mocked(h.remote.create).mock.calls.map(call => call[1].id)).toEqual([info.id, info.id])
  await model.close()
  expect(h.remote.close).toHaveBeenCalledWith(sessionId, info.id)
})

it('waits for an in-flight creation while close detaches immediately and prevents a late connection', async () => {
  const h = fixture()
  const model = h.view()
  const creation = Promise.withResolvers<RemoteResult<WebTerminalInfo>>()
  vi.mocked(h.remote.create).mockReturnValueOnce(creation.promise)
  const unmount = model.mount()
  const starting = model.refresh()
  await expect.poll(() => vi.mocked(h.remote.create).mock.calls.length).toBe(1)
  const closing = model.close()
  expect(model.close()).toBe(closing)
  unmount()
  expect(h.remote.close).not.toHaveBeenCalled()
  creation.resolve(failure('cancelled allocation'))
  await starting
  await closing
  expect(h.remote.close).toHaveBeenCalledWith(sessionId, info.id)
  expect(h.remote.follow).not.toHaveBeenCalled()
})

it('does not allocate after close or disposal overtakes discovery', async () => {
  for (const action of ['close', 'dispose'] as const) {
    const h = fixture()
    const model = h.view()
    const discovery = Promise.withResolvers<RemoteResult<TerminalEnvironment>>()
    vi.mocked(h.remote.environment).mockReturnValueOnce(discovery.promise)
    const loading = model.refresh()
    await model[action]()
    discovery.resolve(success(environment))
    await loading
    await model.refresh()
    expect(h.remote.create).not.toHaveBeenCalled()
  }
})

it('updates a restored inactive terminal title and ignores late results after disposal', async () => {
  const h = fixture()
  const model = h.view()
  await model.rename('  Build  ')
  expect(h.remote.rename).toHaveBeenCalledWith(sessionId, info.id, '  Build  ')
  expect(model.state.getSnapshot().title).toBe('Build')
  const rename = Promise.withResolvers<RemoteResult<void>>()
  vi.mocked(h.remote.rename).mockReturnValueOnce(rename.promise)
  const pending = model.rename('Late')
  await model.dispose()
  rename.resolve(success(undefined))
  await pending
  expect(model.state.getSnapshot()).toEqual({ phase: 'closed', writable: false })
})

it('removes a view synchronously, keeps cleanup retryable, and never deletes a replacement view', async () => {
  storage()
  const h = fixture()
  const { service } = await h.service()
  const first = service.view(sessionId, 'tab', 'tab')
  first.mount()
  await first.refresh()
  const closing = Promise.withResolvers<RemoteResult<void>>()
  vi.mocked(h.remote.close).mockReturnValueOnce(closing.promise)
  service.close(sessionId, 'tab', 'tab')
  const replacement = service.view(sessionId, 'tab', 'tab')
  expect(replacement).not.toBe(first)
  expect(service.closeFailures.getSnapshot()).toEqual([])
  closing.resolve(failure('termination refused'))
  await expect.poll(() => service.closeFailures.getSnapshot().length).toBe(1)
  const failed = service.closeFailures.getSnapshot()[0]!
  service.retryClose(failed.id)
  service.retryClose(failed.id)
  await expect.poll(() => service.closeFailures.getSnapshot()).toEqual([])
  expect(service.view(sessionId, 'tab', 'tab')).toBe(replacement)
  await expect.poll(() => new TerminalCloseRequests(ownerKey).pending()).toEqual([])
})

it('closes an inactive restored tab by tab identity and retries saved close requests after reload', async () => {
  storage()
  const h = fixture()
  const first = await h.service()
  first.service.close(sessionId, 'inactive', 'inactive', 'inactive' as WebTerminalId)
  await expect.poll(() => vi.mocked(h.remote.close).mock.calls.length).toBe(1)
  expect(h.remote.close).toHaveBeenCalledWith(sessionId, 'inactive')
  await first.dispose()
  const pending = new TerminalCloseRequests(ownerKey)
  pending.save({ sessionId, id: 'second' as WebTerminalId, title: 'Second' })
  await h.service()
  await expect.poll(() => vi.mocked(h.remote.close).mock.calls.length).toBe(2)
  expect(h.remote.close).toHaveBeenCalledWith(sessionId, 'second')
  await expect.poll(() => new TerminalCloseRequests(ownerKey).pending()).toEqual([])
})

it('keeps concurrent windows close requests independent and removes only the settled request', () => {
  storage()
  const a = new TerminalCloseRequests(ownerKey)
  const b = new TerminalCloseRequests(ownerKey)
  a.save({ sessionId, id: 'a' as WebTerminalId, title: 'A' })
  b.save({ sessionId, id: 'b' as WebTerminalId, title: 'B' })
  expect(new TerminalCloseRequests(ownerKey).pending().map(request => request.id)).toEqual(['a', 'b'])
  a.remove(a.pending()[0]!)
  expect(new TerminalCloseRequests(ownerKey).pending().map(request => request.id)).toEqual(['b'])
})

it('recovers Host terminals by Session while excluding held, pending-close, and already-closed identities', async () => {
  storage()
  const h = fixture()
  const { service } = await h.service()
  const held = service.view(sessionId, 'held', 'held')
  await held.refresh()
  const closing = service.view(sessionId, 'closing', 'closing')
  await closing.refresh()
  const done = service.view(sessionId, 'closed', 'closed')
  await done.refresh()
  const unheld: WebTerminalInfo = { ...info, id: 'unheld' as WebTerminalId }
  const pending = Promise.withResolvers<RemoteResult<void>>()
  vi.mocked(h.remote.close).mockReturnValueOnce(pending.promise)
  service.close(sessionId, 'closing', 'closing')
  service.close(sessionId, 'closed', 'closed')
  await expect.poll(() => new TerminalCloseRequests(ownerKey).pending().length).toBe(1)
  vi.mocked(h.remote.list).mockResolvedValue(success([
    { ...info, id: held.id }, { ...info, id: closing.id }, { ...info, id: done.id }, unheld,
  ]))
  expect(await service.recover(sessionId)).toEqual([unheld])
  expect(h.remote.list).toHaveBeenLastCalledWith(sessionId)
  const otherSession = 'other-session' as SessionId
  vi.mocked(h.remote.list).mockResolvedValueOnce(success([info]))
  expect(await service.recover(otherSession)).toEqual([info])
  pending.resolve(success(undefined))
  await expect.poll(() => new TerminalCloseRequests(ownerKey).pending()).toEqual([])
  expect(await service.recover(sessionId)).toEqual([unheld])
})

it('queries current held views after a slow recovery response and reports discovery errors', async () => {
  const h = fixture()
  const { service } = await h.service()
  const listed = Promise.withResolvers<RemoteResult<WebTerminalInfo[]>>()
  vi.mocked(h.remote.list).mockReturnValueOnce(listed.promise)
  const recovering = service.recover(sessionId)
  vi.mocked(h.remote.list).mockResolvedValueOnce(success([info]))
  const model = service.view(sessionId, 'recovered', 'recovered', info.id)
  await model.refresh()
  listed.resolve(success([info]))
  expect(await recovering).toEqual([])
  expect(service.view(sessionId, 'recovered', 'recovered', info.id)).toBe(model)
  expect(model.id).toBe(info.id)
  vi.mocked(h.remote.list).mockResolvedValueOnce(failure('Session unavailable'))
  await expect(service.recover(sessionId)).rejects.toThrow('Session unavailable')
  vi.mocked(h.remote.list).mockResolvedValueOnce({ ok: false, error: new RemoteError('terminal/forbidden', 'Terminal qualification required', {}) })
  expect(await service.recover(sessionId)).toEqual([])
  expect(h.remote.create).not.toHaveBeenCalled()
})

it('ignores an unknown tab and retries only saved close requests', async () => {
  storage()
  const h = fixture()
  const { service } = await h.service()
  service.close(sessionId, 'unknown', 'unknown')
  service.retryClose('unknown' as WebTerminalId)
  expect(h.remote.close).not.toHaveBeenCalled()
  expect(new TerminalCloseRequests(ownerKey).pending()).toEqual([])
})

it('retains an inactive close failure with its tab title until retry succeeds', async () => {
  const data = storage()
  const h = fixture()
  const { service } = await h.service()
  vi.mocked(h.remote.close).mockResolvedValueOnce(failure('Host refused cleanup'))
  service.close(sessionId, 'Build', 'Build', info.id)
  expect(data.has('dsh.terminal.close.v2.' + JSON.stringify([ownerKey(sessionId), info.id]))).toBe(true)
  await expect.poll(() => service.closeFailures.getSnapshot()).toEqual([{ id: info.id, title: 'Build', message: 'Host refused cleanup' }])
  vi.mocked(h.remote.list).mockResolvedValueOnce(success([info]))
  expect(await service.recover(sessionId)).toEqual([])
  const pending = Promise.withResolvers<RemoteResult<void>>()
  vi.mocked(h.remote.close).mockReturnValueOnce(pending.promise)
  service.retryClose(info.id)
  service.retryClose(info.id)
  expect(service.closeFailures.getSnapshot()).toEqual([])
  expect(h.remote.close).toHaveBeenCalledTimes(2)
  pending.resolve(success(undefined))
  await expect.poll(() => data.size).toBe(0)
})

it('preserves a close failure from a non-Error rejection', async () => {
  storage()
  const h = fixture()
  const { service } = await h.service()
  vi.mocked(h.remote.close).mockRejectedValueOnce('carrier closed')
  service.close(sessionId, 'Build', 'Build', info.id)
  await expect.poll(() => service.closeFailures.getSnapshot()).toEqual([{ id: info.id, title: 'Build', message: 'carrier closed' }])
})

it('waits for pending cleanup during service disposal without publishing a late failure', async () => {
  storage()
  const h = fixture()
  const { service, dispose } = await h.service()
  const pending = Promise.withResolvers<RemoteResult<void>>()
  vi.mocked(h.remote.close).mockReturnValueOnce(pending.promise)
  service.close(sessionId, 'Build', 'Build', info.id)
  let finished = false
  const disposing = dispose().then(() => { finished = true })
  expect(finished).toBe(false)
  pending.resolve(failure('transport is stopping'))
  await disposing
  expect(service.closeFailures.getSnapshot()).toEqual([])
  expect(new TerminalCloseRequests(ownerKey).pending()).toEqual([{ sessionId, id: info.id, title: 'Build' }])
  service.retryClose(info.id)
  expect(h.remote.close).toHaveBeenCalledOnce()
})

it('persists occurrence identities before allocation and removes them on close without saving process output', async () => {
  const data = storage()
  const h = fixture()
  const { service } = await h.service()
  const model = service.view(sessionId, 'new-tab', 'new-tab')
  const key = 'dsh.terminal.binding.v2.' + JSON.stringify([ownerKey(sessionId), 'new-tab'])
  expect(JSON.parse(data.get(key)!)).toBe(model.id)
  await model.refresh()
  expect(model.id).toMatch(/^[0-9a-f-]{36}$/)
  expect([...data.keys()]).toEqual([key, 'dsh.terminal.shell.v2.' + JSON.stringify(ownerKey(sessionId))])
  const pending = Promise.withResolvers<RemoteResult<void>>()
  vi.mocked(h.remote.close).mockReturnValueOnce(pending.promise)
  service.close(sessionId, 'new-tab', 'new-tab')
  const request = { sessionId, id: model.id, title: info.title }
  expect(data.has(key)).toBe(false)
  expect(data.get('dsh.terminal.close.v2.' + JSON.stringify([ownerKey(sessionId), model.id]))).toBe(JSON.stringify(request))
  pending.resolve(success(undefined))
  await expect.poll(() => [...data.keys()]).toEqual(['dsh.terminal.shell.v2.' + JSON.stringify(ownerKey(sessionId))])
})

it('restores the same terminal in the same occurrence after reload without opening a recovery duplicate', async () => {
  storage()
  const h = fixture()
  const first = await h.service()
  const original = first.service.view(sessionId, 'tab', 'tab')
  await original.refresh()
  await first.dispose()
  vi.mocked(h.remote.list).mockResolvedValue(success([{ ...info, id: original.id }]))
  const second = await h.service()
  const restored = second.service.view(sessionId, 'tab', 'tab')
  expect(await second.service.recover(sessionId)).toEqual([])
  restored.mount()
  await restored.refresh()
  expect(restored.id).toBe(original.id)
  expect(h.remote.create).toHaveBeenCalledOnce()
  await expect.poll(() => restored.state.getSnapshot().render?.frame).toMatchObject({ type: 'snapshot', screen: 'retained' })
})

it('offers retained processes when their saved occurrence is absent from the restored layout', async () => {
  storage()
  const h = fixture()
  const first = await h.service()
  const original = first.service.view(sessionId, 'lost-tab', 'lost-tab')
  await original.refresh()
  await first.dispose()
  const retained = { ...info, id: original.id }
  vi.mocked(h.remote.list).mockResolvedValue(success([retained]))
  const second = await h.service()
  expect(await second.service.recover(sessionId)).toEqual([retained])
})

it('keeps identical occurrence keys in different Sessions independent across reload', async () => {
  storage()
  const h = fixture()
  const first = await h.service()
  const a = first.service.view(sessionId, 'tab', 'tab')
  const other = 'other' as SessionId
  const b = first.service.view(other, 'tab', 'tab')
  await Promise.all([a.refresh(), b.refresh()])
  expect(a.id).not.toBe(b.id)
  await first.dispose()
  const second = await h.service()
  expect(second.service.view(sessionId, 'tab', 'tab').id).toBe(a.id)
  expect(second.service.view(other, 'tab', 'tab').id).toBe(b.id)
})

it('closes a saved inactive occurrence without mounting a view after reload', async () => {
  storage()
  const h = fixture()
  const first = await h.service()
  const original = first.service.view(sessionId, 'tab', 'tab')
  await original.refresh()
  await first.dispose()
  const second = await h.service()
  second.service.close(sessionId, 'tab', 'tab')
  await expect.poll(() => h.remote.close).toHaveBeenCalledWith(sessionId, original.id)
  expect(h.remote.create).toHaveBeenCalledOnce()
})

it('reports a missing saved terminal after reload and never starts a replacement shell', async () => {
  storage()
  const h = fixture()
  const first = await h.service()
  const original = first.service.view(sessionId, 'tab', 'tab')
  await original.refresh()
  await first.dispose()
  const second = await h.service()
  const restored = second.service.view(sessionId, 'tab', 'tab')
  await restored.refresh()
  expect(restored.state.getSnapshot()).toMatchObject({ phase: 'failed', issue: 'missingTerminal' })
  await restored.refresh()
  expect(h.remote.create).toHaveBeenCalledOnce()
})

it.each(['{broken', 'null', '{}', '[{}]', '{"sessionId":"s","id":"bad/id","title":"x"}', '{"sessionId":"s","id":"different","title":"x"}'])('discards malformed saved cleanup: %s', (raw) => {
  const data = storage()
  data.set('dsh.terminal.close.v2.' + JSON.stringify([ownerKey(sessionId), 'terminal']), raw)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(new TerminalCloseRequests(ownerKey).pending()).toEqual([])
  expect(error).toHaveBeenCalledOnce()
})

it('skips unrelated storage and cleanup keys removed during enumeration', () => {
  const getItem = vi.fn(() => null)
  vi.stubGlobal('localStorage', {
    length: 3,
    key: (index: number) => ['unrelated', 'dsh.terminal.close.v2.' + JSON.stringify([ownerKey(sessionId), 'gone']), null][index],
    getItem,
  })
  expect(new TerminalCloseRequests(ownerKey).pending()).toEqual([])
  expect(getItem).toHaveBeenCalledExactlyOnceWith('dsh.terminal.close.v2.' + JSON.stringify([ownerKey(sessionId), 'gone']))
})

it('keeps close requests usable without browser storage', () => {
  vi.stubGlobal('localStorage', undefined)
  const requests = new TerminalCloseRequests(ownerKey)
  requests.save({ sessionId, id: info.id, title: 'Build' })
  expect(requests.pending()).toEqual([{ sessionId, id: info.id, title: 'Build' }])
  requests.remove(requests.pending()[0]!)
  expect(requests.pending()).toEqual([])
})

it('keeps cleanup usable in memory when storage access itself is denied', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('localStorage', undefined)
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('storage denied') } })
  const requests = new TerminalCloseRequests(ownerKey)
  requests.save({ sessionId, id: info.id, title: 'Build' })
  expect(requests.pending()).toHaveLength(1)
  requests.remove(requests.pending()[0]!)
  expect(requests.pending()).toEqual([])
  expect(error).toHaveBeenCalledTimes(3)
})

it.each(['saved', 'view'] as const)('clears a %s close request after the Host confirms that its Session does not exist', async (source) => {
  const data = storage()
  const h = fixture()
  const requests = new TerminalCloseRequests(ownerKey)
  if (source === 'saved') requests.save({ sessionId, id: info.id, title: 'Build' })
  vi.mocked(h.remote.close).mockResolvedValue({ ok: false, error: new RemoteError('session-not-found', 'Deleted Session', { sessionId }) })
  const { service, dispose } = await h.service()
  if (source === 'view') {
    const view = service.view(sessionId, 'tab', 'tab')
    await view.refresh()
    service.close(sessionId, 'tab', 'tab')
  }
  await expect.poll(() => vi.mocked(h.remote.close).mock.calls.length).toBe(1)
  await dispose()
  expect([...data.entries()]).toEqual(source === 'view'
    ? [['dsh.terminal.shell.v2.' + JSON.stringify(ownerKey(sessionId)), info.shell.path]] : [])
  expect(service.closeFailures.getSnapshot()).toEqual([])
  expect(new TerminalCloseRequests(ownerKey).pending()).toEqual([])
  await h.service()
  expect(h.remote.close).toHaveBeenCalledOnce()
})

it('waits for both active and detached stream finalizers during plugin disposal without closing Host processes', async () => {
  const h = fixture()
  const { service, dispose } = await h.service()
  const started = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
  const release = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
  const finished = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
  cleanups.push(() => { for (const barrier of release) barrier.resolve(undefined) })
  let index = 0
  vi.mocked(h.remote.follow).mockImplementation(async function* (_session, id, controllerId, signal) {
    const current = index++
    try {
      yield { type: 'snapshot', sequence: 0, screen: 'screen', info: { ...info, id, controllerId } }
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve()
        else signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
    } finally {
      started[current]!.resolve(undefined)
      await release[current]!.promise
      finished[current]!.resolve(undefined)
    }
  })
  const model = service.view(sessionId, 'tab', 'tab')
  model.mount()
  await model.refresh()
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  model.connect()
  await started[0]!.promise
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  let disposed = false
  const disposing = dispose().then(() => { disposed = true })
  await started[1]!.promise
  release[1]!.resolve(undefined)
  await finished[1]!.promise
  // Drain runnable disposal continuations; only the held old finalizer may keep teardown pending.
  await setImmediate()
  expect(disposed).toBe(false)
  release[0]!.resolve(undefined)
  await disposing
  expect(disposed).toBe(true)
  expect(h.remote.close).not.toHaveBeenCalled()
})

it('discovers menu choices without creating a process and remembers a choice before opening its tab', async () => {
  const data = storage()
  const h = fixture()
  const alternate = { name: 'bash', path: '/bin/bash', args: ['-i'] }
  vi.mocked(h.remote.shells).mockResolvedValue(success([info.shell, alternate]))
  const { service } = await h.service()
  expect(await service.launchShells(sessionId, new AbortController().signal)).toEqual({
    shells: [info.shell, alternate], selectedShell: info.shell.path,
  })
  service.selectShell(sessionId, alternate.path)
  expect(data.get('dsh.terminal.shell.v2.' + JSON.stringify(ownerKey(sessionId)))).toBe(alternate.path)
  expect(h.remote.create).not.toHaveBeenCalled()
  expect((await service.launchShells(sessionId, new AbortController().signal)).selectedShell).toBe(alternate.path)
  const model = service.view(sessionId, 'chosen', 'chosen', undefined, alternate.path)
  await model.refresh()
  expect(h.remote.create).toHaveBeenLastCalledWith(
    sessionId, expect.objectContaining({ shellPath: alternate.path }), expect.any(AbortSignal),
  )
  expect(h.remote.shells).toHaveBeenCalledTimes(2)
  await h.view().refresh()
  expect(h.remote.create).toHaveBeenLastCalledWith(
    sessionId, expect.objectContaining({ shellPath: alternate.path }), expect.any(AbortSignal),
  )
  vi.mocked(h.remote.shells).mockResolvedValue(success([info.shell]))
  await h.view().refresh()
  expect(h.remote.create).toHaveBeenLastCalledWith(
    sessionId, expect.objectContaining({ shellPath: info.shell.path }), expect.any(AbortSignal),
  )
  vi.mocked(h.remote.shells).mockResolvedValueOnce(failure('host offline'))
  await expect(service.launchShells(sessionId, new AbortController().signal)).rejects.toThrow('host offline')
  vi.mocked(h.remote.shells).mockResolvedValue(success([]))
  expect((await service.launchShells(sessionId, new AbortController().signal)).selectedShell).toBeUndefined()
  await h.view().refresh()
  expect(vi.mocked(h.remote.create).mock.calls.at(-1)?.[1]).not.toHaveProperty('shellPath')
})

it('retains the last selection across a failed automatic launch', async () => {
  const data = storage()
  const h = fixture()
  vi.mocked(h.remote.create).mockResolvedValueOnce(failure('shell disappeared'))
  const model = h.view()
  await model.refresh()
  expect(data.get('dsh.terminal.shell.v2.' + JSON.stringify(ownerKey(sessionId)))).toBe(info.shell.path)
  expect(model.state.getSnapshot().error).toBe('shell disappeared')
  await model.refresh()
  expect(h.remote.create).toHaveBeenCalledTimes(2)
  await model.close()
  await model.refresh()
  expect(h.remote.create).toHaveBeenCalledTimes(2)
})

it('keeps launch usable when browser storage is denied and stops late shell discovery after close', async () => {
  vi.stubGlobal('localStorage', undefined)
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied') } })
  const h = fixture()
  const model = h.view()
  await model.refresh()
  expect(model.state.getSnapshot().info).toBeDefined()
  const delayed = h.view()
  const shells = Promise.withResolvers<Awaited<ReturnType<TerminalRemote['shells']>>>()
  vi.mocked(h.remote.shells).mockReturnValueOnce(shells.promise)
  const loading = delayed.refresh()
  await expect.poll(() => h.remote.shells).toHaveBeenCalledTimes(2)
  await delayed.close()
  shells.resolve(success([info.shell]))
  await loading
  expect(delayed.state.getSnapshot().phase).toBe('closed')
  expect(h.remote.create).toHaveBeenCalledOnce()
})

it('retains only open saved occurrences across inactive Sessions and deduplicates their Host identities', async () => {
  storage()
  const otherSession = 'dormant-session' as SessionId
  const otherId = 'other-terminal' as WebTerminalId
  const bindings = new TerminalBindings(ownerKey)
  bindings.set(sessionId, 'a', info.id)
  bindings.set(sessionId, 'duplicate', info.id)
  bindings.set(sessionId, 'stale', 'orphan' as WebTerminalId)
  bindings.set(otherSession, 'b', otherId)
  const h = fixture()
  const { service } = await h.service()
  service.retainTabs([{ sessionId, tabId: 'a', contentId: 'a' }, { sessionId, tabId: 'duplicate', contentId: 'duplicate' }, { sessionId: otherSession, tabId: 'b', contentId: 'b' }])
  await expect.poll(() => h.remote.retain).toHaveBeenCalledTimes(2)
  expect(h.remote.environment).not.toHaveBeenCalled()
  expect(h.remote.create).not.toHaveBeenCalled()
  expect(h.remote.list).not.toHaveBeenCalled()
  expect(h.remote.follow).not.toHaveBeenCalled()
  const calls = vi.mocked(h.remote.retain).mock.calls
  service.retainTabs([{ sessionId: otherSession, tabId: 'b', contentId: 'b' }])
  await expect.poll(() => calls.find(call => call[0] === sessionId)?.[2]?.aborted).toBe(true)
  expect(calls.find(call => call[0] === otherSession)?.[2]?.aborted).toBe(false)
  service.retainTabs([])
  await expect.poll(() => calls.every(call => call[2]?.aborted)).toBe(true)
})

it('waits for the window hold acknowledgement before restoring an output attachment', async () => {
  storage()
  new TerminalBindings(ownerKey).set(sessionId, 'restored', info.id)
  const h = fixture()
  vi.mocked(h.remote.list).mockResolvedValue(success([info]))
  const acknowledge = Promise.withResolvers<undefined>()
  vi.mocked(h.remote.retain).mockImplementation(async function* (_session, _id, signal) {
    await acknowledge.promise
    yield { type: 'retained' }
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve()
      else signal?.addEventListener('abort', () => { resolve() }, { once: true })
    })
  })
  const { service } = await h.service()
  service.retainTabs([{ sessionId, tabId: 'restored', contentId: 'restored' }])
  const model = service.view(sessionId, 'restored', 'restored')
  model.mount()
  await model.refresh()
  expect(h.remote.follow).not.toHaveBeenCalled()
  acknowledge.resolve(undefined)
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  expect(h.remote.retain).toHaveBeenCalledOnce()
  expect(h.remote.create).not.toHaveBeenCalled()
})

it('shows a missing terminal when retention loses the race to Host cleanup, without allocating a replacement', async () => {
  storage()
  new TerminalBindings(ownerKey).set(sessionId, 'restored', info.id)
  const h = fixture()
  vi.mocked(h.remote.list).mockResolvedValue(success([info]))
  vi.mocked(h.remote.retain).mockImplementation(() => { throw new RemoteError('terminal/unavailable', 'gone', {}) })
  const { service } = await h.service()
  service.retainTabs([{ sessionId, tabId: 'restored', contentId: 'restored' }])
  const model = service.view(sessionId, 'restored', 'restored')
  model.mount()
  await expect.poll(() => model.state.getSnapshot().issue).toBe('missingTerminal')
  expect(h.remote.follow).not.toHaveBeenCalled()
  expect(h.remote.create).not.toHaveBeenCalled()
})

it('ignores late inventory after disposal and excludes missing bindings and saved close requests', async () => {
  storage()
  new TerminalBindings(ownerKey).set(sessionId, 'closing', info.id)
  new TerminalCloseRequests(ownerKey).save({ sessionId, id: info.id, title: 'Closing' })
  const h = fixture()
  const { service, dispose } = await h.service()
  service.retainTabs([{ sessionId, tabId: 'missing', contentId: 'missing' }, { sessionId, tabId: 'closing', contentId: 'closing' }])
  expect(h.remote.retain).not.toHaveBeenCalled()
  await dispose()
  service.retainTabs([{ sessionId, tabId: 'closing', contentId: 'closing' }])
  expect(h.remote.retain).not.toHaveBeenCalled()
})

it('keeps other holds usable when releasing one transport fails', async () => {
  storage()
  new TerminalBindings(ownerKey).set(sessionId, 'a', info.id)
  const h = fixture()
  const { service } = await h.service()
  service.retainTabs([{ sessionId, tabId: 'a', contentId: 'a' }])
  await expect.poll(() => h.remote.retain).toHaveBeenCalledOnce()
  const { TerminalWindowHold } = await import('../src/client/retention.ts')
  // oxlint-disable-next-line typescript/unbound-method -- Preserve the real disposer while injecting one failure after it settles.
  const original = TerminalWindowHold.prototype.dispose
  const failure = vi.spyOn(TerminalWindowHold.prototype, 'dispose')
  failure.mockImplementationOnce(async function (this: InstanceType<typeof TerminalWindowHold>) {
    await original.call(this)
    throw new Error('transport close failed')
  })
  service.retainTabs([])
  await expect.poll(() => failure).toHaveBeenCalledOnce()
  await setImmediate()
  failure.mockRestore()
  service.retainTabs([{ sessionId, tabId: 'a', contentId: 'a' }])
  await expect.poll(() => h.remote.retain).toHaveBeenCalledTimes(2)
})

it('ignores a delayed retention failure after the restored view was disposed', async () => {
  const h = fixture()
  vi.mocked(h.remote.list).mockResolvedValue(success([info]))
  const retained = Promise.withResolvers<undefined>()
  const gateway: Pick<ClientRemote, '$stream'> = { $stream: options => new RemoteStream({ generation: createSnapshotStore(undefined) }, options) }
  const model = new TerminalView(sessionId, h.remote, gateway, info.id, false, undefined, () => retained.promise)
  cleanups.push(() => model.dispose())
  await model.refresh()
  await model.dispose()
  const snapshot = model.state.getSnapshot()
  retained.reject(new Error('late hold rejection'))
  await setImmediate()
  expect(model.state.getSnapshot()).toBe(snapshot)
})

it('keeps new terminals with colliding layout-local tab ids independent across shared-storage windows', async () => {
  storage()
  const h = fixture()
  const first = await h.service()
  const second = await h.service()
  const a = first.service.view(sessionId, 'tab2', 'sidebar://terminal/a')
  await a.refresh()
  const b = second.service.view(sessionId, 'tab2', 'sidebar://terminal/b')
  await b.refresh()
  expect(a.id).not.toBe(b.id)
  expect(h.remote.create).toHaveBeenCalledTimes(2)
  first.service.close(sessionId, 'tab2', 'sidebar://terminal/a')
  await expect.poll(() => new TerminalCloseRequests(ownerKey).pending()).toEqual([])
  expect(h.remote.close).toHaveBeenCalledWith(sessionId, a.id)
  expect(h.remote.close).not.toHaveBeenCalledWith(sessionId, b.id)
  await second.dispose()
  vi.mocked(h.remote.list).mockResolvedValue(success([{ ...info, id: b.id }]))
  const reloaded = await h.service()
  const restored = reloaded.service.view(sessionId, 'tab2', 'sidebar://terminal/b')
  await restored.refresh()
  expect(restored.id).toBe(b.id)
  expect(h.remote.create).toHaveBeenCalledTimes(2)
})


it('keeps saved bindings and unfinished closes inside their verified account and runtime', () => {
  const data = storage()
  let current: string | undefined = 'alice/project:7'
  const key = (id: SessionId) => current === undefined ? undefined : JSON.stringify([current, id])
  const bindings = new TerminalBindings(key), requests = new TerminalCloseRequests(key)
  bindings.set(sessionId, 'shared-tab', info.id)
  const original = { sessionId, id: info.id, title: 'Private build' }
  requests.save(original)
  current = 'bob/project:7'
  expect(bindings.get(sessionId, 'shared-tab')).toBeUndefined()
  expect(requests.pending()).toEqual([])
  const bob = { ...original, title: 'Bob build' }
  requests.save(bob)
  requests.remove(original)
  expect(requests.pending()).toEqual([bob])
  expect([...data.values()]).toContain(JSON.stringify(bob))
  current = 'bob/project:8'
  expect(requests.pending()).toEqual([])
  current = undefined
  expect(bindings.get(sessionId, 'shared-tab')).toBeUndefined()
  expect(() =>{  bindings.set(sessionId, 'new', info.id) }).toThrow('not verified')
  expect(() =>{  requests.save(original) }).toThrow('not verified')
  bindings.delete(sessionId, 'shared-tab')
  current = 'bob/project:7'
  requests.refresh()
  expect(requests.pending()).toEqual([bob])
})

it('clears private screen state and rejects late inventory when the account changes', async () => {
  storage()
  let current: string | undefined = 'alice'
  const listeners = new Set<() => void>()
  const identity: TerminalClient.TerminalIdentitySource = {
    key: id => current === undefined ? undefined : JSON.stringify([current, id]),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const h = fixture(identity), { service } = await h.service()
  const model = service.view(sessionId, 'tab', 'tab')
  model.mount()
  await expect.poll(() => model.state.getSnapshot().render?.frame.type).toBe('snapshot')
  const pending = Promise.withResolvers<RemoteResult<WebTerminalInfo[]>>()
  vi.mocked(h.remote.list).mockReturnValueOnce(pending.promise)
  const inventory = service.recover(sessionId)
  current = undefined
  for (const listener of listeners) listener()
  expect(model.state.getSnapshot()).toEqual({ phase: 'closed', writable: false })
  expect(() => service.view(sessionId, 'tab', 'tab')).toThrow('not verified')
  pending.resolve(success([info]))
  await expect(inventory).rejects.toThrow('ownership changed')
  current = 'bob'
  for (const listener of listeners) listener()
  const replacement = service.view(sessionId, 'tab', 'tab')
  expect(replacement.id).not.toBe(model.id)
  expect(replacement.state.getSnapshot().render).toBeUndefined()
})

it('ignores unowned legacy close records instead of replaying them under a newly logged-in user', async () => {
  const data = storage()
  data.set('dsh.terminal.close.v1.terminal', JSON.stringify({ sessionId, id: info.id, title: 'Old owner' }))
  const h = fixture(), { service } = await h.service()
  expect(service.closeFailures.getSnapshot()).toEqual([])
  expect(h.remote.close).not.toHaveBeenCalled()
})

it('keeps shell preferences private and discards discovery after ownership changes', async () => {
  storage()
  let account = 'alice'
  const identity: TerminalClient.TerminalIdentitySource = { key: id => JSON.stringify([account, id]), subscribe: () => () => {} }
  const h = fixture(identity), { service } = await h.service()
  const alternate = { name: 'bash', path: '/bin/bash', args: ['-i'] }
  vi.mocked(h.remote.shells).mockResolvedValue(success([info.shell, alternate]))
  service.selectShell(sessionId, alternate.path)
  expect((await service.launchShells(sessionId, new AbortController().signal)).selectedShell).toBe(alternate.path)
  account = 'bob'
  expect((await service.launchShells(sessionId, new AbortController().signal)).selectedShell).toBe(info.shell.path)
  const pending = Promise.withResolvers<Awaited<ReturnType<TerminalRemote['shells']>>>()
  vi.mocked(h.remote.shells).mockReturnValueOnce(pending.promise)
  const loading = service.launchShells(sessionId, new AbortController().signal)
  account = 'carol'
  pending.resolve(success([alternate]))
  await expect(loading).rejects.toThrow('ownership changed')
})

it('erases retained private output when the server revokes terminal qualification', async () => {
  const h = fixture(), model = h.view()
  model.mount()
  await model.refresh()
  await expect.poll(() => model.state.getSnapshot().render?.frame.type).toBe('snapshot')
  vi.mocked(h.remote.rename).mockResolvedValueOnce({ ok: false, error: new RemoteError('terminal/forbidden', 'Terminal qualification revoked', {}) })
  await model.rename('unavailable')
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'failed', writable: false, error: 'Terminal qualification revoked' })
  expect(model.state.getSnapshot().info).toBeUndefined()
  expect(model.state.getSnapshot().render).toBeUndefined()
  expect(model.state.getSnapshot().title).toBeUndefined()
})

it('waits for verified Client services and disposes their ownership observers', async () => {
  storage()
  const h = fixture(), ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const catalog = createSnapshotStore({ byId: { [sessionId]: { id: sessionId } } })
  const host = createSnapshotStore<{ executionAuthorityRequired: boolean } | undefined>(undefined)
  const policy = createSnapshotStore<{ verifiedAccountId?: number }>({})
  const stores = [catalog, host, policy]
  const subscriptions = stores.map(store => vi.spyOn(store, 'subscribe'))
  const mount = vi.fn(async (contribution: { package: string }) => {
    expect(contribution.package).toBe('@deepseek-ai/dsh-api-terminal-controller')
    return async () => {}
  })
  ctx.provide('remote', { terminal: h.remote, $mount: mount } as never)
  ctx.provide('remote.terminal', h.remote)
  ctx.provide('sessions', { list: catalog, runtimeIdentityFor: () => ({ kind: 'personal' }) } as never)
  ctx.provide('connection', { hostDescription: host } as never)
  ctx.provide('projectUiPolicy', policy as never)
  const fiber = await ctx.plugin({ inject: TerminalClient.inject, apply: TerminalClient.apply })
  expect(() => ctx.webTerminals.view(sessionId, 'tab', 'tab')).toThrow('not verified')
  ctx.webTerminals.retainTabs([{ sessionId, tabId: 'tab', contentId: 'tab' }])
  host.set({ executionAuthorityRequired: true })
  policy.set({ verifiedAccountId: 12 })
  expect(await ctx.webTerminals.launchShells(sessionId, new AbortController().signal)).toMatchObject({ selectedShell: '/bin/zsh' })
  policy.set({})
  expect(() =>{  ctx.webTerminals.selectShell(sessionId, '/bin/zsh') }).toThrow('not verified')
  const service = ctx.webTerminals
  await fiber.dispose()
  expect(mount).toHaveBeenCalledTimes(1)
  expect(subscriptions.every(subscribe => subscribe.mock.calls.length === 1)).toBe(true)
  host.set({ executionAuthorityRequired: false })
  expect(() =>{  service.selectShell(sessionId, '/bin/zsh') }).toThrow('not verified')
})

it('ignores foreign cleanup storage while preserving the current account intent', () => {
  const data = storage(), requests = new TerminalCloseRequests(ownerKey)
  const unknown = { sessionId, id: info.id, title: 'Unknown' }
  expect(requests.address(unknown)).toBeUndefined()
  requests.remove(unknown)
  data.set('dsh.terminal.close.v2.' + JSON.stringify(['another-account', info.id]), JSON.stringify(unknown))
  requests.refresh()
  expect(requests.pending()).toEqual([])
  expect(data.size).toBe(1)
})

it('awaits detached views and saved holds when ownership is withdrawn, even after a cleanup error', async () => {
  storage()
  let current: string | undefined = ownerKey(sessionId)
  const listeners = new Set<() => void>()
  const h = fixture({ key: () => current,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } })
  const { service, dispose } = await h.service()
  const model = service.view(sessionId, 'tab', 'tab')
  await model.refresh()
  service.retainTabs([{ sessionId, tabId: 'tab', contentId: 'tab' }])
  const original = model.dispose.bind(model)
  vi.spyOn(model, 'dispose').mockImplementationOnce(async () => { await original(); throw new Error('detach failed') })
  current = undefined
  for (const listener of listeners) listener()
  await setImmediate()
  await dispose()
  expect(model.state.getSnapshot()).toEqual({ phase: 'closed', writable: false })
  expect(h.remote.close).not.toHaveBeenCalled()
})


it('does not install terminal models when the generated namespace cannot mount', async () => {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.provide('remote', { $mount: async () => { throw new Error('duplicate terminal namespace') } } as never)
  ctx.provide('sessions', {} as never)
  ctx.provide('connection', {} as never)
  ctx.provide('projectUiPolicy', {} as never)
  await expect(ctx.plugin({ inject: TerminalClient.inject, apply: TerminalClient.apply })).rejects.toThrow('duplicate terminal namespace')
  expect(ctx.get('webTerminals')).toBeUndefined()
})
