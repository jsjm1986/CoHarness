/** Accumulated Workspace Markdown rendered over the existing authorized resource lifetime. */
import { lazy, Suspense, useMemo } from 'react'
import type { ReactNode } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { ReadWorkspacePreview } from './WorkspaceFilePreview.tsx'
import type {} from '../markdown/locales.ts'
import { splitFrontmatter } from '../contract/markdown/frontmatter.ts'
import type { FrontmatterFieldsProps } from '../markdown/frontmatter-fields.tsx'
import { useWorkspacePreviewRead } from '../contract/preview/use-preview-read.ts'
import type { WorkspacePreviewResource } from '../contract/preview/use-preview-read.ts'
import { WorkspacePreviewChrome } from './WorkspacePreviewChrome.tsx'
import css from './Workbench.module.css'

/** Show the verbatim frontmatter when the field-list chunk cannot load. */
function FrontmatterFallback({ fallback }: FrontmatterFieldsProps): ReactNode {
  return fallback
}

const FrontmatterFields = lazy(() => import('../markdown/frontmatter-fields.tsx').then(
  module => ({ default: module.FrontmatterFields }),
  // The failed chunk only removes the field layout; the body and verbatim metadata stay usable.
  () => ({ default: FrontmatterFallback }),
))

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
  const input = useMemo(() => resource.metadata.value?.version, [resource.metadata.value?.version])
  const readAll = useMemo(() => async (version: string, signal: AbortSignal): Promise<MarkdownResult> => {
    const pages: string[] = []
    let offset = 1
    for (;;) {
      signal.throwIfAborted()
      const page = await read({ resource: request, offset, version }, signal)
      pages.push(page.text)
      if (page.eof) return { text: pages.join(''), version: page.version }
      offset = page.offset + page.limit
    }
  }, [read, request])
  const state = useWorkspacePreviewRead({ request, resource, input, read: readAll })
  const { result, error, denied } = state
  const copyLabel = markdownT('code.copy')
  const copiedLabel = markdownT('code.copied')
  const footnotes = markdownT('footnotes')
  const codeLabel = markdownT('codeBlock.title')
  const wrapLabel = markdownT('codeBlock.wrap')
  const unwrapLabel = markdownT('codeBlock.unwrap')
  const markdownLabels = useMemo<MarkdownLabels>(() => ({
    code: {
      copyLabel, copiedLabel,
      toolbarLabels: { codeLabel, wrapLabel, unwrapLabel },
    }, footnotes,
  }), [copyLabel, copiedLabel, footnotes, codeLabel, wrapLabel, unwrapLabel])
  const split = useMemo(() => splitFrontmatter(result?.text ?? ''), [result])
  const failure = error ?? resource.metadata.error
  return <WorkspacePreviewChrome request={request} resource={resource} state={state}
    className={css.filePreview} message={failure?.message} hasContent={result !== undefined}
    close={close} labels={labels}>
    {!denied && result !== undefined && (
      <div className={css.markdownDocument} data-workspace-markdown>
        {split === undefined ? null : <FrontmatterBox source={split.source} />}
        <MarkdownText text={split?.body ?? result.text} streaming={false} labels={markdownLabels} />
      </div>
    )}
  </WorkspacePreviewChrome>
}

/**
 * Frame one frontmatter block and choose its field list or verbatim source.
 * @param props - YAML between the frontmatter delimiters.
 * @returns the metadata box; it collapses when the document has no content.
 */
function FrontmatterBox({ source }: { source: string }): ReactNode {
  const verbatim = <pre className={css.frontmatterSource}>{source}</pre>
  return (
    <div className={css.frontmatter} data-workspace-frontmatter>
      <Suspense fallback={verbatim}><FrontmatterFields source={source} fallback={verbatim} /></Suspense>
    </div>
  )
}
