/** Accumulated Workspace Markdown rendered over the existing authorized resource lifetime. */
import { useEffect, useMemo, useState } from 'react'
import { Button, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { isWorkspaceAccessFailure } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { ReadWorkspacePreview } from './WorkspaceFilePreview.tsx'
import type {} from '../markdown/locales.ts'
import type { WorkspacePreviewResource } from './WorkspaceFileTab.tsx'
import css from './Workbench.module.css'

/** @param path - workspace-relative filename. @returns whether the Markdown renderer handles its content. */
export function isWorkspaceMarkdown(path: string): boolean { return /\.(?:md|markdown)$/iu.test(path) }

/** Accumulated text and the source version it was read under. */
interface MarkdownResult { readonly text: string; readonly version: string }

/** Render one Markdown document through the shared resource metadata and paged reader.
 * @param props - preview metadata/callbacks, authorized reader, lifecycle, and localized chrome.
 * @returns rendered Markdown, access failures, and change notices inside its resource tab.
 */
export function WorkspaceMarkdownPreview({ request, read, resource, markdownT, close, labels }: {
  request: WorkspaceResourceOpenRequest
  read: ReadWorkspacePreview
  resource: WorkspacePreviewResource
  markdownT: PropsLocale<'sidebarMarkdown'>['t']
  close: () => void
  labels: { close: string; reload: string; loading: string; changed: string }
}) {
  const { metadata, revoke } = resource
  const [result, setResult] = useState<MarkdownResult>()
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
      if (isWorkspaceAccessFailure(failure)) revoke(failure.message)
    }).finally(() => { if (!signal.aborted) setPending(false) })
    return () => { abort.abort() }
  }, [read, request, revoke, version, attempt, denied, lifetime, reloading])
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
  const copyLabel = markdownT('code.copy')
  const copiedLabel = markdownT('code.copied')
  const footnotes = markdownT('footnotes')
  const markdownLabels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel, copiedLabel }, footnotes,
  }), [copyLabel, copiedLabel, footnotes])
  const failure = error ?? metadata.error
  return <section aria-label={request.path} className={css.filePreview}>
    <div className={css.filePreviewActions}>
      <Button size="sm" onClick={close}>{labels.close}</Button>
      <Button size="sm" disabled={pending || denied || reloading || metadata.status === 'loading'} onClick={() => { void reload() }}>{labels.reload}</Button>
    </div>
    {failure !== undefined && <p role="alert">{failure.message}</p>}
    {!denied && metadata.value?.changed === true && <p role="status">{labels.changed}</p>}
    {!denied && result !== undefined && (
      <div className={css.markdownDocument} data-workspace-markdown>
        <MarkdownText text={result.text} streaming={false} labels={markdownLabels} />
      </div>
    )}
    {!denied && result === undefined && (pending || metadata.status === 'loading') && <p role="status">{labels.loading}</p>}
  </section>
}
