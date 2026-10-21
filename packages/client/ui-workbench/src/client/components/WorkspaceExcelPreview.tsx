/** Browser-parsed spreadsheet preview over the existing authorized Workspace resource lifetime. */
import { lazy, Suspense, useMemo } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import { workspaceFileBytes } from '../contract/html/read-relative.ts'
import type { ReadWorkspaceFileData } from '../contract/html/read-relative.ts'
import type { ExcelLimits } from '../excel/model.ts'
import type {} from '../excel/locales.ts'
import { useWorkspacePreviewRead } from '../contract/preview/use-preview-read.ts'
import type { WorkspacePreviewResource } from '../contract/preview/use-preview-read.ts'
import { WorkspacePreviewChrome } from './WorkspacePreviewChrome.tsx'
import css from './Workbench.module.css'

const LazyExcelBody = lazy(async () => ({ default: (await import('../excel/LazyExcelBody.tsx')).LazyExcelBody }))

/** @param path - workspace-relative filename. @returns whether the browser spreadsheet renderer handles its content. */
export function isWorkspaceSpreadsheet(path: string): boolean { return /\.(?:xlsx?|csv|tsv)$/iu.test(path) }

/** Render a versioned workbook without adding a second resource subscription or cache.
 * @param props - preview metadata/callbacks, authorized complete-file reader, parser limits, and localized actions.
 * @returns source changes, failures, and the lazy spreadsheet workbook.
 */
export function WorkspaceExcelPreview({ request, resource, read, excelT, limits, close, labels }: {
  request: WorkspaceResourceOpenRequest
  resource: WorkspacePreviewResource
  read: ReadWorkspaceFileData
  excelT: PropsLocale<'sidebarExcel'>['t']
  limits: ExcelLimits
  close: () => void
  labels: { close: string; reload: string; changed: string }
}) {
  const input = useMemo(() => {
    const version = resource.metadata.value?.version
    return version === undefined ? undefined : { version, maxBytes: limits.maxBytes }
  }, [resource.metadata.value?.version, limits.maxBytes])
  const readFile = useMemo(() => (next: { version: string; maxBytes: number }, signal: AbortSignal) =>
    read({ resource: request, version: next.version, maxBytes: next.maxBytes }, signal), [read, request])
  const state = useWorkspacePreviewRead({ request, resource, input, read: readFile })
  const { result, error, denied } = state
  const data = useMemo(() => result === undefined ? undefined : workspaceFileBytes(result), [result])
  const failure = error ?? resource.metadata.error
  const message = failure === undefined
    ? undefined
    : (failure instanceof Error ? (failure as { code?: unknown }).code : failure.code) === 'workspace-file/too-large'
      ? excelT('tooLarge')
      : failure.message
  const loading = <p className={css.previewStatus} role="status">{excelT('loading')}</p>
  return <WorkspacePreviewChrome request={request} resource={resource} state={state}
    className={css.filePreview} message={message} hasContent={data !== undefined}
    close={close} labels={{ ...labels, loading: excelT('loading') }}>
    {!denied && data !== undefined && (
      <Suspense fallback={loading}>
        <LazyExcelBody data={data} path={request.path} limits={limits} t={excelT} />
      </Suspense>
    )}
  </WorkspacePreviewChrome>
}
