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
import { createWorkspacePreviewReaders } from '../src/client/preview-readers.ts'
import { en as pdfEn } from '../src/client/pdf/locales.ts'
import { en as officeEn } from '../src/client/office/locales.ts'
import { FontNotice } from '../src/client/office/FontNotice.tsx'

vi.mock('../src/client/pdf/pdf.tsx', () => ({ PdfBody: ({ data }: { data: Uint8Array }) => <pre data-testid="pdf">{new TextDecoder().decode(data)}</pre> }))
afterEach(cleanup)
const id = 'document-session' as SessionId
const request: WorkspaceResourceOpenRequest = { sessionId: id, runtimeTarget: { kind: 'base' }, path: 'report.docx', address: workspaceResourceAddress(id, 'report.docx') }
const pdf = (version = 'v1') => ({ bytes: btoa(`PDF ${version}`), version, missingFonts: [] })
function harness(read: ReadWorkspaceDocument) {
  const resources = new WorkspaceResourceRegistry()
  let version = 'v1'
  resources.register(request.runtimeTarget, {
    stat: async () => ({ sessionId: id, path: request.path, type: 'file', version, bytes: 10, changed: false }),
  }, 5)
  const close = vi.fn()
  const view = render(<WorkspaceDocumentPreview request={request} resources={resources} read={read}
    pdfT={makeTranslate(pdfEn)} officeT={makeTranslate(officeEn)} fontNotice={FontNotice} close={close} view={{ page: 1 }}
    labels={{ close: 'Close', reload: 'Reload', changed: 'File changed' }} />)
  return { ...view, resources, close, change() {
    version = 'v2'
    resources.handleChange(request.runtimeTarget, { sessionId: id, path: request.path, version })
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
  expect(h.resources.source(request).get().error?.message).toBe('Permission removed')
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
  const binary = { ...input, resource: { ...input.resource, path: 'report.pdf' } }
  await expect(readers.readDocument(binary, signal)).resolves.toEqual(pdf())
  await expect(readers.readDocument({ ...binary, bytes: undefined }, signal)).rejects.toThrow('known size')
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
