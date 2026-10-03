// @vitest-environment jsdom
/** Spreadsheet bytes follow the existing resource's access lifetime into the lazy Excel body. */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { WorkspaceResourceRegistry, WorkspaceResourceError, workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { WorkspaceExcelPreview, isWorkspaceSpreadsheet } from '../src/client/components/WorkspaceExcelPreview.tsx'
import type { ReadWorkspaceFileData } from '../src/client/html/read-relative.ts'
import { Config } from '../src/config.ts'
import { en } from '../src/client/excel/locales.ts'
import { PreviewResourceBinding } from './workspace-preview-resource.fixture.tsx'

vi.mock('../src/client/excel/LazyExcelBody.tsx', () => ({
  LazyExcelBody: ({ data, path }: { data: Uint8Array; path: string }) =>
    <pre data-testid="excel">{`${path}:${new TextDecoder().decode(data)}`}</pre>,
}))
afterEach(cleanup)
const id = 'excel-session' as SessionId
const request: WorkspaceResourceOpenRequest = { sessionId: id, runtimeTarget: { kind: 'base' }, path: 'budget.xlsx', address: workspaceResourceAddress(id, 'budget.xlsx') }
function harness(read: ReadWorkspaceFileData, path = request.path) {
  const target = { ...request, path, address: workspaceResourceAddress(id, path) }
  const resources = new WorkspaceResourceRegistry()
  let version = 'v1'
  resources.register(target.runtimeTarget, {
    stat: async () => ({ sessionId: id, path, type: 'file', version, bytes: 10, changed: false }),
  }, 5)
  const close = vi.fn()
  const view = render(<PreviewResourceBinding resources={resources} request={target}>{resource =>
    <WorkspaceExcelPreview request={target} resource={resource} read={read}
      excelT={makeTranslate(en)} limits={Config({}).excel} close={close}
      labels={{ close: 'Close', reload: 'Reload', changed: 'File changed' }} />
  }</PreviewResourceBinding>)
  return { ...view, resources, close, change() {
    version = 'v2'
    resources.handleChange(target.runtimeTarget, { sessionId: id, path, version })
  } }
}

it.each(['book.xlsx', 'legacy.xls', 'table.CSV', 'dir/rows.tsv'])('admits %s to the spreadsheet path', (path) => {
  expect(isWorkspaceSpreadsheet(path)).toBe(true)
})

it.each(['report.pdf', 'notes.docx', 'slides.pptx', 'guide.md', 'archive.xlsm', 'data.csv.bak'])('leaves %s to other previews', (path) => {
  expect(isWorkspaceSpreadsheet(path)).toBe(false)
})

it('reads complete authorized bytes and hands them to the spreadsheet body', async () => {
  const read = vi.fn<ReadWorkspaceFileData>(async () => ({ bytes: btoa('xlsx v1'), version: 'v1' }))
  const h = harness(read)
  await waitFor(() => { expect(h.getByTestId('excel').textContent).toBe('budget.xlsx:xlsx v1') })
  expect(read.mock.calls[0]![0].resource).toMatchObject({ path: 'budget.xlsx' })
  expect(read.mock.calls[0]![1]).toBeInstanceOf(AbortSignal)
})

it('retains the displayed revision until explicit reload, then clears it on revocation', async () => {
  const read = vi.fn<ReadWorkspaceFileData>(async ({ version }) => ({ bytes: btoa(`bytes ${version}`), version: version ?? 'v1' }))
  const h = harness(read)
  await waitFor(() => { expect(h.getByTestId('excel').textContent).toBe('budget.xlsx:bytes v1') })
  act(() => { h.change() })
  expect(h.getByText('File changed')).toBeTruthy()
  expect(read).toHaveBeenCalledTimes(1)
  fireEvent.click(h.getByRole('button', { name: 'Reload' }))
  await waitFor(() => { expect(h.getByTestId('excel').textContent).toBe('budget.xlsx:bytes v2') })
  act(() => { h.resources.disconnect(request.runtimeTarget, new WorkspaceResourceError('access-revoked', 'Access revoked')) })
  expect(h.queryByTestId('excel')).toBeNull()
  expect(read.mock.calls.at(-1)![1].aborted).toBe(true)
  expect(h.getByRole('button', { name: 'Reload' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(h.getByRole('button', { name: 'Close' }))
  expect(h.close).toHaveBeenCalledOnce()
})

it('reports a failed byte read without contacting the renderer', async () => {
  const read = vi.fn<ReadWorkspaceFileData>(async () => { throw new WorkspaceResourceError('file/too-large', 'File exceeds the limit') })
  const h = harness(read)
  await waitFor(() => { expect(h.getByRole('alert').textContent).toBe('File exceeds the limit') })
  expect(h.queryByTestId('excel')).toBeNull()
})
