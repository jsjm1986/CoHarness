/** Workspace preview contributed to the shared auxiliary tab system. */
import { useMemo } from 'react'
import { isWorkspaceAccessFailure, parseWorkspaceResourceAddress, workspaceResourceAddress, WorkspaceResourceError } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceSource, WorkspaceResourceState, WorkspaceResourceTarget, WorkspaceResourceValue, WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { WorkspaceFilePreview } from './WorkspaceFilePreview.tsx'
import type { ReadWorkspacePreview, ReadWorkspaceBytesPreview } from './WorkspaceFilePreview.tsx'
import { WorkspaceDocumentPreview, isWorkspaceDocument } from './WorkspaceDocumentPreview.tsx'
import type { ReadWorkspaceDocument } from './WorkspaceDocumentPreview.tsx'
import { WorkspaceMarkdownPreview, isWorkspaceMarkdown } from './WorkspaceMarkdownPreview.tsx'
import { WorkspaceHtmlPreview, isWorkspaceHtml } from './WorkspaceHtmlPreview.tsx'
import type { RenderWorkspaceHtml } from './WorkspaceHtmlPreview.tsx'
import { WorkspaceExcelPreview, isWorkspaceSpreadsheet } from './WorkspaceExcelPreview.tsx'
import type { ReadWorkspaceFileData } from '../html/read-relative.ts'
import type { ExcelLimits } from '../excel/model.ts'
import type {} from '../excel/locales.ts'
import type { NS } from '../locales.ts'

/** Readers and metadata belong to the existing authorized workspace service. */
export interface WorkspaceFileTabInjected {
  /** Resource sources keyed by tab address; the renderer binds `useWorkspaceResource`. */
  keyedHooks: {
    workspaceResource: (address: string) => WorkspaceResourceSource | undefined
  }
  runtimeTarget: () => WorkspaceResourceTarget
  /** Reload the request's resource metadata through its existing source. */
  reloadResource: (request: WorkspaceResourceOpenRequest) => Promise<void>
  /** Discard retained metadata and reads after an access failure. */
  revokeResource: (request: WorkspaceResourceOpenRequest, message: string) => void
  readDocument: ReadWorkspaceDocument
  pdfT: PropsLocale<'sidebarPdf'>['t']
  officeT: PropsLocale<'sidebarOffice'>['t']
  markdownT: PropsLocale<'sidebarMarkdown'>['t']
  htmlT: PropsLocale<'sidebarHtml'>['t']
  excelT: PropsLocale<'sidebarExcel'>['t']
  excelLimits: ExcelLimits
  readPreview: ReadWorkspacePreview
  readBytesPreview: ReadWorkspaceBytesPreview
  readFileBytes: ReadWorkspaceFileData
  renderHtml: RenderWorkspaceHtml
}

/**
 * The plain metadata/callback face every preview reads. The subscription lives
 * in the tab's framework hook; children see JSON-compatible facts and bound
 * callbacks, never the registry or the raw source.
 */
export interface WorkspacePreviewResource {
  metadata: {
    status: WorkspaceResourceState['status']
    value?: WorkspaceResourceValue
    error?: { message: string; code?: string }
    accessDenied: boolean
  }
  reload: () => Promise<void>
  revoke: (message: string) => void
}

/** Project one source snapshot to the JSON-compatible metadata previews read. */
function selectPreviewMetadata(
  state: WorkspaceResourceState | undefined,
): WorkspacePreviewResource['metadata'] | undefined {
  if (state === undefined) return undefined
  const failure = state.error === undefined ? undefined : {
    message: state.error.message,
    ...state.error instanceof WorkspaceResourceError ? { code: state.error.code } : {},
  }
  return {
    status: state.status,
    ...state.value === undefined ? {} : { value: state.value },
    ...failure === undefined ? {} : { error: failure },
    accessDenied: isWorkspaceAccessFailure(state.error),
  }
}

/** Referenced snapshots compare member-wise so an identical state never reselects. */
const samePreviewMetadata = (
  left: WorkspacePreviewResource['metadata'] | undefined,
  right: WorkspacePreviewResource['metadata'] | undefined,
): boolean =>
  left === right
  || (left !== undefined && right !== undefined
    && left.status === right.status
    && left.value === right.value
    && left.accessDenied === right.accessDenied
    && left.error?.message === right.error?.message
    && left.error?.code === right.error?.code)

/** Render only the visible occurrence, retaining metadata through the tab owner.
 * @param props - exact Session, navigation, authorized readers, and copy.
 * @returns the bounded file preview, or nothing while hidden.
 */
export function WorkspaceFileTab(props:
  PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<typeof NS> & InjectFace<WorkspaceFileTabInjected>) {
  const {
    sessionId, useTabInfo, runtimeTarget, useWorkspaceResource, reloadResource, revokeResource,
    readDocument, pdfT, officeT, markdownT, htmlT, excelT, excelLimits, t,
    readPreview, readBytesPreview, readFileBytes, renderHtml,
  } = props
  const { tab } = useTabInfo()
  const request = useMemo(() => {
    const parsed = parseWorkspaceResourceAddress(tab.navigation.address)
    if (parsed === undefined || parsed.sessionId !== sessionId) throw new Error('File tab does not belong to this Session')
    return { ...parsed, address: workspaceResourceAddress(sessionId, parsed.path), runtimeTarget: runtimeTarget() }
  }, [sessionId, tab.navigation.address, runtimeTarget])
  // The empty key resolves the absent source: a hidden tab holds no subscription.
  const metadata = useWorkspaceResource(tab.visible ? request.address : '', selectPreviewMetadata, samePreviewMetadata)
  // Callback identities stay stable across metadata publications: children dep
  // on them inside read effects, and a changed-file notice must not reread.
  const reload = useMemo(() => () => reloadResource(request), [reloadResource, request])
  const revoke = useMemo(() => (message: string) => { revokeResource(request, message) }, [revokeResource, request])
  const resource = useMemo<WorkspacePreviewResource>(() => ({
    metadata: metadata ?? { status: 'none', accessDenied: false },
    reload,
    revoke,
  }), [metadata, reload, revoke])
  const pdfView = useMemo(() => ({ page: 1 }), [request])
  const params = tab.navigation.params
  const line = params !== undefined && 'line' in params ? params.line : undefined
  if (!tab.visible) return null
  const key = `${request.address}:${String(tab.navigation.revision)}`
  const actions = { close: t('previewClose'), reload: t('previewReload'), changed: t('previewChanged') }
  if (isWorkspaceSpreadsheet(request.path)) return <WorkspaceExcelPreview
    key={key} request={request} resource={resource} read={readFileBytes} excelT={excelT} limits={excelLimits}
    close={() => { tab.actions.close() }} labels={actions} />
  if (isWorkspaceDocument(request.path)) return <WorkspaceDocumentPreview
    key={key} request={request} resource={resource}
    read={readDocument} view={pdfView} pdfT={pdfT} officeT={officeT} close={() => { tab.actions.close() }}
    labels={actions} />
  if (isWorkspaceHtml(request.path)) return <WorkspaceHtmlPreview
    key={key} request={request} resource={resource} read={readFileBytes} renderHtml={renderHtml} htmlT={htmlT}
    close={() => { tab.actions.close() }} labels={actions} />
  if (isWorkspaceMarkdown(request.path)) return <WorkspaceMarkdownPreview
    key={key} request={request} resource={resource} read={readPreview} markdownT={markdownT}
    close={() => { tab.actions.close() }} labels={{ ...actions, loading: t('previewLoading') }} />
  return <WorkspaceFilePreview key={key} request={request} initialLine={line} read={readPreview} readBytes={readBytesPreview}
    resource={resource} close={() => { tab.actions.close() }} labels={{ close: t('previewClose'), reload: t('previewReload'), previous: t('previewPrevious'), next: t('previewNext'), loading: t('previewLoading'), changed: t('previewChanged'), binary: t('previewBinary') }} />
}
