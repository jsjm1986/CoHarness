// @vitest-environment jsdom
/** The sandboxed iframe follows file identity and resource access, not unrelated state changes. */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceResourceRegistry, WorkspaceResourceError, workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { WorkspaceHtmlPreview, isWorkspaceHtml } from '../src/client/components/WorkspaceHtmlPreview.tsx'
import type { RenderWorkspaceHtml } from '../src/client/components/WorkspaceHtmlPreview.tsx'
import { createReadHtmlRelative } from '../src/client/html/read-relative.ts'
import type { ReadWorkspaceFileData } from '../src/client/html/read-relative.ts'
import { MAX_ASSET_BYTES, MAX_TOTAL_BYTES, packHtml } from '../src/client/html/pack.ts'
import { createHtmlDocument } from '../src/client/html/bootstrap.ts'
import { createWorkspacePreviewReaders } from '../src/client/preview-readers.ts'
import { en } from '../src/client/html/locales.ts'
import { PreviewResourceBinding } from './workspace-preview-resource.fixture.tsx'

const translations: ReadonlyMap<string, string> = new Map(Object.entries(en))
const htmlT = (key: string): string => translations.get(key) ?? key
const renderHtml: RenderWorkspaceHtml = async (data, read, request, lifetime, signal) =>
  createHtmlDocument(await packHtml(data, createReadHtmlRelative(read, request, lifetime), signal))
let createDescriptor: PropertyDescriptor | undefined
let revokeDescriptor: PropertyDescriptor | undefined
const create = vi.fn<(blob: Blob) => string>()
const revoke = vi.fn<(url: string) => void>()

beforeEach(() => {
  createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  create.mockReset().mockImplementation(() => `blob:https://preview.invalid/${create.mock.calls.length}`)
  revoke.mockReset()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
})

afterEach(() => {
  try { cleanup() } finally {
    if (createDescriptor === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
    else Object.defineProperty(URL, 'createObjectURL', createDescriptor)
    if (revokeDescriptor === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL')
    else Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor)
  }
})

const id = 'html-session' as SessionId
const request: WorkspaceResourceOpenRequest = {
  sessionId: id, runtimeTarget: { kind: 'base' }, path: 'index.html', address: workspaceResourceAddress(id, 'index.html'),
}
const file = (text: string, version = 'v1') => ({ bytes: btoa(text), version })

function harness(read: ReadWorkspaceFileData) {
  const resources = new WorkspaceResourceRegistry()
  let version = 'v1'
  resources.register(request.runtimeTarget, {
    stat: async () => ({ sessionId: id, path: request.path, type: 'file', version, bytes: 10, changed: false }),
  }, 5)
  const close = vi.fn()
  const view = render(<PreviewResourceBinding resources={resources} request={request}>{resource =>
    <WorkspaceHtmlPreview request={request} resource={resource} read={read}
      renderHtml={renderHtml} htmlT={htmlT} close={close}
      labels={{ close: 'Close', reload: 'Reload', changed: 'File changed' }} />
  }</PreviewResourceBinding>)
  return { ...view, resources, close, change() {
    version = 'v2'
    resources.handleChange(request.runtimeTarget, { sessionId: id, path: request.path, version })
  } }
}

describe('WorkspaceHtmlPreview', () => {
  it('renders a script-only Blob iframe and revokes it on unmount', async () => {
    const read = vi.fn<ReadWorkspaceFileData>().mockResolvedValue(file('<p>hello</p>'))
    const view = harness(read)
    const iframe = await waitFor(() => view.getByTitle(en.frame))
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.getAttribute('src')).toBe('blob:https://preview.invalid/1')
    expect(create.mock.calls[0]?.[0].type).toBe('text/html')
    expect(read).toHaveBeenCalledWith({ resource: request, version: 'v1', maxBytes: MAX_TOTAL_BYTES }, expect.any(AbortSignal))
    view.unmount()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:https://preview.invalid/1')
  })

  it('packs declared sibling dependencies through the same authorized reader', async () => {
    const read = vi.fn<ReadWorkspaceFileData>(async ({ resource }) => (
      resource.path === 'index.html' ? file('<script src="./app.js"></script><link rel="stylesheet" href="main.css">')
        : file('asset')
    ))
    const view = harness(read)
    await waitFor(() => { expect(view.getByTitle(en.frame)).toBeTruthy() })
    const paths = read.mock.calls.map(call => call[0].resource.path)
    expect(paths).toEqual(['index.html', 'app.js', 'main.css'])
    for (const call of read.mock.calls.slice(1)) {
      expect(call[0].maxBytes).toBe(MAX_ASSET_BYTES)
      expect(call[0].resource.sessionId).toBe(id)
      expect(call[0].resource.runtimeTarget).toEqual(request.runtimeTarget)
      expect(call[0].resource.address).toBe(workspaceResourceAddress(id, call[0].resource.path))
    }
  })

  it('retains the displayed revision until explicit reload, then clears it immediately on revocation', async () => {
    const read = vi.fn<ReadWorkspaceFileData>(async ({ version: v }) => file(`<p>${v ?? 'none'}</p>`, v ?? 'v1'))
    const view = harness(read)
    await waitFor(() => { expect(view.getByTitle(en.frame)).toBeTruthy() })
    act(() => { view.change() })
    expect(view.getByText('File changed')).toBeTruthy()
    expect(read).toHaveBeenCalledTimes(1)
    fireEvent.click(view.getByRole('button', { name: 'Reload' }))
    await waitFor(() => { expect(read).toHaveBeenCalledTimes(2) })
    act(() => { view.resources.disconnect(request.runtimeTarget, new WorkspaceResourceError('access-revoked', 'Access revoked')) })
    expect(view.container.querySelector('iframe')).toBeNull()
    expect(read.mock.calls.at(-1)![1].aborted).toBe(true)
    expect(view.getByRole('button', { name: 'Reload' }).hasAttribute('disabled')).toBe(true)
  })

  it('aborts a pending read on unmount without creating a frame', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<ReadWorkspaceFileData>>>()
    const read = vi.fn<ReadWorkspaceFileData>().mockReturnValue(pending.promise)
    const view = harness(read)
    await waitFor(() => { expect(read).toHaveBeenCalledOnce() })
    view.unmount()
    expect(read.mock.calls[0]![1].aborted).toBe(true)
    await act(async () => { pending.resolve(file('<p>late</p>')) })
    expect(create).not.toHaveBeenCalled()
    expect(view.container.childElementCount).toBe(0)
  })

  it('ignores a read rejection after unmount', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<ReadWorkspaceFileData>>>()
    const read = vi.fn<ReadWorkspaceFileData>().mockReturnValue(pending.promise)
    const view = harness(read)
    await waitFor(() => { expect(read).toHaveBeenCalledOnce() })
    view.unmount()
    await act(async () => { pending.reject(new Error('late failure')) })
    expect(view.container.childElementCount).toBe(0)
  })

  it('reports a read rejection and permits retry', async () => {
    const read = vi.fn<ReadWorkspaceFileData>()
      .mockRejectedValueOnce('read interrupted')
      .mockResolvedValueOnce(file('<p>ok</p>'))
    const view = harness(read)
    await waitFor(() => { expect(view.getByRole('alert').textContent).toBe('read interrupted') })
    fireEvent.click(view.getByRole('button', { name: 'Reload' }))
    await waitFor(() => { expect(view.getByTitle(en.frame)).toBeTruthy() })
  })

  it('reports a packing failure without leaving a frame running', async () => {
    const read = vi.fn<ReadWorkspaceFileData>(async ({ resource }) => (
      resource.path === 'index.html' ? file('<script src="./app.js"></script>') : Promise.reject(new Error('outside workspace'))
    ))
    const view = harness(read)
    await waitFor(() => { expect(view.getByRole('alert').textContent).toBe(en.failed) })
    expect(view.container.querySelector('iframe')).toBeNull()
  })

  it('propagates a denied read to every resource on the owning runtime', async () => {
    const read = vi.fn<ReadWorkspaceFileData>().mockRejectedValue(new WorkspaceResourceError('access-revoked', 'Permission removed'))
    const view = harness(read)
    await waitFor(() => { expect(view.getByRole('alert').textContent).toBe('Permission removed') })
    expect(view.resources.source(request).getSnapshot().error?.message).toBe('Permission removed')
    expect(view.container.querySelector('iframe')).toBeNull()
    expect(view.getByRole('button', { name: 'Reload' }).hasAttribute('disabled')).toBe(true)
    expect(read).toHaveBeenCalledOnce()
    expect(read.mock.calls[0]![1].aborted).toBe(true)
  })

  it('recognizes HTML suffixes only', () => {
    expect(isWorkspaceHtml('index.html')).toBe(true)
    expect(isWorkspaceHtml('PAGE.HTM')).toBe(true)
    expect(isWorkspaceHtml('index.xhtml')).toBe(false)
    expect(isWorkspaceHtml('index.md')).toBe(false)
  })
})

describe('readFileBytes', () => {
  const { readFileBytes } = createWorkspacePreviewReaders(undefined)
  const signal = new AbortController().signal

  it('rejects a missing runtime before any RPC', async () => {
    await expect(readFileBytes({ resource: request, maxBytes: 1024 }, signal)).rejects.toMatchObject({ code: 'access-revoked' })
    const project: WorkspaceResourceOpenRequest = {
      ...request, runtimeTarget: { kind: 'project', projectId: 4 },
    }
    await expect(createWorkspacePreviewReaders({} as ConnectionHandle).readFileBytes({ resource: project, maxBytes: 1024 }, signal))
      .rejects.toMatchObject({ code: 'access-revoked' })
  })

  it('stats then reads version-guarded windows until EOF on the owning target', async () => {
    const bytes = Array.from({ length: 9 }, (_, index) => index + 1)
    const encoded = btoa(String.fromCharCode(...bytes))
    const stat = vi.fn(async () => ({ result: { ok: true as const, value: { path: 'bin.dat', type: 'file' as const, bytes: 9, version: 'v9' } } }))
    const readBytes = vi.fn(async (request: { offset: number; version?: string }) => {
      const first = request.offset === 0
      return { result: { ok: true as const, value: { path: 'bin.dat', offset: request.offset, bytes: first ? encoded.slice(0, 8) : encoded.slice(8), eof: !first, version: 'v9' } } }
    })
    const forTarget = vi.fn(() => ({ api: { workspaceFiles: { stat, readBytes } } }))
    const connection = { api: { workspaceFiles: { stat, readBytes } }, forTarget } as unknown as ConnectionHandle
    const readers = createWorkspacePreviewReaders(connection)
    const resource: WorkspaceResourceOpenRequest = {
      runtimeTarget: { kind: 'project', projectId: 4 }, sessionId: id, path: 'bin.dat',
      address: workspaceResourceAddress(id, 'bin.dat'),
    }
    const result = await readers.readFileBytes({ resource, maxBytes: 1024 }, signal)
    expect(forTarget).toHaveBeenCalledWith({ kind: 'project', projectId: 4 })
    expect(stat).toHaveBeenCalledWith({ sessionId: id, path: 'bin.dat' }, signal)
    expect(readBytes).toHaveBeenCalledTimes(2)
    expect(atob(result.bytes).split('').map(c => c.charCodeAt(0))).toEqual(bytes)
    expect(result.version).toBe('v9')
  })

  it('skips stat when the caller already holds the version and rejects an empty non-EOF window', async () => {
    const stat = vi.fn()
    const readBytes = vi.fn(async () => ({ result: { ok: true as const, value: { path: 'bin.dat', offset: 0, bytes: '', eof: false, version: 'v9' } } }))
    const connection = { api: { workspaceFiles: { stat, readBytes } } } as unknown as ConnectionHandle
    const readers = createWorkspacePreviewReaders(connection)
    await expect(readers.readFileBytes({ resource: request, version: 'v9', maxBytes: 1024 }, signal)).rejects.toThrow('no progress')
    expect(stat).not.toHaveBeenCalled()
    expect(readBytes).toHaveBeenCalledWith({ sessionId: id, path: request.path, offset: 0, version: 'v9' }, signal)
  })

  it('preserves RPC failure categories and rejects non-file stat results', async () => {
    type StatResult = {
      result: { ok: true; value: { path: string; type: string; version: string; bytes?: number } }
        | { ok: false; error: { code: string; message: string } }
    }
    const stat = vi.fn(async (): Promise<StatResult> => ({ result: { ok: false, error: { code: 'access-revoked', message: 'Permission removed' } } }))
    const readBytes = vi.fn()
    const connection = { api: { workspaceFiles: { stat, readBytes } } } as unknown as ConnectionHandle
    const readers = createWorkspacePreviewReaders(connection)
    await expect(readers.readFileBytes({ resource: request, maxBytes: 1024 }, signal)).rejects.toMatchObject({ code: 'access-revoked', message: 'Permission removed' })
    stat.mockResolvedValueOnce({ result: { ok: true, value: { path: request.path, type: 'directory', version: 'v1' } } })
    await expect(readers.readFileBytes({ resource: request, maxBytes: 1024 }, signal)).rejects.toMatchObject({ code: 'workspace-file/not-regular-file' })
    stat.mockResolvedValueOnce({ result: { ok: true, value: { path: request.path, type: 'file', version: 'v1' } } })
    readBytes.mockResolvedValueOnce({ result: { ok: false, error: { code: 'workspace-file/stale-version', message: 'File changed' } } })
    await expect(readers.readFileBytes({ resource: request, maxBytes: 1024 }, signal)).rejects.toMatchObject({ code: 'workspace-file/stale-version' })
  })

  it('rejects on the stat-reported size before any byte read', async () => {
    const stat = vi.fn(async () => ({ result: { ok: true as const, value: { path: 'big.bin', type: 'file' as const, bytes: 2048, version: 'v1' } } }))
    const readBytes = vi.fn()
    const connection = { api: { workspaceFiles: { stat, readBytes } } } as unknown as ConnectionHandle
    const readers = createWorkspacePreviewReaders(connection)
    await expect(readers.readFileBytes({ resource: request, maxBytes: 1024 }, signal))
      .rejects.toMatchObject({ code: 'workspace-file/too-large', message: 'Workspace file exceeds the preview byte limit' })
    expect(readBytes).not.toHaveBeenCalled()
  })

  it('stops at the first overflowing window without retaining it', async () => {
    const window = (offset: number, eof: boolean) => ({ result: { ok: true as const, value: { path: 'big.bin', offset, bytes: btoa('abcd'), eof, version: 'v9' } } })
    const readBytes = vi.fn(async (request: { offset: number }) => window(request.offset, request.offset === 0 ? false : true))
    const connection = { api: { workspaceFiles: { readBytes } } } as unknown as ConnectionHandle
    const readers = createWorkspacePreviewReaders(connection)
    await expect(readers.readFileBytes({ resource: request, version: 'v9', maxBytes: 5 }, signal))
      .rejects.toMatchObject({ code: 'workspace-file/too-large', message: 'Workspace file exceeds the preview byte limit' })
    expect(readBytes).toHaveBeenCalledTimes(2)
    // The exact bound still admits a complete file.
    readBytes.mockImplementation(async (request: { offset: number }) => window(request.offset, true))
    const result = await readers.readFileBytes({ resource: request, version: 'v9', maxBytes: 4 }, signal)
    expect(atob(result.bytes)).toBe('abcd')
  })

  it('stops reading when the caller aborts between windows', async () => {
    const release = Promise.withResolvers<undefined>()
    const readBytes = vi.fn(async (request: { offset: number }) => (
      request.offset === 0
        ? { result: { ok: true as const, value: { path: 'big.bin', offset: 0, bytes: btoa('ab'), eof: false, version: 'v9' } } }
        : release.promise.then(() => ({ result: { ok: true as const, value: { path: 'big.bin', offset: 2, bytes: '', eof: true, version: 'v9' } } }))
    ))
    const connection = { api: { workspaceFiles: { readBytes } } } as unknown as ConnectionHandle
    const readers = createWorkspacePreviewReaders(connection)
    const abort = new AbortController()
    const reading = readers.readFileBytes({ resource: request, version: 'v9', maxBytes: 1024 }, abort.signal)
    try {
      await vi.waitFor(() => { expect(readBytes).toHaveBeenCalledTimes(2) })
      abort.abort(new Error('preview replaced'))
      release.resolve(undefined)
      await expect(reading).rejects.toThrow('preview replaced')
      expect(readBytes).toHaveBeenCalledTimes(2)
    } finally {
      release.resolve(undefined)
      await reading.catch(() => undefined)
    }
  })
})
