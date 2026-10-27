// @vitest-environment jsdom
/** Document reads and converted bytes follow the existing resource's access lifetime. */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { WorkspaceResourceRegistry, WorkspaceResourceError, workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { WorkspaceDocumentPreview, isWorkspaceDocument } from '../src/client/components/WorkspaceDocumentPreview.tsx'
import type { ReadWorkspaceDocument } from '../src/client/components/WorkspaceDocumentPreview.tsx'
import type { WorkspacePreviewResource } from '../src/client/contract/preview/use-preview-read.ts'
import { createWorkspacePreviewReaders } from '../src/client/preview-readers.ts'
import { en as pdfEn } from '../src/client/pdf/locales.ts'
import { en as officeEn } from '../src/client/office/locales.ts'
import { previewRecoveryLabels, PreviewResourceBinding } from './workspace-preview-resource.fixture.tsx'

vi.mock('../src/client/pdf/pdf.tsx', () => ({ PdfBody: ({ data }: { data: Uint8Array }) => <pre data-testid="pdf">{new TextDecoder().decode(data)}</pre> }))
afterEach(cleanup)
const id = 'document-session' as SessionId
const request: WorkspaceResourceOpenRequest = { sessionId: id, runtimeTarget: { kind: 'base' }, path: 'report.docx', address: workspaceResourceAddress(id, 'report.docx') }
const pdf = (version = 'v1') => ({ bytes: btoa(`PDF ${version}`), version, missingFonts: [] })
function documentPreview(read: ReadWorkspaceDocument, resource: WorkspacePreviewResource, source = request, close = vi.fn()) {
  return <WorkspaceDocumentPreview request={source} resource={resource} read={read}
    pdfT={makeTranslate(pdfEn)} officeT={makeTranslate(officeEn)} close={close} view={{ page: 1 }}
    labels={{ close: 'Close', reload: 'Reload', reconnecting: 'Reload · reconnecting', ...previewRecoveryLabels, changed: 'File changed' }} />
}
function harness(read: ReadWorkspaceDocument, initialStat?: Promise<void>) {
  const resources = new WorkspaceResourceRegistry()
  let version = 'v1'
  let bytes = 10
  let held = initialStat
  resources.register(request.runtimeTarget, {
    stat: async () => {
      const pending = held
      held = undefined
      if (pending !== undefined) await pending
      return { sessionId: id, path: request.path, type: 'file', version, bytes, changed: false }
    },
  }, 5)
  const close = vi.fn()
  const view = render(<PreviewResourceBinding resources={resources} request={request}>{resource =>
    documentPreview(read, resource, request, close)
  }</PreviewResourceBinding>)
  return { ...view, resources, close, change() {
    version = 'v2'
    resources.handleChange(request.runtimeTarget, { sessionId: id, path: request.path, version })
  }, revalidate(nextVersion: string, nextBytes: number) {
    version = nextVersion
    bytes = nextBytes
    resources.disconnect(request.runtimeTarget)
    resources.connected(request.runtimeTarget)
  } }
}

it('retains the displayed revision until explicit reload, then clears it immediately on revocation', async () => {
  const read = vi.fn<ReadWorkspaceDocument>(async ({ version }) => pdf(version))
  const h = harness(read)
  await waitFor(() => { expect(h.getByTestId('pdf').textContent).toBe('PDF v1') })
  act(() => { h.change() })
  expect(h.getByText('File changed')).toBeTruthy()
  expect(read).toHaveBeenCalledTimes(1)
  fireEvent.click(h.getByRole('button', { name: 'Reload' }))
  await waitFor(() => { expect(h.getByTestId('pdf').textContent).toBe('PDF v2') })
  act(() => { h.resources.disconnect(request.runtimeTarget, new WorkspaceResourceError('access-revoked', 'Access revoked')) })
  expect(h.queryByTestId('pdf')).toBeNull()
  expect(read.mock.calls.at(-1)![1].aborted).toBe(true)
  expect(h.getByRole('button', { name: 'Reload' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(h.getByRole('button', { name: 'Close' }))
  expect(h.close).toHaveBeenCalledOnce()
})

it('retains the displayed document across a changed revalidation and re-reads the new revision on reload', async () => {
  const calls: { version: string | undefined; bytes: number | undefined }[] = []
  const read = vi.fn<ReadWorkspaceDocument>(async ({ version, bytes }) => {
    calls.push({ version, bytes })
    return pdf(version)
  })
  const h = harness(read)
  await waitFor(() => { expect(h.getByTestId('pdf').textContent).toBe('PDF v1') })
  expect(calls).toHaveLength(1)
  act(() => { h.revalidate('v2', 30) })
  await waitFor(() => {
    expect(h.resources.source(request).getSnapshot().value).toMatchObject({ version: 'v2', bytes: 30, changed: true })
  })
  expect(h.getByText('File changed')).toBeTruthy()
  expect(h.getByTestId('pdf').textContent).toBe('PDF v1')
  expect(read).toHaveBeenCalledTimes(1)
  fireEvent.click(h.getByRole('button', { name: 'Reload' }))
  await waitFor(() => { expect(h.getByTestId('pdf').textContent).toBe('PDF v2') })
  expect(calls).toHaveLength(2)
  expect(calls[1]).toEqual({ version: 'v2', bytes: 30 })
  expect(h.queryByText('File changed')).toBeNull()
})

it('discards late converted bytes after the preview is hidden', async () => {
  const pending = Promise.withResolvers<ReturnType<typeof pdf>>()
  const read = vi.fn<ReadWorkspaceDocument>(() => pending.promise)
  const h = harness(read)
  await waitFor(() => { expect(read).toHaveBeenCalledOnce() })
  h.unmount()
  expect(read.mock.calls[0]![1].aborted).toBe(true)
  await act(async () => { pending.resolve(pdf()) })
  expect(h.container.childElementCount).toBe(0)
})

it('ignores a conversion failure arriving after disposal', async () => {
  const pending = Promise.withResolvers<ReturnType<typeof pdf>>()
  const read = vi.fn<ReadWorkspaceDocument>(() => pending.promise)
  const h = harness(read)
  await waitFor(() => { expect(read).toHaveBeenCalledOnce() })
  h.unmount()
  await act(async () => { pending.reject(new Error('engine stopped')) })
  expect(h.container.childElementCount).toBe(0)
})

it('reports an unexpected conversion rejection and permits retry', async () => {
  const read = vi.fn<ReadWorkspaceDocument>().mockRejectedValueOnce('conversion interrupted').mockResolvedValueOnce(pdf())
  const h = harness(read)
  await waitFor(() => { expect(h.getByRole('alert').textContent).toBe('conversion interrupted') })
  fireEvent.click(h.getByRole('button', { name: 'Reload' }))
  await waitFor(() => { expect(h.getByTestId('pdf')).toBeTruthy() })
})

it('propagates a denied conversion to every resource on the owning runtime', async () => {
  const read = vi.fn<ReadWorkspaceDocument>().mockRejectedValue(new WorkspaceResourceError('access-revoked', 'Permission removed'))
  const h = harness(read)
  await waitFor(() => { expect(h.getByRole('alert').textContent).toBe('Permission removed') })
  expect(h.resources.source(request).getSnapshot().error?.message).toBe('Permission removed')
  expect(h.queryByTestId('pdf')).toBeNull()
  expect(h.getByRole('button', { name: 'Reload' }).hasAttribute('disabled')).toBe(true)
  expect(read).toHaveBeenCalledOnce()
  expect(read.mock.calls[0]![1].aborted).toBe(true)
})

it.each([
  ['unavailable', 'unavailable'], ['input-too-large', 'tooLarge'], ['output-too-large', 'tooLarge'],
  ['invalid-document', 'invalid'], ['unsupported-format', 'invalid'], ['timeout', 'timeout'],
  ['busy', 'busy'], ['source-changed', 'changed'], ['failed', 'failed'], ['invalid-output', 'failed'],
] as const)('localizes Office %s while preserving the retry action', async (reason, message) => {
  const read = vi.fn<ReadWorkspaceDocument>().mockRejectedValueOnce(new WorkspaceResourceError(`office/${reason}`, 'internal diagnostic'))
    .mockResolvedValueOnce(pdf())
  const h = harness(read)
  await waitFor(() => { expect(h.getByRole('alert').textContent).toBe(officeEn[message]) })
  expect(h.queryByTestId('pdf')).toBeNull()
  fireEvent.click(h.getByRole('button', { name: 'Reload' }))
  await waitFor(() => { expect(h.getByTestId('pdf')).toBeTruthy() })
})

it('routes document reads to the explicit project and rejects missing or failed carriers', async () => {
  const renderOffice = vi.fn(async () => ({ result: { ok: true, value: pdf() } }))
  const readBytes = vi.fn(async () => ({ result: { ok: true, value: { ...pdf(), eof: true } } }))
  const forTarget = vi.fn(() => ({ api: { workspaceFiles: { renderOffice, readBytes } } }))
  const connection = { api: { workspaceFiles: { renderOffice, readBytes } }, forTarget } as unknown as ConnectionHandle
  const readers = createWorkspacePreviewReaders(connection)
  const input = { resource: { ...request, runtimeTarget: { kind: 'project' as const, projectId: 7 } }, version: 'v1', bytes: 10 }
  const signal = new AbortController().signal
  await expect(readers.readDocument(input, signal)).resolves.toEqual(pdf())
  expect(forTarget).toHaveBeenCalledWith({ kind: 'project', projectId: 7 })
  expect(renderOffice).toHaveBeenCalledWith({ sessionId: id, path: request.path, version: 'v1', priority: 'foreground' }, signal)
  await expect(readers.readDocument({ resource: input.resource, bytes: undefined }, signal)).resolves.toEqual(pdf())
  expect(renderOffice).toHaveBeenLastCalledWith({ sessionId: id, path: request.path, priority: 'foreground' }, signal)
  const binary = { ...input, resource: { ...input.resource, path: 'report.pdf' } }
  await expect(readers.readDocument(binary, signal)).resolves.toEqual(pdf())
  await expect(readers.readDocument({ ...binary, bytes: undefined }, signal)).rejects.toThrow('known size')
  await expect(readers.readDocument({ resource: binary.resource, bytes: 10 }, signal)).rejects.toThrow('source version')
  await expect(createWorkspacePreviewReaders(undefined).readDocument(input, signal)).rejects.toThrow('live runtime')
  await expect(createWorkspacePreviewReaders({} as ConnectionHandle).readDocument(input, signal)).rejects.toThrow('unavailable')
  expect(isWorkspaceDocument('report.PDF')).toBe(true)
  expect(isWorkspaceDocument('document.docx')).toBe(true)
  expect(isWorkspaceDocument('notes.md')).toBe(false)
})

it('rejects incomplete PDF data and preserves document and permission failure categories', async () => {
  const renderOffice = vi.fn()
  const readBytes = vi.fn()
  const connection = { api: { workspaceFiles: { renderOffice, readBytes } } } as unknown as ConnectionHandle
  const { readDocument } = createWorkspacePreviewReaders(connection)
  const signal = new AbortController().signal
  const input = { resource: request, version: 'v1', bytes: 10 }
  const binary = { ...input, resource: { ...request, path: 'report.pdf' } }
  readBytes.mockResolvedValueOnce({ result: { ok: false, error: { code: 'access-revoked', message: 'Permission removed' } } })
  await expect(readDocument(binary, signal)).rejects.toMatchObject({ code: 'access-revoked', message: 'Permission removed' })
  readBytes.mockResolvedValueOnce({ result: { ok: true, value: { ...pdf(), eof: false } } })
  await expect(readDocument(binary, signal)).rejects.toThrow('complete file contents')
  renderOffice.mockResolvedValueOnce({ result: { ok: false, error: { code: 'document-error', message: 'Unsupported document', details: { reason: 'invalid-document' } } } })
  await expect(readDocument(input, signal)).rejects.toMatchObject({ code: 'office/invalid-document', message: 'Unsupported document' })
  renderOffice.mockResolvedValueOnce({ result: { ok: false, error: { code: 'access-revoked', message: 'Permission removed' } } })
  await expect(readDocument(input, signal)).rejects.toMatchObject({ code: 'access-revoked', message: 'Permission removed' })
})

it.each(['conversion', 'metadata'] as const)('starts Office conversion alongside metadata when %s completes first', async (first) => {
  const stat = Promise.withResolvers<undefined>()
  const converted = Promise.withResolvers<ReturnType<typeof pdf>>()
  const entered = Promise.withResolvers<undefined>()
  const read = vi.fn<ReadWorkspaceDocument>(() => { entered.resolve(undefined); return converted.promise })
  const h = harness(read, stat.promise)
  try {
    await entered.promise
    expect(read.mock.calls[0]?.[0]).toEqual({ resource: request, bytes: undefined })
    expect(h.resources.source(request).getSnapshot().status).toBe('loading')
    if (first === 'conversion') await act(async () => { converted.resolve(pdf()) })
    else await act(async () => { stat.resolve(undefined) })
    expect(h.queryByTestId('pdf')).toBeNull()
    expect(read).toHaveBeenCalledOnce()
    await act(async () => { stat.resolve(undefined); converted.resolve(pdf()) })
    await waitFor(() => { expect(h.getByTestId('pdf').textContent).toBe('PDF v1') })
    expect(read).toHaveBeenCalledOnce()
  } finally {
    h.unmount()
    await act(async () => { stat.resolve(undefined); converted.resolve(pdf()) })
  }
})

it('uses one pinned read when metadata is already live and never prepares a PDF before metadata', async () => {
  const resource: WorkspacePreviewResource = {
    metadata: { status: 'live', accessDenied: false, value: {
      sessionId: id, path: request.path, type: 'file', version: 'v1', bytes: 10, changed: false,
    } }, reload: async () => true, revoke: vi.fn(),
  }
  const read = vi.fn<ReadWorkspaceDocument>(async ({ version }) => pdf(version))
  const office = render(documentPreview(read, resource))
  await waitFor(() => { expect(office.getByTestId('pdf').textContent).toBe('PDF v1') })
  expect(read).toHaveBeenCalledOnce()
  expect(read.mock.calls[0]?.[0]).toEqual({ resource: request, version: 'v1', bytes: 10 })
  office.unmount()
  const pdfRequest = { ...request, path: 'report.pdf', address: workspaceResourceAddress(id, 'report.pdf') }
  const pdfRead = vi.fn<ReadWorkspaceDocument>(async () => pdf())
  const pending = { ...resource, metadata: { status: 'loading' as const, accessDenied: false } }
  const direct = render(documentPreview(pdfRead, pending, pdfRequest))
  expect(pdfRead).not.toHaveBeenCalled()
  direct.rerender(documentPreview(pdfRead, { ...resource, metadata: { ...resource.metadata,
    value: { ...resource.metadata.value!, path: pdfRequest.path },
  } }, pdfRequest))
  await waitFor(() => { expect(direct.getByTestId('pdf')).toBeTruthy() })
  expect(pdfRead).toHaveBeenCalledOnce()
  expect(pdfRead.mock.calls[0]?.[0]).toEqual({ resource: pdfRequest, version: 'v1', bytes: 10 })
})

it.each(['denied', 'failed', 'retained-loading'] as const)('starts no initial conversion for %s metadata', async (status) => {
  const read = vi.fn<ReadWorkspaceDocument>().mockResolvedValue(pdf())
  const metadata: WorkspacePreviewResource['metadata'] = status === 'retained-loading'
    ? { status: 'loading', accessDenied: false, value: {
      sessionId: id, path: request.path, type: 'file', version: 'v1', bytes: 10, changed: false,
    } }
    : { status: 'failed', accessDenied: status === 'denied', error: { message: 'Metadata unavailable' } }
  const resource: WorkspacePreviewResource = { metadata, reload: async () => true, revoke: vi.fn() }
  const view = render(documentPreview(read, resource))
  expect(read).not.toHaveBeenCalled()
  expect(view.queryByTestId('pdf')).toBeNull()
  if (status === 'retained-loading') {
    view.rerender(documentPreview(read, { ...resource, metadata: { ...metadata, status: 'live' } }))
    await waitFor(() => { expect(view.getByTestId('pdf')).toBeTruthy() })
    expect(read.mock.calls[0]?.[0]).toEqual({ resource: request, version: 'v1', bytes: 10 })
  }
})

it('discards an initial conversion for another version and publishes only a pinned successor', async () => {
  const stat = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const read = vi.fn<ReadWorkspaceDocument>().mockImplementationOnce(async () => { entered.resolve(undefined); return pdf('v1') })
    .mockImplementation(async ({ version }) => pdf(version))
  const h = harness(read, stat.promise)
  try {
    await entered.promise
    act(() => { h.change() })
    expect(h.queryByTestId('pdf')).toBeNull()
    await act(async () => { stat.resolve(undefined) })
    await waitFor(() => { expect(h.getByTestId('pdf').textContent).toBe('PDF v2') })
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls[1]?.[0]).toEqual({ resource: request, version: 'v2', bytes: 10 })
  } finally { stat.resolve(undefined) }
})

it('cancels an adopted conversion when live metadata advances and ignores its late result', async () => {
  const converted = Promise.withResolvers<ReturnType<typeof pdf>>()
  const entered = Promise.withResolvers<AbortSignal>()
  const read = vi.fn<ReadWorkspaceDocument>().mockImplementationOnce((_input, signal) => {
    entered.resolve(signal)
    return converted.promise
  })
    .mockImplementation(async ({ version }) => pdf(version))
  const resource: WorkspacePreviewResource = {
    metadata: { status: 'loading', accessDenied: false }, reload: async () => true, revoke: vi.fn(),
  }
  const live = (version: string): WorkspacePreviewResource => ({ ...resource, metadata: {
    status: 'live', accessDenied: false, value: {
      sessionId: id, path: request.path, type: 'file', version, bytes: 10, changed: false,
    },
  } })
  const view = render(documentPreview(read, resource))
  try {
    const signal = await entered.promise
    await act(async () => { view.rerender(documentPreview(read, live('v1'))) })
    expect(view.queryByTestId('pdf')).toBeNull()
    view.rerender(documentPreview(read, live('v2')))
    await waitFor(() => { expect(view.getByTestId('pdf').textContent).toBe('PDF v2') })
    expect(signal.aborted).toBe(true)
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls[1]?.[0]).toEqual({ resource: request, version: 'v2', bytes: 10 })
    await act(async () => { converted.resolve(pdf('v1')) })
    expect(view.getByTestId('pdf').textContent).toBe('PDF v2')
  } finally { converted.resolve(pdf()); view.unmount() }
})

it('retains an early conversion failure for the live read and retries with a version', async () => {
  const stat = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const read = vi.fn<ReadWorkspaceDocument>().mockImplementationOnce(async () => {
    entered.resolve(undefined)
    throw new WorkspaceResourceError('office/busy', 'Internal diagnostic')
  }).mockResolvedValue(pdf())
  const h = harness(read, stat.promise)
  try {
    await entered.promise
    expect(h.queryByRole('alert')).toBeNull()
    await act(async () => { stat.resolve(undefined) })
    await waitFor(() => { expect(h.getByRole('alert').textContent).toBe(officeEn.busy) })
    expect(read).toHaveBeenCalledOnce()
    fireEvent.click(h.getByRole('button', { name: 'Reload' }))
    await waitFor(() => { expect(h.getByTestId('pdf')).toBeTruthy() })
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls[1]?.[0]).toEqual({ resource: request, version: 'v1', bytes: 10 })
  } finally { stat.resolve(undefined) }
})

it('revokes an early denied conversion without waiting for metadata', async () => {
  const stat = Promise.withResolvers<undefined>()
  const read = vi.fn<ReadWorkspaceDocument>().mockRejectedValue(new WorkspaceResourceError('access-revoked', 'Permission removed'))
  const h = harness(read, stat.promise)
  try {
    await waitFor(() => { expect(h.getByRole('alert').textContent).toBe('Permission removed') })
    expect(h.resources.source(request).getSnapshot().status).toBe('failed')
    expect(h.queryByTestId('pdf')).toBeNull()
    expect(read.mock.calls[0]?.[1].aborted).toBe(true)
    expect(read).toHaveBeenCalledOnce()
  } finally { await act(async () => { stat.resolve(undefined) }) }
})

it('cancels preparation after metadata failure and releases the initial PDF before retry', async () => {
  const stat = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<AbortSignal>()
  const converted = Promise.withResolvers<ReturnType<typeof pdf>>()
  const read = vi.fn<ReadWorkspaceDocument>().mockImplementationOnce((_input, signal) => {
    entered.resolve(signal)
    return converted.promise
  })
    .mockResolvedValue(pdf())
  const h = harness(read, stat.promise)
  try {
    const signal = await entered.promise
    await act(async () => { stat.reject(new Error('Metadata unavailable')) })
    await waitFor(() => { expect(h.getByRole('alert').textContent).toBe('Metadata unavailable') })
    expect(signal.aborted).toBe(true)
    await act(async () => { converted.resolve(pdf('obsolete')) })
    expect(h.queryByTestId('pdf')).toBeNull()
    expect(read).toHaveBeenCalledOnce()
    fireEvent.click(h.getByRole('button', { name: 'Reload' }))
    await waitFor(() => { expect(h.getByTestId('pdf').textContent).toBe('PDF v1') })
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls[1]?.[0].version).toBe('v1')
  } finally { converted.resolve(pdf()); stat.resolve(undefined) }
})

it('cancels an unclaimed conversion on disconnect and reads a pinned version after reconnect', async () => {
  const stat = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<AbortSignal>()
  const converted = Promise.withResolvers<ReturnType<typeof pdf>>()
  const read = vi.fn<ReadWorkspaceDocument>().mockImplementationOnce((_input, signal) => {
    entered.resolve(signal)
    return converted.promise
  })
    .mockResolvedValue(pdf())
  const h = harness(read, stat.promise)
  try {
    const signal = await entered.promise
    act(() => { h.resources.disconnect(request.runtimeTarget) })
    await waitFor(() => { expect(signal.aborted).toBe(true) })
    expect(h.queryByTestId('pdf')).toBeNull()
    expect(read).toHaveBeenCalledOnce()
    act(() => { h.resources.connected(request.runtimeTarget) })
    await waitFor(() => { expect(h.getByTestId('pdf').textContent).toBe('PDF v1') })
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls[1]?.[0].version).toBe('v1')
    await act(async () => { converted.resolve(pdf('obsolete')); stat.resolve(undefined) })
    expect(h.getByTestId('pdf').textContent).toBe('PDF v1')
  } finally { converted.resolve(pdf()); stat.resolve(undefined) }
})

it.each(['resolve', 'reject'] as const)('cancels initial work before metadata on closing and ignores a late %s', async (completion) => {
  const stat = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<AbortSignal>()
  const converted = Promise.withResolvers<ReturnType<typeof pdf>>()
  const read = vi.fn<ReadWorkspaceDocument>((_input, signal) => { entered.resolve(signal); return converted.promise })
  const h = harness(read, stat.promise)
  const signal = await entered.promise
  h.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => {
    if (completion === 'resolve') converted.resolve(pdf())
    else converted.reject(new WorkspaceResourceError('access-revoked', 'Late denial'))
    stat.resolve(undefined)
  })
  expect(h.container.childElementCount).toBe(0)
})

it.each(['request', 'runtime', 'reader'] as const)('releases preparation when its %s changes and ignores its late denial', async (replacement) => {
  const first = Promise.withResolvers<ReturnType<typeof pdf>>()
  const second = Promise.withResolvers<ReturnType<typeof pdf>>()
  const entered = Promise.withResolvers<AbortSignal>()
  const nextEntered = Promise.withResolvers<undefined>()
  const read = vi.fn<ReadWorkspaceDocument>().mockImplementationOnce((_input, signal) => { entered.resolve(signal); return first.promise })
    .mockImplementation(() => { nextEntered.resolve(undefined); return second.promise })
  const nextRead = replacement === 'reader'
    ? vi.fn<ReadWorkspaceDocument>(() => { nextEntered.resolve(undefined); return second.promise }) : read
  const source = replacement === 'request'
    ? { ...request, path: 'next.docx', address: workspaceResourceAddress(id, 'next.docx') }
    : replacement === 'runtime' ? { ...request, runtimeTarget: { kind: 'project' as const, projectId: 7 } } : request
  const resource: WorkspacePreviewResource = {
    metadata: { status: 'loading', accessDenied: false }, reload: async () => true, revoke: vi.fn(),
  }
  const view = render(documentPreview(read, resource))
  try {
    const signal = await entered.promise
    view.rerender(documentPreview(nextRead, resource, source))
    await nextEntered.promise
    expect(signal.aborted).toBe(true)
    await act(async () => { first.reject(new WorkspaceResourceError('access-revoked', 'Old owner denied')) })
    expect(resource.revoke).not.toHaveBeenCalled()
    await act(async () => { second.resolve(pdf('v2')) })
    expect(view.queryByTestId('pdf')).toBeNull()
    view.rerender(documentPreview(nextRead, { ...resource, metadata: { status: 'live', accessDenied: false, value: {
      sessionId: id, path: source.path, type: 'file', version: 'v2', bytes: 30, changed: false,
    } } }, source))
    await waitFor(() => { expect(view.getByTestId('pdf').textContent).toBe('PDF v2') })
    expect(nextRead.mock.calls.at(-1)?.[0].resource).toEqual(source)
  } finally { first.resolve(pdf()); second.resolve(pdf()); view.unmount() }
})
