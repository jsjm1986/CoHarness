// @vitest-environment jsdom
/** Viewer downloads and authorized file reads have independent lifetimes. */
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { previewRecoveryLabels } from './workspace-preview-resource.fixture.tsx'
import { Component, Suspense } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import { WorkspaceDocumentPreview } from '../src/client/components/WorkspaceDocumentPreview.tsx'
import type { WorkspaceDocumentBytes } from '../src/client/components/WorkspaceDocumentPreview.tsx'
import { WorkspaceExcelPreview } from '../src/client/components/WorkspaceExcelPreview.tsx'
import type { WorkspacePreviewResource } from '../src/client/contract/preview/use-preview-read.ts'
import { usePreviewViewer } from '../src/client/contract/preview/use-preview-viewer.ts'
import { Config } from '../src/config.ts'
import { en as excelEn } from '../src/client/excel/locales.ts'
import { en as officeEn } from '../src/client/office/locales.ts'
import { en as pdfEn } from '../src/client/pdf/locales.ts'

const imports = vi.hoisted(() => ({
  pdf: { started: vi.fn(), pending: Promise.withResolvers<undefined>() },
  excel: { started: vi.fn(), pending: Promise.withResolvers<undefined>() },
}))
vi.mock('../src/client/pdf/pdf.tsx', async () => {
  imports.pdf.started()
  await imports.pdf.pending.promise
  return { PdfBody: () => <div data-testid="pdf-viewer" /> }
})
vi.mock('../src/client/excel/excel.tsx', async () => {
  imports.excel.started()
  await imports.excel.pending.promise
  return { ExcelBody: () => <div data-testid="excel-viewer" /> }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('downloads only the selected viewer before metadata and discards late imports after closing', async () => {
  const sessionId = 'viewer-session' as SessionId
  const request = (path: string): WorkspaceResourceOpenRequest => ({ sessionId, path, address: workspaceResourceAddress(sessionId, path), runtimeTarget: { kind: 'base' } })
  const resource: WorkspacePreviewResource = {
    metadata: { status: 'live', accessDenied: false, value: { sessionId, path: 'report.docx', version: 'v1', bytes: 12, changed: false, type: 'file' } },
    reload: async () => true, revoke: vi.fn(),
  }
  const documentBytes = Promise.withResolvers<WorkspaceDocumentBytes>()
  const excelBytes = Promise.withResolvers<{ bytes: string; version: string }>()
  const readDocument = vi.fn(() => documentBytes.promise)
  const readExcel = vi.fn(() => excelBytes.promise)
  const labels = { close: 'Close', reload: 'Reload', reconnecting: 'Reload · reconnecting', ...previewRecoveryLabels, changed: 'Changed' }
  const pendingResource: WorkspacePreviewResource = { ...resource, metadata: { status: 'loading', accessDenied: false } }
  const documentRequest = request('report.docx')
  const excelRequest = request('budget.xlsx')
  const pdf = render(<WorkspaceDocumentPreview request={documentRequest} resource={pendingResource} read={readDocument}
    pdfT={makeTranslate(pdfEn)} officeT={makeTranslate(officeEn)} close={vi.fn()} view={{ page: 1 }} labels={labels} />)
  try {
    await waitFor(() => { expect(imports.pdf.started).toHaveBeenCalledOnce() })
    expect(readDocument).not.toHaveBeenCalled()
    expect(imports.excel.started).not.toHaveBeenCalled()
    const excel = render(<WorkspaceExcelPreview request={excelRequest} resource={pendingResource} read={readExcel}
      excelT={makeTranslate(excelEn)} limits={Config({}).excel} close={vi.fn()} labels={labels} />)
    await waitFor(() => { expect(imports.excel.started).toHaveBeenCalledOnce() })
    expect(readExcel).not.toHaveBeenCalled()
    pdf.rerender(<WorkspaceDocumentPreview request={documentRequest} resource={resource} read={readDocument}
      pdfT={makeTranslate(pdfEn)} officeT={makeTranslate(officeEn)} close={vi.fn()} view={{ page: 1 }} labels={labels} />)
    excel.rerender(<WorkspaceExcelPreview request={excelRequest} resource={resource} read={readExcel}
      excelT={makeTranslate(excelEn)} limits={Config({}).excel} close={vi.fn()} labels={labels} />)
    await waitFor(() => { expect(readDocument).toHaveBeenCalledOnce() })
    await waitFor(() => { expect(readExcel).toHaveBeenCalledOnce() })
    expect(pdf.queryByTestId('pdf-viewer')).toBeNull()
    expect(excel.queryByTestId('excel-viewer')).toBeNull()
    pdf.unmount()
    excel.unmount()
    await act(async () => {
      documentBytes.resolve({ bytes: btoa('pdf'), version: 'v1', missingFonts: [] })
      excelBytes.resolve({ bytes: btoa('xlsx'), version: 'v1' })
      imports.pdf.pending.resolve(undefined)
      imports.excel.pending.resolve(undefined)
      await vi.dynamicImportSettled()
    })
    expect(pdf.container.childElementCount).toBe(0)
    expect(excel.container.childElementCount).toBe(0)
  } finally {
    cleanup()
    documentBytes.resolve({ bytes: btoa('pdf'), version: 'v1', missingFonts: [] })
    excelBytes.resolve({ bytes: btoa('xlsx'), version: 'v1' })
    imports.pdf.pending.resolve(undefined)
    imports.excel.pending.resolve(undefined)
    await vi.dynamicImportSettled()
  }
})

type Body = { default: ComponentType<{ label: string }> }

function Viewer({ load, ready, show }: { load: () => Promise<Body>; ready: boolean; show: boolean }) {
  const Body = usePreviewViewer(load, ready)
  return <Suspense fallback={<p>Downloading viewer</p>}>{show && <Body label="Ready" />}</Suspense>
}

class ViewerFailure extends Component<{ children: ReactNode }, { failure: Error | undefined }> {
  override state: { failure: Error | undefined } = { failure: undefined }
  static getDerivedStateFromError(failure: Error) { return { failure } }
  override render() {
    return this.state.failure === undefined ? this.props.children : <p role="alert">{this.state.failure.message}</p>
  }
}

it('observes preload rejection without mounting and preserves the same failure for the render boundary', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const pending = Promise.withResolvers<Body>()
  const load = vi.fn(() => pending.promise)
  const view = render(<ViewerFailure><Viewer load={load} ready={false} show={false} /></ViewerFailure>)
  expect(load).not.toHaveBeenCalled()
  view.rerender(<ViewerFailure><Viewer load={load} ready show={false} /></ViewerFailure>)
  expect(load).toHaveBeenCalledOnce()
  await act(async () => { pending.reject(new Error('viewer unavailable')) })
  expect(view.queryByRole('alert')).toBeNull()
  view.rerender(<ViewerFailure><Viewer load={load} ready show /></ViewerFailure>)
  await waitFor(() => { expect(view.getByRole('alert').textContent).toBe('viewer unavailable') })
  expect(load).toHaveBeenCalledOnce()
})

it('reuses an import across readiness changes without mounting its viewer before successful content', async () => {
  const pending = Promise.withResolvers<Body>()
  const body = vi.fn(({ label }: { label: string }) => <p>{label}</p>)
  const load = vi.fn(() => pending.promise)
  const view = render(<Viewer load={load} ready show={false} />)
  view.rerender(<Viewer load={load} ready={false} show={false} />)
  await act(async () => { pending.resolve({ default: body }) })
  expect(body).not.toHaveBeenCalled()
  view.rerender(<Viewer load={load} ready show />)
  await waitFor(() => { expect(view.getByText('Ready')).toBeTruthy() })
  expect(load).toHaveBeenCalledOnce()
})
