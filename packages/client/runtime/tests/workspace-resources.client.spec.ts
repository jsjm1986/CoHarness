import { describe, expect, it, vi } from 'vitest'
import {
  WorkspaceResourceRegistry, WorkspaceResourceError, parseWorkspaceResourceAddress,
  workspaceResourceAddress, workspacePathForResource, workspaceResourceProvider,
} from '../src/client/workspace-resources.ts'
import type { WorkspaceResourceOpenRequest, WorkspaceResourceValue } from '../src/client/workspace-resources.ts'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { FakeApiClient, err } from './fake-api.client.ts'

const sessionId = 'session-1' as SessionId
const base = { kind: 'base' as const }
function resource(path = 'src/index.ts'): WorkspaceResourceOpenRequest {
  return { runtimeTarget: base, sessionId, path, address: workspaceResourceAddress(sessionId, path) }
}
function value(version = 'v1'): WorkspaceResourceValue {
  return { sessionId, path: 'src/index.ts', type: 'file', bytes: 4, version, changed: false }
}
function deferred<T>() {
  let resolve!: (result: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

describe('Workspace resource addresses', () => {
  it('encodes Unicode, percent signs, Windows separators, and the root', () => {
    const address = workspaceResourceAddress(sessionId, 'src\\中文 100%.ts')
    expect(parseWorkspaceResourceAddress(address)).toEqual({ sessionId, path: 'src/中文 100%.ts' })
    expect(parseWorkspaceResourceAddress(workspaceResourceAddress(sessionId, '.'))).toEqual({ sessionId, path: '.' })
    expect(workspacePathForResource('C:\\project', 'C:\\project\\a.ts')).toBe('a.ts')
    expect(workspacePathForResource(undefined, 'src//./index.ts')).toBe('src/index.ts')
    expect(() => workspacePathForResource(undefined, '../secret')).toThrow('outside')
    expect(() => workspacePathForResource('/root', '/root-other/a')).toThrow('outside')
  })

  it.each(['file:///etc/passwd', 'dsh-resource://file/absolute/etc/passwd',
    'dsh-resource://file/session/s/%2Fetc', 'dsh-resource://file/session/s/a%5Cb',
    'dsh-resource://file/session/s/%2e%2e/secret', 'dsh-resource://file/session/s/C%3A/secret',
    'dsh-resource://file/session/s/%00', 'dsh-resource://file/session/s/%XX',
    'dsh-resource://file/session/a%2Fb/file', 'dsh-resource://file/session/s//file',
  ])('rejects unsafe addresses: %s', (address) => { expect(parseWorkspaceResourceAddress(address)).toBeUndefined() })

  it.each(['/etc/passwd', '../secret', 'C:\\secret', '\\\\host\\secret', 'https://host/file'])('rejects absolute or traversing input: %s', (path) => {
    expect(() => workspaceResourceAddress(sessionId, path)).toThrow()
  })
})

describe('Workspace resource lifetime', () => {
  it('coalesces loads and preserves observations arriving before stat', async () => {
    const pending = deferred<WorkspaceResourceValue>()
    const stat = vi.fn(() => pending.promise)
    const registry = new WorkspaceResourceRegistry()
    const dispose = registry.register(base, { stat }, 10)
    const request = resource()
    const source = registry.source(request)
    const release = source.subscribe(vi.fn())
    const unpin = registry.pin(request)
    const reload = source.reload()
    registry.handleChange(base, { sessionId, path: request.path, version: 'v2' })
    pending.resolve(value())
    await reload
    expect(stat).toHaveBeenCalledTimes(1)
    expect(source.get()).toMatchObject({ status: 'live', value: { version: 'v1', changed: true } })
    expect(registry.source(request)).toBe(source)
    release(); unpin(); dispose()
  })

  it('releases each pin once and cancels the last pending read', async () => {
    const pending = deferred<WorkspaceResourceValue>()
    const stat = vi.fn((_address, _signal: AbortSignal) => pending.promise)
    const registry = new WorkspaceResourceRegistry()
    registry.register(base, { stat }, 10)
    const request = resource()
    const first = registry.pin(request)
    const second = registry.pin(request)
    await vi.waitFor(() => { expect(stat).toHaveBeenCalledTimes(1) })
    first(); first()
    expect(stat.mock.calls[0]?.[1].aborted).toBe(false)
    second()
    expect(stat.mock.calls[0]?.[1].aborted).toBe(true)
    pending.resolve(value())
    await Promise.resolve()
    expect(registry.source(request).get().status).toBe('none')
  })

  it('does not retain already-aborted pins and removes pin abort listeners', async () => {
    const registry = new WorkspaceResourceRegistry()
    const stat = vi.fn(async () => value())
    registry.register(base, { stat }, 1)
    registry.pin(resource(), AbortSignal.abort())()
    expect(stat).not.toHaveBeenCalled()
    const abort = new AbortController()
    const remove = vi.spyOn(abort.signal, 'removeEventListener')
    const release = registry.pin(resource(), abort.signal)
    release()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('isolates identical Session addresses across runtime targets', async () => {
    const registry = new WorkspaceResourceRegistry()
    const project = { kind: 'project' as const, projectId: 9 }
    registry.register(base, { stat: async () => value('personal') }, 10)
    registry.register(project, { stat: async () => value('project') }, 10)
    const first = registry.source(resource())
    const second = registry.source({ ...resource(), runtimeTarget: project })
    await Promise.all([first.reload(), second.reload()])
    registry.handleChange(project, { sessionId, path: resource().path, version: 'updated' })
    expect(first.get()).toMatchObject({ value: { version: 'personal', changed: false } })
    expect(second.get()).toMatchObject({ value: { version: 'project', changed: true } })
  })

  it('preserves metadata on transient failure but clears it on revoked access', async () => {
    const registry = new WorkspaceResourceRegistry()
    const stat = vi.fn(async () => value())
    registry.register(base, { stat }, 10)
    const source = registry.source(resource())
    await source.reload()
    stat.mockRejectedValueOnce(new Error('temporary failure'))
    await source.reload()
    expect(source.get()).toMatchObject({ status: 'failed', value: { version: 'v1' } })
    stat.mockRejectedValueOnce(new WorkspaceResourceError('collaboration-forbidden', 'denied'))
    await source.reload()
    expect(source.get()).toMatchObject({ status: 'failed' })
    expect(source.get().value).toBeUndefined()
  })

  it('ignores old-generation completion and revalidates without clearing retained content', async () => {
    const registry = new WorkspaceResourceRegistry()
    const old = deferred<WorkspaceResourceValue>()
    const stat = vi.fn(async () => value()).mockImplementationOnce(() => old.promise)
    registry.register(base, { stat }, 10)
    const request = resource()
    const release = registry.pin(request)
    await vi.waitFor(() => { expect(stat).toHaveBeenCalledTimes(1) })
    registry.disconnect(base)
    registry.connected(base)
    await vi.waitFor(() => { expect(registry.source(request).get().status).toBe('live') })
    old.resolve(value('old-generation'))
    await Promise.resolve()
    expect(registry.source(request).get()).toMatchObject({ value: { version: 'v1' } })
    registry.disconnect(base)
    expect(registry.source(request).get()).toMatchObject({ status: 'failed', value: { version: 'v1' } })
    stat.mockResolvedValueOnce(value('v2'))
    registry.connected(base)
    await vi.waitFor(() => { expect(registry.source(request).get()).toMatchObject({ value: { version: 'v2', changed: true } }) })
    release()
  })

  it('evicts idle metadata while old source handles can subscribe again', async () => {
    const registry = new WorkspaceResourceRegistry()
    const stat = vi.fn(async () => value())
    registry.register(base, { stat }, 1)
    const first = registry.source(resource())
    await first.reload()
    await registry.source(resource('other.ts')).reload()
    expect(first.get().status).toBe('none')
    const release = first.subscribe(vi.fn())
    await vi.waitFor(() => { expect(first.get().status).toBe('live') })
    expect(stat).toHaveBeenCalledTimes(3)
    expect(() => registry.pin(resource('third.ts'))).toThrow('limit')
    release()
  })

  it('unregistering a provider clears data and rejects late stat completion', async () => {
    const registry = new WorkspaceResourceRegistry()
    const pending = deferred<WorkspaceResourceValue>()
    const dispose = registry.register(base, { stat: () => pending.promise }, 10)
    const source = registry.source(resource())
    const notify = vi.fn()
    const release = source.subscribe(notify)
    dispose(); dispose()
    pending.resolve(value())
    await Promise.resolve()
    expect(source.get()).toMatchObject({ status: 'failed', error: { code: 'access-revoked' } })
    expect(source.get().value).toBeUndefined()
    release()
  })

  it('uses the explicitly bound API and preserves RPC errors', async () => {
    const api = new FakeApiClient()
    const stat = vi.spyOn(api.workspaceFiles, 'stat').mockResolvedValue(err({ code: 'collaboration-forbidden', message: 'denied', details: { action: 'read', reason: 'forbidden' } }))
    const provider = workspaceResourceProvider(api)
    await expect(provider.stat(resource().address, new AbortController().signal)).rejects.toMatchObject({ code: 'collaboration-forbidden' })
    expect(stat).toHaveBeenCalledWith({ sessionId, path: resource().path }, expect.any(AbortSignal))
  })
})
