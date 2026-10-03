/** Browser-parsed spreadsheet preview over the existing authorized Workspace resource lifetime. */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { isWorkspaceAccessFailure } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import { workspaceFileBytes } from '../html/read-relative.ts'
import type { ReadWorkspaceFileData, WorkspaceFileData } from '../html/read-relative.ts'
import type { ExcelLimits } from '../excel/model.ts'
import type {} from '../excel/locales.ts'
import type { WorkspacePreviewResource } from './WorkspaceFileTab.tsx'
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
  const { metadata, revoke } = resource
  const [result, setResult] = useState<WorkspaceFileData>()
  const [error, setError] = useState<Error>()
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState(false)
  const [reloading, setReloading] = useState(false)
  const denied = metadata.accessDenied || isWorkspaceAccessFailure(error)
  const version = metadata.value?.changed === true && result !== undefined ? result.version : metadata.value?.version
  const lifetime = useMemo(() => new AbortController(), [request, denied])
  useEffect(() => () => { lifetime.abort() }, [lifetime])
  useEffect(() => {
    if (denied) { setResult(undefined); return }
    // The user's metadata reload owns this transition: while its stat is open,
    // the still-old snapshot cannot authorize a new content read.
    if (reloading) return
    if (version === undefined) return
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, lifetime.signal])
    setPending(true)
    setError(undefined)
    void read({ resource: request, version, maxBytes: limits.maxBytes }, signal).then((value) => {
      if (!signal.aborted) setResult(value)
    }, (cause: unknown) => {
      if (signal.aborted) return
      const failure = cause instanceof Error ? cause : new Error(String(cause))
      setResult(undefined)
      setError(failure)
      if (isWorkspaceAccessFailure(failure)) revoke(failure.message)
    }).finally(() => { if (!signal.aborted) setPending(false) })
    return () => { abort.abort() }
  }, [read, request, revoke, version, attempt, denied, lifetime, limits.maxBytes, reloading])
  const data = useMemo(() => result === undefined ? undefined : workspaceFileBytes(result), [result])
  const reload = async (): Promise<void> => {
    setReloading(true)
    try {
      await resource.reload()
      setError(undefined)
      setResult(undefined)
      setAttempt(value => value + 1)
    } finally {
      setReloading(false)
    }
  }
  const failure = error ?? metadata.error
  const message = failure === undefined
    ? undefined
    : (failure instanceof Error ? (failure as { code?: unknown }).code : failure.code) === 'workspace-file/too-large'
      ? excelT('tooLarge')
      : failure.message
  const loading = <p className={css.previewStatus} role="status">{excelT('loading')}</p>
  return <section aria-label={request.path} className={css.filePreview}>
    <div className={css.filePreviewActions}>
      <Button size="sm" onClick={close}>{labels.close}</Button>
      <Button size="sm" disabled={pending || denied || reloading || metadata.status === 'loading'} onClick={() => { void reload() }}>{labels.reload}</Button>
    </div>
    {message !== undefined && <p role="alert">{message}</p>}
    {!denied && metadata.value?.changed === true && <p role="status">{labels.changed}</p>}
    {!denied && data !== undefined && (
      <Suspense fallback={loading}>
        <LazyExcelBody data={data} path={request.path} limits={limits} t={excelT} />
      </Suspense>
    )}
    {!denied && data === undefined && (pending || metadata.status === 'loading') && <p role="status">{excelT('loading')}</p>}
  </section>
}
