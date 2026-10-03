// @vitest-environment jsdom
/** Explicit reload across preview bodies: a held stat cannot authorize an old-version content read. */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { WorkspaceResourceError, WorkspaceResourceRegistry, workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { WorkspaceFilePreview } from '../src/client/components/WorkspaceFilePreview.tsx'
import type { ReadWorkspaceBytesPreview } from '../src/client/components/WorkspaceFilePreview.tsx'
import { WorkspaceDocumentPreview } from '../src/client/components/WorkspaceDocumentPreview.tsx'
import type { ReadWorkspaceDocument } from '../src/client/components/WorkspaceDocumentPreview.tsx'
import { WorkspaceMarkdownPreview } from '../src/client/components/WorkspaceMarkdownPreview.tsx'
import { WorkspaceHtmlPreview } from '../src/client/components/WorkspaceHtmlPreview.tsx'
import { WorkspaceExcelPreview } from '../src/client/components/WorkspaceExcelPreview.tsx'
import type { ReadWorkspaceFileData } from '../src/client/html/read-relative.ts'
import { Config } from '../src/config.ts'
import { en as pdfEn } from '../src/client/pdf/locales.ts'
import { en as officeEn } from '../src/client/office/locales.ts'
import { en as markdownEn } from '../src/client/markdown/locales.ts'
import { en as htmlEn } from '../src/client/html/locales.ts'
import { en as excelEn } from '../src/client/excel/locales.ts'
import { PreviewResourceBinding } from './workspace-preview-resource.fixture.tsx'

vi.mock('../src/client/pdf/pdf.tsx', () => ({ PdfBody: ({ data }: { data: Uint8Array }) => <pre data-testid="pdf">{new TextDecoder().decode(data)}</pre> }))
vi.mock('../src/client/excel/LazyExcelBody.tsx', () => ({
  LazyExcelBody: ({ data, path }: { data: Uint8Array; path: string }) =>
    <pre data-testid="excel">{`${path}:${new TextDecoder().decode(data)}`}</pre>,
}))

afterEach(cleanup)
const id = 'reload-session' as SessionId
const fileRequest = (path: string): WorkspaceResourceOpenRequest => ({
  sessionId: id, runtimeTarget: { kind: 'base' }, path, address: workspaceResourceAddress(id, path),
})
const labels = {
  close: 'Close', reload: 'Reload', previous: 'Previous', next: 'Next', loading: 'Loading',
  changed: 'Changed; reload', binary: 'Binary (Base64)',
}
const htmlT = (key: string): string => (htmlEn as Record<string, string>)[key] ?? key

/** A resource whose next stat resolves only when the test releases it. */
function heldResource(request: WorkspaceResourceOpenRequest) {
  const resources = new WorkspaceResourceRegistry()
  const stat = Promise.withResolvers<{ sessionId: SessionId; path: string; type: 'file'; version: string; bytes: number; changed: boolean }>()
  const statEntered = Promise.withResolvers<undefined>()
  let snapshot: { version: string; bytes: number } = { version: 'v1', bytes: 10 }
  let held = false
  resources.register(request.runtimeTarget, {
    stat: async () => {
      if (held) {
        statEntered.resolve(undefined)
        return stat.promise
      }
      return { sessionId: id, path: request.path, type: 'file', ...snapshot, changed: false }
    },
  }, 5)
  return {
    resources,
    /** Mark the source changed via observation only; the next stat stays held. */
    holdChange(next: { version: string; bytes: number }) {
      held = true
      snapshot = next
      resources.handleChange(request.runtimeTarget, { sessionId: id, path: request.path, version: next.version })
    },
    stat,
    statEntered,
    snapshotOf() { return resources.source(request).getSnapshot() },
  }
}

describe('explicit reload under a held metadata stat', () => {
  it('keeps the displayed document and reads once for the new revision', async () => {
    const request = fileRequest('report.docx')
    const h = heldResource(request)
    const calls: { version: string; bytes: number | undefined }[] = []
    const read = vi.fn<ReadWorkspaceDocument>(async ({ version, bytes }) => {
      calls.push({ version, bytes })
      return { bytes: btoa(`PDF ${version}`), version, missingFonts: [] }
    })
    const view = render(<PreviewResourceBinding resources={h.resources} request={request}>{resource =>
      <WorkspaceDocumentPreview request={request} resource={resource} read={read}
        pdfT={makeTranslate(pdfEn)} officeT={makeTranslate(officeEn)} close={vi.fn()} view={{ page: 1 }}
        labels={{ close: 'Close', reload: 'Reload', changed: 'File changed' }} />
    }</PreviewResourceBinding>)
    try {
      await waitFor(() => { expect(view.getByTestId('pdf').textContent).toBe('PDF v1') })
      expect(calls).toEqual([{ version: 'v1', bytes: 10 }])
      act(() => { h.holdChange({ version: 'v2', bytes: 30 }) })
      await waitFor(() => { expect(view.getByText('File changed')).toBeTruthy() })
      fireEvent.click(view.getByRole('button', { name: 'Reload' }))
      await h.statEntered.promise
      await waitFor(() => {
        expect(h.snapshotOf()).toMatchObject({ status: 'loading', value: { version: 'v1', bytes: 10, changed: true } })
      })
      await Promise.resolve()
      expect(read).toHaveBeenCalledTimes(1)
      act(() => { h.stat.resolve({ sessionId: id, path: request.path, type: 'file', version: 'v2', bytes: 30, changed: false }) })
      await waitFor(() => { expect(view.getByTestId('pdf').textContent).toBe('PDF v2') })
      expect(calls).toEqual([{ version: 'v1', bytes: 10 }, { version: 'v2', bytes: 30 }])
      expect(view.queryByText('File changed')).toBeNull()
    } finally {
      h.stat.resolve({ sessionId: id, path: request.path, type: 'file', version: 'v2', bytes: 30, changed: false })
      await act(async () => { view.unmount() })
    }
  })

  it('keeps the displayed page and reads once for the new revision', async () => {
    const request = fileRequest('notes.txt')
    const h = heldResource(request)
    const read = vi.fn(async ({ offset, version }: { offset: number; version: string }) => ({
      path: request.path, offset, limit: 2, text: `${version}:${offset}`, eof: true, version,
    }))
    const view = render(<PreviewResourceBinding resources={h.resources} request={request}>{resource =>
      <WorkspaceFilePreview request={request} read={read} resource={resource} close={vi.fn()} labels={labels} />
    }</PreviewResourceBinding>)
    try {
      await waitFor(() => { expect(view.getByText('v1:1')).toBeTruthy() })
      act(() => { h.holdChange({ version: 'v2', bytes: 30 }) })
      await waitFor(() => { expect(view.getByText('Changed; reload')).toBeTruthy() })
      fireEvent.click(view.getByRole('button', { name: 'Reload' }))
      await h.statEntered.promise
      await waitFor(() => {
        expect(h.snapshotOf()).toMatchObject({ status: 'loading', value: { version: 'v1', bytes: 10, changed: true } })
      })
      await Promise.resolve()
      expect(read).toHaveBeenCalledTimes(1)
      act(() => { h.stat.resolve({ sessionId: id, path: request.path, type: 'file', version: 'v2', bytes: 30, changed: false }) })
      await waitFor(() => { expect(view.getByText('v2:1')).toBeTruthy() })
      expect(read).toHaveBeenCalledTimes(2)
      expect(read.mock.calls[1]![0]).toMatchObject({ version: 'v2' })
    } finally {
      h.stat.resolve({ sessionId: id, path: request.path, type: 'file', version: 'v2', bytes: 30, changed: false })
      await act(async () => { view.unmount() })
    }
  })

  it('keeps the displayed Base64 payload and re-reads the new size', async () => {
    const request = fileRequest('assets/screenshot.png')
    const h = heldResource(request)
    const read = vi.fn(async () => { throw new WorkspaceResourceError('workspace-file/not-text', 'binary') })
    const reads: { version: string; length: number }[] = []
    const readBytes = vi.fn<ReadWorkspaceBytesPreview>(async ({ version, length }) => {
      reads.push({ version, length })
      return { path: request.path, offset: 0, bytes: 'AAEC', eof: true, version }
    })
    const view = render(<PreviewResourceBinding resources={h.resources} request={request}>{resource =>
      <WorkspaceFilePreview request={request} read={read} readBytes={readBytes} resource={resource} close={vi.fn()} labels={labels} />
    }</PreviewResourceBinding>)
    try {
      await waitFor(() => {
        expect(view.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAEC')
      })
      expect(reads).toEqual([{ version: 'v1', length: 10 }])
      act(() => { h.holdChange({ version: 'v2', bytes: 30 }) })
      await waitFor(() => { expect(view.getByText('Changed; reload')).toBeTruthy() })
      fireEvent.click(view.getByRole('button', { name: 'Reload' }))
      await h.statEntered.promise
      await Promise.resolve()
      expect(read).toHaveBeenCalledTimes(1)
      expect(readBytes).toHaveBeenCalledTimes(1)
      act(() => { h.stat.resolve({ sessionId: id, path: request.path, type: 'file', version: 'v2', bytes: 30, changed: false }) })
      await waitFor(() => { expect(reads).toHaveLength(2) })
      expect(reads[1]).toEqual({ version: 'v2', length: 30 })
      expect(view.queryByText('Changed; reload')).toBeNull()
    } finally {
      h.stat.resolve({ sessionId: id, path: request.path, type: 'file', version: 'v2', bytes: 30, changed: false })
      await act(async () => { view.unmount() })
    }
  })

  it('keeps the rendered Markdown and reads once for the new revision', async () => {
    const request = fileRequest('notes.md')
    const h = heldResource(request)
    const versions: string[] = []
    const read = vi.fn(async ({ offset, version }: { offset: number; version: string }) => {
      versions.push(version)
      return { path: request.path, offset, limit: 5, text: `# ${version}`, eof: true, version }
    })
    const view = render(<PreviewResourceBinding resources={h.resources} request={request}>{resource =>
      <WorkspaceMarkdownPreview request={request} resource={resource} read={read}
        markdownT={makeTranslate(markdownEn)} close={vi.fn()}
        labels={{ close: 'Close', reload: 'Reload', loading: 'Reading', changed: 'File changed' }} />
    }</PreviewResourceBinding>)
    try {
      await waitFor(() => { expect(view.getByRole('heading').textContent).toBe('v1') })
      act(() => { h.holdChange({ version: 'v2', bytes: 30 }) })
      await waitFor(() => { expect(view.getByText('File changed')).toBeTruthy() })
      fireEvent.click(view.getByRole('button', { name: 'Reload' }))
      await h.statEntered.promise
      await Promise.resolve()
      expect(read).toHaveBeenCalledTimes(1)
      act(() => { h.stat.resolve({ sessionId: id, path: request.path, type: 'file', version: 'v2', bytes: 30, changed: false }) })
      await waitFor(() => { expect(view.getByRole('heading').textContent).toBe('v2') })
      expect(versions).toEqual(['v1', 'v2'])
    } finally {
      h.stat.resolve({ sessionId: id, path: request.path, type: 'file', version: 'v2', bytes: 30, changed: false })
      await act(async () => { view.unmount() })
    }
  })

  it('keeps the packaged frame and reads once for the new revision', async () => {
    const request = fileRequest('index.html')
    const h = heldResource(request)
    const calls: { version: string }[] = []
    const read = vi.fn<ReadWorkspaceFileData>(async ({ version }) => {
      calls.push({ version: version ?? 'none' })
      return { bytes: btoa(`<title>${version}</title>`), version: version ?? 'v1' }
    })
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    onTestFinished(() => {
      if (createDescriptor === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
      else Object.defineProperty(URL, 'createObjectURL', createDescriptor)
      if (revokeDescriptor === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL')
      else Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor)
    })
    let created = 0
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => `blob:frame-${++created}` })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })
    const renderHtml = vi.fn(async () => '<title>frame</title>')
    const view = render(<PreviewResourceBinding resources={h.resources} request={request}>{resource =>
      <WorkspaceHtmlPreview request={request} resource={resource} read={read} renderHtml={renderHtml}
        htmlT={htmlT} close={vi.fn()} labels={{ close: 'Close', reload: 'Reload', changed: 'File changed' }} />
    }</PreviewResourceBinding>)
    try {
      await waitFor(() => { expect(view.container.querySelector('iframe')?.getAttribute('src')).toBe('blob:frame-1') })
      expect(calls).toEqual([{ version: 'v1' }])
      act(() => { h.holdChange({ version: 'v2', bytes: 30 }) })
      await waitFor(() => { expect(view.getByText('File changed')).toBeTruthy() })
      fireEvent.click(view.getByRole('button', { name: 'Reload' }))
      await h.statEntered.promise
      await Promise.resolve()
      expect(read).toHaveBeenCalledTimes(1)
      act(() => { h.stat.resolve({ sessionId: id, path: request.path, type: 'file', version: 'v2', bytes: 30, changed: false }) })
      await waitFor(() => { expect(read).toHaveBeenCalledTimes(2) })
      expect(calls[1]).toEqual({ version: 'v2' })
    } finally {
      h.stat.resolve({ sessionId: id, path: request.path, type: 'file', version: 'v2', bytes: 30, changed: false })
      await act(async () => { view.unmount() })
    }
  })

  it('keeps the spreadsheet body and reads once for the new revision', async () => {
    const request = fileRequest('budget.xlsx')
    const h = heldResource(request)
    const calls: { version: string }[] = []
    const read = vi.fn<ReadWorkspaceFileData>(async ({ version }) => {
      calls.push({ version: version ?? 'none' })
      return { bytes: btoa(`xlsx ${version}`), version: version ?? 'v1' }
    })
    const view = render(<PreviewResourceBinding resources={h.resources} request={request}>{resource =>
      <WorkspaceExcelPreview request={request} resource={resource} read={read}
        excelT={makeTranslate(excelEn)} limits={Config({}).excel} close={vi.fn()}
        labels={{ close: 'Close', reload: 'Reload', changed: 'File changed' }} />
    }</PreviewResourceBinding>)
    try {
      await waitFor(() => { expect(view.getByTestId('excel').textContent).toBe('budget.xlsx:xlsx v1') })
      expect(calls).toEqual([{ version: 'v1' }])
      act(() => { h.holdChange({ version: 'v2', bytes: 30 }) })
      await waitFor(() => { expect(view.getByText('File changed')).toBeTruthy() })
      fireEvent.click(view.getByRole('button', { name: 'Reload' }))
      await h.statEntered.promise
      await Promise.resolve()
      expect(read).toHaveBeenCalledTimes(1)
      act(() => { h.stat.resolve({ sessionId: id, path: request.path, type: 'file', version: 'v2', bytes: 30, changed: false }) })
      await waitFor(() => { expect(view.getByTestId('excel').textContent).toBe('budget.xlsx:xlsx v2') })
      expect(calls).toEqual([{ version: 'v1' }, { version: 'v2' }])
    } finally {
      h.stat.resolve({ sessionId: id, path: request.path, type: 'file', version: 'v2', bytes: 30, changed: false })
      await act(async () => { view.unmount() })
    }
  })
})
