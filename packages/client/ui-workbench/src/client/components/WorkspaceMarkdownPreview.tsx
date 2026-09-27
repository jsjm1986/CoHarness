/** Accumulated Workspace Markdown rendered over the existing authorized resource lifetime. */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { WorkspaceResourceError, isWorkspaceAccessFailure } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceRegistry, WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { ReadWorkspacePreview } from './WorkspaceFilePreview.tsx'
import type {} from '../markdown/locales.ts'
import css from './Workbench.module.css'

/** @param path - workspace-relative filename. @returns whether the Markdown renderer handles its content. */
export function isWorkspaceMarkdown(path: string): boolean { return /\.(?:md|markdown)$/iu.test(path) }

/** Accumulated text and the source version it was read under. */
interface MarkdownResult { readonly text: string; readonly version: string }

/** Render one Markdown document through the shared resource subscription and paged reader.
 * @param props - bound resource, authorized reader, lifecycle, and localized chrome.
 * @returns rendered Markdown, access failures, and change notices inside its resource tab.
 */
export function WorkspaceMarkdownPreview({ request, read, resources, markdownT, close, labels }: {
  request: WorkspaceResourceOpenRequest
  read: ReadWorkspacePreview
  resources: WorkspaceResourceRegistry
  markdownT: PropsLocale<'sidebarMarkdown'>['t']
  close: () => void
  labels: { close: string; reload: string; loading: string; changed: string }
}) {
  const source = useMemo(() => resources.source(request), [resources, request])
  const state = useSyncExternalStore(source.subscribe, source.get, source.get)
  const [result, setResult] = useState<MarkdownResult>()
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
    void (async (): Promise<MarkdownResult> => {
      const pages: string[] = []
      let offset = 1
      for (;;) {
        signal.throwIfAborted()
        const page = await read({ resource: request, offset, version }, signal)
        pages.push(page.text)
        if (page.eof) return { text: pages.join(''), version: page.version }
        offset = page.offset + page.limit
      }
    })().then((value) => {
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
  const copyLabel = markdownT('code.copy')
  const copiedLabel = markdownT('code.copied')
  const footnotes = markdownT('footnotes')
  const markdownLabels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel, copiedLabel }, footnotes,
  }), [copyLabel, copiedLabel, footnotes])
  const failure = error ?? state.error
  return <section aria-label={request.path} className={css.filePreview}>
    <div className={css.filePreviewActions}>
      <Button size="sm" onClick={close}>{labels.close}</Button>
      <Button size="sm" disabled={pending || denied || state.status === 'loading'} onClick={() => { void reload() }}>{labels.reload}</Button>
    </div>
    {failure !== undefined && <p role="alert">{failure.message}</p>}
    {!denied && state.value?.changed === true && <p role="status">{labels.changed}</p>}
    {!denied && result !== undefined && (
      <div className={css.markdownDocument} data-workspace-markdown>
        <MarkdownText text={result.text} streaming={false} labels={markdownLabels} />
      </div>
    )}
    {!denied && result === undefined && (pending || state.status === 'loading') && <p role="status">{labels.loading}</p>}
  </section>
}
