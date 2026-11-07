/** Shared preview actions retain document geometry during stream recovery and HTTP request failure. */
import { useId, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Workbench.module.css'
import type { WorkspacePreviewActionLabels } from '../contract/preview/use-preview-read.ts'

/**
 * Render resource-local actions and the effective failure without moving retained content on connection loss.
 * @param props - authorized preview actions, effective failure, loaded-content state, and localized labels.
 * @returns actions and the complete accessible failure, compact beside retained content for connection failures.
 */
export function WorkspacePreviewActions({ close, reload, disabled, denied, hasContent, failure, message, labels, children }: {
  close: () => void
  reload: () => Promise<void>
  disabled: boolean
  denied: boolean
  hasContent: boolean
  failure: { message: string; code?: unknown } | undefined
  message: string | undefined
  labels: WorkspacePreviewActionLabels
  children?: ReactNode
}): ReactNode {
  const alertId = useId()
  const reconnecting = hasContent && !denied && failure?.code === 'connection-unavailable'
  const requestFailed = failure?.code === 'request-unavailable'
  const compactFailure = hasContent && !denied && (reconnecting || requestFailed)
  const report = requestFailed ? (hasContent && !denied ? labels.requestFailedRetained : labels.requestFailed) : message
  return <>
    <div className={css.filePreviewActions}>
      <Button size="sm" onClick={close}>{labels.close}</Button>
      <Button size="sm" className={css.previewReload} disabled={disabled} aria-label={labels.reload}
        aria-describedby={compactFailure ? alertId : undefined} data-workspace-preview-reconnecting={reconnecting || undefined}
        data-workspace-preview-request-failed={requestFailed || undefined}
        onClick={() => { void reload() }}>
        <span className={css.previewReloadLabels} aria-hidden="true">
          <span className={css.previewReloadSize}>{labels.reload}</span>
          <span className={css.previewReloadSize}>{labels.reconnecting}</span>
          <span className={css.previewReloadSize}>{labels.reloadFailed}</span>
          <span>{reconnecting ? labels.reconnecting : requestFailed ? labels.reloadFailed : labels.reload}</span>
        </span>
      </Button>
      {children}
    </div>
    {report !== undefined && <p id={alertId} role="alert" className={compactFailure ? css.srOnly : undefined}>{report}</p>}
  </>
}
