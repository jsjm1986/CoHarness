/** Office and PDF previews share the existing authorized Workspace resource lifetime. */
import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ComponentType } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { WorkspaceResourceError, isWorkspaceAccessFailure } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceRegistry, WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { FontNoticeProps } from '../office/FontNotice.tsx'
import type {} from '../office/locales.ts'
import type {} from '../pdf/locales.ts'
import css from './Workbench.module.css'

const PdfBody = lazy(async () => ({ default: (await import('../pdf/pdf.tsx')).PdfBody }))

/** One complete authorized result; bytes remain local to this mounted preview. */
export interface WorkspaceDocumentBytes { bytes: string; version: string; missingFonts: string[] }
/** Read or convert an exact revision on its owning runtime. */
export type ReadWorkspaceDocument = (
  request: { resource: WorkspaceResourceOpenRequest; version: string; bytes: number | undefined }, signal: AbortSignal,
) => Promise<WorkspaceDocumentBytes>

/** @param path - workspace-relative filename. @returns whether the PDF renderer handles its content. */
export function isWorkspaceDocument(path: string): boolean { return /\.(?:pdf|docx?|xlsx?|pptx?)$/iu.test(path) }

/** Render a versioned document without adding a second resource subscription or cache.
 * @param props - existing resource, runtime reader, and localized actions.
 * @returns source changes, failures, missing fonts, and the lazy PDF viewer.
 */
export function WorkspaceDocumentPreview({ request, resources, read, pdfT, officeT, fontNotice: FontNotice, close, labels, view }: {
  request: WorkspaceResourceOpenRequest
  resources: WorkspaceResourceRegistry
  read: ReadWorkspaceDocument
  pdfT: PropsLocale<'sidebarPdf'>['t']
  officeT: PropsLocale<'sidebarOffice'>['t']
  fontNotice: ComponentType<FontNoticeProps>
  close: () => void
  view: { page: number }
  labels: { close: string; reload: string; changed: string }
}) {
  const source = useMemo(() => resources.source(request), [resources, request])
  const state = useSyncExternalStore(source.subscribe, source.get, source.get)
  const [result, setResult] = useState<WorkspaceDocumentBytes>()
  const [error, setError] = useState<Error>()
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState(false)
  const denied = isWorkspaceAccessFailure(state.error) || isWorkspaceAccessFailure(error)
  const version = state.value?.changed === true && result !== undefined ? result.version : state.value?.version
  const lifetime = useMemo(() => new AbortController(), [request, denied])
  useEffect(() => () => { lifetime.abort() }, [lifetime])
  useEffect(() => {
    if (denied) { setResult(undefined); return }
    if (version === undefined) return
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, lifetime.signal])
    setPending(true)
    setError(undefined)
    void read({ resource: request, version, bytes: source.get().value?.bytes }, signal).then((value) => {
      if (!signal.aborted) setResult(value)
    }, (cause: unknown) => {
      if (signal.aborted) return
      const failure = cause instanceof Error ? cause : new Error(String(cause))
      setResult(undefined)
      setError(failure)
      if (isWorkspaceAccessFailure(failure)) resources.disconnect(request.runtimeTarget, new WorkspaceResourceError('access-revoked', failure.message))
    }).finally(() => { if (!signal.aborted) setPending(false) })
    return () => { abort.abort() }
  }, [read, request, resources, version, attempt, denied, lifetime, source])
  const data = useMemo(() => result === undefined ? undefined : Uint8Array.from(atob(result.bytes), c => c.charCodeAt(0)), [result])
  const reload = async (): Promise<void> => {
    setError(undefined)
    setResult(undefined)
    await source.reload()
    setAttempt(value => value + 1)
  }
  const failure = error ?? state.error
  const message = failure === undefined ? undefined : describeFailure(failure, officeT)
  return <section aria-label={request.path} className={css.filePreview}>
    <div className={css.filePreviewActions}>
      <Button size="sm" onClick={close}>{labels.close}</Button>
      <Button size="sm" disabled={pending || denied || state.status === 'loading'} onClick={() => { void reload() }}>{labels.reload}</Button>
    </div>
    {message !== undefined && <p role="alert">{message}</p>}
    {!denied && state.value?.changed === true && <p role="status">{labels.changed}</p>}
    {!denied && data !== undefined && result !== undefined && <>
      <FontNotice resourceAddress={request.address} sourceVersion={result.version} fonts={result.missingFonts} t={officeT} />
      <Suspense fallback={<p role="status">{pdfT('loading')}</p>}>
        <PdfBody data={data} signal={lifetime.signal} t={pdfT} view={view} />
      </Suspense>
    </>}
    {!denied && data === undefined && (pending || state.status === 'loading') && <p role="status">{officeT('loading')}</p>}
  </section>
}

function describeFailure(error: Error, t: PropsLocale<'sidebarOffice'>['t']): string {
  const code = error instanceof WorkspaceResourceError ? error.code : undefined
  switch (code) {
    case 'office/unavailable': return t('unavailable')
    case 'office/input-too-large': case 'office/output-too-large': return t('tooLarge')
    case 'office/invalid-document': case 'office/unsupported-format': return t('invalid')
    case 'office/timeout': return t('timeout')
    case 'office/busy': return t('busy')
    case 'office/source-changed': return t('changed')
    case 'office/failed': case 'office/invalid-output': return t('failed')
    default: return error.message
  }
}
