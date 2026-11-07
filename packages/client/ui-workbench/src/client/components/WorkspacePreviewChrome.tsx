/** The action row, failure and change notices, and loading placeholder every workspace preview renders. */
import type { ReactNode } from 'react'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspacePreviewActionLabels, WorkspacePreviewResource } from '../contract/preview/use-preview-read.ts'
import { WorkspacePreviewActions } from './WorkspacePreviewActions.tsx'

/** The read-lifecycle facts the chrome renders; everything else stays in the preview body. */
export type WorkspacePreviewChromeState = Pick<
  import('../contract/preview/use-preview-read.ts').WorkspacePreviewRead<unknown>,
  'pending' | 'reloading' | 'denied' | 'reload' | 'error' | 'changed'
>

/** Render the preview section's shared chrome around the variant's body.
 * @param props - request/resource identity, read state, mapped failure text, and labels.
 * @returns the labeled section with close/reload actions, notices, body, and loading placeholder.
 */
export function WorkspacePreviewChrome({ request, resource, state, className, message, hasContent, close, labels, children }: {
  request: WorkspaceResourceOpenRequest
  resource: WorkspacePreviewResource
  state: WorkspacePreviewChromeState
  /** Section class list naming the preview variant. */
  className: string | undefined
  /** Failure text already mapped to localized copy by the variant. */
  message: string | undefined
  /** Whether the body already holds content; controls the loading placeholder. */
  hasContent: boolean
  close: () => void
  /** Localized action and notice labels. */
  labels: WorkspacePreviewActionLabels & { changed: string; loading: string }
  children: ReactNode
}): ReactNode {
  const metadata = resource.metadata
  return <section aria-label={request.path} className={className}>
    <WorkspacePreviewActions close={close} reload={state.reload}
      disabled={state.pending || state.denied || state.reloading || metadata.status === 'loading'}
      denied={state.denied} hasContent={hasContent} failure={state.error ?? metadata.error} message={message} labels={labels} />
    {!state.denied && (state.changed || metadata.value?.changed === true) && <p role="status">{labels.changed}</p>}
    {children}
    {!state.denied && !hasContent && (state.pending || metadata.status === 'loading') &&
      <p role="status">{labels.loading}</p>}
  </section>
}
