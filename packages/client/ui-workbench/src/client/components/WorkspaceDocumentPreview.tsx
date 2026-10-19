/** Office and PDF previews share the existing authorized Workspace resource lifetime. */
import { lazy, Suspense, useMemo } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import { FontNotice } from '../contract/office/FontNotice.tsx'
import type {} from '../office/locales.ts'
import type {} from '../pdf/locales.ts'
import { ZoomViewport, zoomSurfaceClass } from '../contract/zoom/ZoomViewport.tsx'
import type { ZoomPreference } from '../contract/zoom/types.ts'
import { useWorkspacePreviewRead } from '../contract/preview/use-preview-read.ts'
import type { WorkspacePreviewResource } from '../contract/preview/use-preview-read.ts'
import { WorkspacePreviewChrome } from './WorkspacePreviewChrome.tsx'
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

/** The version and source byte estimate one document read runs under. */
interface DocumentRead { version: string; bytes: number | undefined }

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
  view: { page: number; zoom?: ZoomPreference }
  labels: { close: string; reload: string; changed: string }
}) {
  const input = useMemo((): DocumentRead | undefined => {
    const value = resource.metadata.value
    return value?.version === undefined ? undefined : { version: value.version, bytes: value.bytes }
  }, [resource.metadata.value?.version, resource.metadata.value?.bytes])
  const readDocument = useMemo(() => (next: DocumentRead, signal: AbortSignal) =>
    read({ resource: request, version: next.version, bytes: next.bytes }, signal), [read, request])
  const state = useWorkspacePreviewRead({ request, resource, input, read: readDocument })
  const { result, error, denied, lifetime } = state
  const data = useMemo(() => result === undefined ? undefined : Uint8Array.from(atob(result.bytes), c => c.charCodeAt(0)), [result])
  const code = (error as { code?: unknown } | undefined)?.code
  const failure = error === undefined ? resource.metadata.error : { message: error.message, code: typeof code === 'string' ? code : undefined }
  const message = failure === undefined ? undefined : describeFailure(failure, officeT)
  return <WorkspacePreviewChrome request={request} resource={resource} state={state}
    className={`${css.filePreview} ${css.filePreviewZoom}`} message={message} hasContent={result !== undefined}
    close={close} labels={{ ...labels, loading: officeT('loading') }}>
    {!denied && data !== undefined && result !== undefined && <>
      <FontNotice resourceAddress={request.address} sourceVersion={result.version} fonts={result.missingFonts} t={officeT} />
      <Suspense fallback={<p role="status">{pdfT('loading')}</p>}>
        <PdfBody data={data} signal={lifetime.signal} t={pdfT} view={view}
          ZoomViewport={ZoomViewport} zoomSurfaceClass={zoomSurfaceClass} />
      </Suspense>
    </>}
  </WorkspacePreviewChrome>
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
