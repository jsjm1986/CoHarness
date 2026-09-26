/** Workspace preview contributed to the shared auxiliary tab system. */
import { useMemo } from 'react'
import { parseWorkspaceResourceAddress, workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceRegistry, WorkspaceResourceTarget } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { WorkspaceFilePreview } from './WorkspaceFilePreview.tsx'
import type { ReadWorkspacePreview, ReadWorkspaceBytesPreview } from './WorkspaceFilePreview.tsx'
import { WorkspaceDocumentPreview, isWorkspaceDocument } from './WorkspaceDocumentPreview.tsx'
import type { ReadWorkspaceDocument } from './WorkspaceDocumentPreview.tsx'
import { WorkspaceMarkdownPreview, isWorkspaceMarkdown } from './WorkspaceMarkdownPreview.tsx'
import { WorkspaceHtmlPreview, isWorkspaceHtml } from './WorkspaceHtmlPreview.tsx'
import type { RenderWorkspaceHtml } from './WorkspaceHtmlPreview.tsx'
import type { ReadWorkspaceFileData } from '../html/read-relative.ts'
import type { ComponentType } from 'react'
import type { FontNoticeProps } from '../office/FontNotice.tsx'
import type { NS } from '../locales.ts'

/** Readers and metadata belong to the existing authorized workspace service. */
export interface WorkspaceFileTabInjected {
  resources: WorkspaceResourceRegistry
  runtimeTarget: () => WorkspaceResourceTarget
  readDocument: ReadWorkspaceDocument
  pdfT: PropsLocale<'sidebarPdf'>['t']
  officeT: PropsLocale<'sidebarOffice'>['t']
  markdownT: PropsLocale<'sidebarMarkdown'>['t']
  htmlT: PropsLocale<'sidebarHtml'>['t']
  readPreview: ReadWorkspacePreview
  readBytesPreview: ReadWorkspaceBytesPreview
  readFileBytes: ReadWorkspaceFileData
  renderHtml: RenderWorkspaceHtml
  fontNotice: ComponentType<FontNoticeProps>
}

/** Render only the visible occurrence, retaining metadata through the tab owner.
 * @param props - exact Session, navigation, authorized readers, and copy.
 * @returns the bounded file preview, or nothing while hidden.
 */
export function WorkspaceFileTab(props:
  PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<typeof NS> & WorkspaceFileTabInjected) {
  const {
    sessionId, useTabInfo, runtimeTarget, resources, readDocument, pdfT, officeT, markdownT, htmlT, t,
    readPreview, readBytesPreview, readFileBytes, renderHtml, fontNotice,
  } = props
  const { tab } = useTabInfo()
  const request = useMemo(() => {
    const parsed = parseWorkspaceResourceAddress(tab.navigation.address)
    if (parsed === undefined || parsed.sessionId !== sessionId) throw new Error('File tab does not belong to this Session')
    return { ...parsed, address: workspaceResourceAddress(sessionId, parsed.path), runtimeTarget: runtimeTarget() }
  }, [sessionId, tab.navigation.address, runtimeTarget])
  const pdfView = useMemo(() => ({ page: 1 }), [request])
  const params = tab.navigation.params
  const line = params !== undefined && 'line' in params ? params.line : undefined
  if (!tab.visible) return null
  const key = `${request.address}:${String(tab.navigation.revision)}`
  const actions = { close: t('previewClose'), reload: t('previewReload'), changed: t('previewChanged') }
  if (isWorkspaceDocument(request.path)) return <WorkspaceDocumentPreview
    key={key} request={request} resources={resources}
    read={readDocument} view={pdfView} pdfT={pdfT} officeT={officeT} fontNotice={fontNotice} close={() => { tab.actions.close() }}
    labels={actions} />
  if (isWorkspaceHtml(request.path)) return <WorkspaceHtmlPreview
    key={key} request={request} resources={resources} read={readFileBytes} renderHtml={renderHtml} htmlT={htmlT}
    close={() => { tab.actions.close() }} labels={actions} />
  if (isWorkspaceMarkdown(request.path)) return <WorkspaceMarkdownPreview
    key={key} request={request} resources={resources} read={readPreview} markdownT={markdownT}
    close={() => { tab.actions.close() }} labels={{ ...actions, loading: t('previewLoading') }} />
  return <WorkspaceFilePreview key={key} request={request} initialLine={line} read={readPreview} readBytes={readBytesPreview}
    resources={resources} close={() => { tab.actions.close() }} labels={{ close: t('previewClose'), reload: t('previewReload'), previous: t('previewPrevious'), next: t('previewNext'), loading: t('previewLoading'), changed: t('previewChanged'), binary: t('previewBinary') }} />
}
