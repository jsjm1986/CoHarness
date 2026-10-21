/** Complete HTML rendered in a script-enabled opaque iframe over the authorized resource lifetime. */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import { workspaceFileBytes } from '../contract/html/read-relative.ts'
import type { ReadWorkspaceFileData } from '../contract/html/read-relative.ts'
import { MAX_TOTAL_BYTES } from '../contract/html/pack.ts'
import type {} from '../html/locales.ts'
import { useWorkspacePreviewRead } from '../contract/preview/use-preview-read.ts'
import type { WorkspacePreviewResource } from '../contract/preview/use-preview-read.ts'
import { WorkspacePreviewChrome } from './WorkspacePreviewChrome.tsx'
import css from './Workbench.module.css'

/** @param path - workspace-relative filename. @returns whether the HTML renderer handles its content. */
export function isWorkspaceHtml(path: string): boolean { return /\.html?$/iu.test(path) }

/** Pack one file and its in-workspace relative resources into a standalone HTML document. */
export type RenderWorkspaceHtml = (
  data: Uint8Array<ArrayBuffer>, read: ReadWorkspaceFileData,
  request: WorkspaceResourceOpenRequest, lifetime: AbortSignal, signal: AbortSignal,
) => Promise<string>

/** One mounted file owns its root Blob; replacing content also replaces the browsing context. */
function HtmlFrame({ data, read, request, lifetime, renderHtml, t }: {
  data: Uint8Array<ArrayBuffer>
  read: ReadWorkspaceFileData
  request: WorkspaceResourceOpenRequest
  lifetime: AbortSignal
  renderHtml: RenderWorkspaceHtml
  t: PropsLocale<'sidebarHtml'>['t']
}): ReactNode {
  const [frame, setFrame] = useState<{ data: Uint8Array<ArrayBuffer>; url: string | undefined }>()
  useEffect(() => {
    const controller = new AbortController()
    let url: string | undefined
    void (async () => {
      try {
        const html = await renderHtml(data, read, request, lifetime, controller.signal)
        controller.signal.throwIfAborted()
        url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
        setFrame({ data, url })
      } catch {
        if (!controller.signal.aborted) setFrame({ data, url: undefined })
      }
    })()
    return () => {
      controller.abort()
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [data, read, request, lifetime, renderHtml])

  if (frame?.data !== data) return <p className={css.previewStatus} role="status">{t('loading')}</p>
  if (frame.url === undefined) return <p className={css.previewStatus} role="alert">{t('failed')}</p>
  return <iframe key={frame.url} className={css.htmlFrame} src={frame.url} sandbox="allow-scripts" title={t('frame')} data-workspace-html-preview />
}

/** Render a versioned HTML document without adding a second resource subscription or cache.
 * @param props - preview metadata/callbacks, authorized complete-file reader, and localized actions.
 * @returns source changes, failures, and the isolated HTML document.
 */
export function WorkspaceHtmlPreview({ request, resource, read, htmlT, renderHtml, close, labels }: {
  request: WorkspaceResourceOpenRequest
  resource: WorkspacePreviewResource
  read: ReadWorkspaceFileData
  renderHtml: RenderWorkspaceHtml
  htmlT: PropsLocale<'sidebarHtml'>['t']
  close: () => void
  labels: { close: string; reload: string; changed: string }
}) {
  const input = useMemo(() => resource.metadata.value?.version, [resource.metadata.value?.version])
  const readFile = useMemo(() => (version: string, signal: AbortSignal) =>
    read({ resource: request, version, maxBytes: MAX_TOTAL_BYTES }, signal), [read, request])
  const state = useWorkspacePreviewRead({ request, resource, input, read: readFile })
  const { result, error, denied, lifetime } = state
  const data = useMemo(() => result === undefined ? undefined : workspaceFileBytes(result), [result])
  const failure = error ?? resource.metadata.error
  return <WorkspacePreviewChrome request={request} resource={resource} state={state}
    className={css.filePreview} message={failure?.message} hasContent={data !== undefined}
    close={close} labels={{ ...labels, loading: htmlT('loading') }}>
    {!denied && data !== undefined && (
      <HtmlFrame
        key={request.address} data={data} read={read} request={request}
        lifetime={lifetime.signal} renderHtml={renderHtml} t={htmlT}
      />
    )}
  </WorkspacePreviewChrome>
}
