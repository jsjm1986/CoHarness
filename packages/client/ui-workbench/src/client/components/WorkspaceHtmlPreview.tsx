/** Complete HTML rendered in a script-enabled opaque iframe over the authorized resource lifetime. */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { WorkspaceResourceError, isWorkspaceAccessFailure } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceRegistry, WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { ReadWorkspaceFileData, WorkspaceFileData } from '../html/read-relative.ts'
import type {} from '../html/locales.ts'
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
 * @param props - existing resource, authorized complete-file reader, and localized actions.
 * @returns source changes, failures, and the isolated HTML document.
 */
export function WorkspaceHtmlPreview({ request, resources, read, htmlT, renderHtml, close, labels }: {
  request: WorkspaceResourceOpenRequest
  resources: WorkspaceResourceRegistry
  read: ReadWorkspaceFileData
  renderHtml: RenderWorkspaceHtml
  htmlT: PropsLocale<'sidebarHtml'>['t']
  close: () => void
  labels: { close: string; reload: string; changed: string }
}) {
  const source = useMemo(() => resources.source(request), [resources, request])
  const state = useSyncExternalStore(source.subscribe, source.get, source.get)
  const [result, setResult] = useState<WorkspaceFileData>()
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
    void read({ resource: request, version }, signal).then((value) => {
      if (!signal.aborted) setResult(value)
    }, (cause: unknown) => {
      if (signal.aborted) return
      const failure = cause instanceof Error ? cause : new Error(String(cause))
      setResult(undefined)
      setError(failure)
      if (isWorkspaceAccessFailure(failure)) resources.disconnect(request.runtimeTarget, new WorkspaceResourceError('access-revoked', failure.message))
    }).finally(() => { if (!signal.aborted) setPending(false) })
    return () => { abort.abort() }
  }, [read, request, resources, version, attempt, denied, lifetime])
  const reload = async (): Promise<void> => {
    setError(undefined)
    setResult(undefined)
    await source.reload()
    setAttempt(value => value + 1)
  }
  const failure = error ?? state.error
  return <section aria-label={request.path} className={css.filePreview}>
    <div className={css.filePreviewActions}>
      <Button size="sm" onClick={close}>{labels.close}</Button>
      <Button size="sm" disabled={pending || denied || state.status === 'loading'} onClick={() => { void reload() }}>{labels.reload}</Button>
    </div>
    {failure !== undefined && <p role="alert">{failure.message}</p>}
    {!denied && state.value?.changed === true && <p role="status">{labels.changed}</p>}
    {!denied && result !== undefined && (
      <HtmlFrame
        key={request.address} data={result.data} read={read} request={request}
        lifetime={lifetime.signal} renderHtml={renderHtml} t={htmlT}
      />
    )}
    {!denied && result === undefined && (pending || state.status === 'loading') && <p role="status">{htmlT('loading')}</p>}
  </section>
}
