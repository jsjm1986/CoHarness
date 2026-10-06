/** Office and PDF previews share the existing authorized Workspace resource lifetime. */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { isWorkspaceAccessFailure } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import { FontNotice } from '../office/FontNotice.tsx'
import type {} from '../office/locales.ts'
import type {} from '../pdf/locales.ts'
import type { WorkspacePreviewResource } from './WorkspaceFileTab.tsx'
import css from './Workbench.module.css'

const PdfBody = lazy(async () => ({ default: (await import('../pdf/pdf.tsx')).PdfBody }))

/** One complete authorized result; bytes remain local to this mounted preview. */
export interface WorkspaceDocumentBytes { bytes: string; version: string; missingFonts: string[] }
/** Read or convert an exact revision on its owning runtime. */
export type ReadWorkspaceDocument = (
  request: { resource: WorkspaceResourceOpenRequest; version: string; bytes: number | undefined }, signal: AbortSignal,
) => Promise<WorkspaceDocumentBytes>

/** @param path - workspace-relative filename. @returns whether the PDF or Office conversion renderer handles its content. */
export function isWorkspaceDocument(path: string): boolean { return /\.(?:pdf|docx?|pptx?)$/iu.test(path) }

/** A successful document read retains the source size estimate it was issued under. */
interface RetainedDocument extends WorkspaceDocumentBytes {
  /** The `value.bytes` estimate observed when this document was read. */
  sourceBytes: number | undefined
}

/** Render a versioned document without adding a second resource subscription or cache.
 * @param props - preview metadata/callbacks, runtime reader, and localized actions.
 * @returns source changes, failures, missing fonts, and the lazy PDF viewer.
 */
export function WorkspaceDocumentPreview({ request, resource, read, pdfT, officeT, close, labels, view }: {
  request: WorkspaceResourceOpenRequest
  resource: WorkspacePreviewResource
  read: ReadWorkspaceDocument
  pdfT: PropsLocale<'sidebarPdf'>['t']
  officeT: PropsLocale<'sidebarOffice'>['t']
  close: () => void
  view: { page: number }
  labels: { close: string; reload: string; changed: string }
}) {
  const { metadata, revoke } = resource
  const [result, setResult] = useState<RetainedDocument>()
  const [error, setError] = useState<Error>()
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState(false)
  const [reloading, setReloading] = useState(false)
  const denied = metadata.accessDenied || isWorkspaceAccessFailure(error)
  // A retained document keeps its own source version and byte estimate while the
  // resource reports a changed successor, so a revalidation publication cannot
  // re-read the already displayed bytes.
  const retained = metadata.value?.changed === true && result !== undefined
  const version = retained ? result.version : metadata.value?.version
  const byteEstimate = retained ? result.sourceBytes : metadata.value?.bytes
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
    void read({ resource: request, version, bytes: byteEstimate }, signal).then((value) => {
      if (!signal.aborted) setResult({ ...value, sourceBytes: byteEstimate })
    }, (cause: unknown) => {
      if (signal.aborted) return
      const failure = cause instanceof Error ? cause : new Error(String(cause))
      setResult(undefined)
      setError(failure)
      if (isWorkspaceAccessFailure(failure)) revoke(failure.message)
    }).finally(() => { if (!signal.aborted) setPending(false) })
    return () => { abort.abort() }
  }, [read, request, revoke, version, attempt, denied, lifetime, byteEstimate, reloading])
  const data = useMemo(() => result === undefined ? undefined : Uint8Array.from(atob(result.bytes), c => c.charCodeAt(0)), [result])
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
  const code = (error as { code?: unknown } | undefined)?.code
  const failure = error === undefined ? metadata.error : { message: error.message, code: typeof code === 'string' ? code : undefined }
  const message = failure === undefined ? undefined : describeFailure(failure, officeT)
  return <section aria-label={request.path} className={css.filePreview}>
    <div className={css.filePreviewActions}>
      <Button size="sm" onClick={close}>{labels.close}</Button>
      <Button size="sm" disabled={pending || denied || reloading || metadata.status === 'loading'} onClick={() => { void reload() }}>{labels.reload}</Button>
    </div>
    {message !== undefined && <p role="alert">{message}</p>}
    {!denied && metadata.value?.changed === true && <p role="status">{labels.changed}</p>}
    {!denied && data !== undefined && result !== undefined && <>
      <FontNotice resourceAddress={request.address} sourceVersion={result.version} fonts={result.missingFonts} t={officeT} />
      <Suspense fallback={<p role="status">{pdfT('loading')}</p>}>
        <PdfBody data={data} signal={lifetime.signal} t={pdfT} view={view} />
      </Suspense>
    </>}
    {!denied && data === undefined && (pending || metadata.status === 'loading') && <p role="status">{officeT('loading')}</p>}
  </section>
}

function describeFailure(error: { message: string; code?: string | undefined }, t: PropsLocale<'sidebarOffice'>['t']): string {
  switch (error.code) {
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
