/** Shared preview actions retain their geometry while a loaded resource reconnects. */
import { useId, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Workbench.module.css'

/**
 * Render resource-local actions and the effective failure without moving retained content on connection loss.
 * @param props - authorized preview actions, effective failure, loaded-content state, and localized labels.
 * @returns the action row and the complete accessible failure, in-flow for failures other than a retained reconnect.
 */
export function WorkspacePreviewActions({ close, reload, disabled, denied, hasContent, failure, message, labels, children }: {
  close: () => void
  reload: () => Promise<void>
  disabled: boolean
  denied: boolean
  hasContent: boolean
  failure: { message: string; code?: unknown } | undefined
  message: string | undefined
  labels: { close: string; reload: string; reconnecting: string }
  children?: ReactNode
}): ReactNode {
  const alertId = useId()
  const reconnecting = hasContent && !denied && failure?.code === 'connection-unavailable'
  return <>
    <div className={css.filePreviewActions}>
      <Button size="sm" onClick={close}>{labels.close}</Button>
      <Button size="sm" className={css.previewReload} disabled={disabled} aria-label={labels.reload}
        aria-describedby={reconnecting ? alertId : undefined} data-workspace-preview-reconnecting={reconnecting || undefined}
        onClick={() => { void reload() }}>
        <span className={css.previewReloadLabels} aria-hidden="true">
          <span className={css.previewReloadSize}>{labels.reload}</span>
          <span className={css.previewReloadSize}>{labels.reconnecting}</span>
          <span>{reconnecting ? labels.reconnecting : labels.reload}</span>
        </span>
      </Button>
      {children}
    </div>
    {message !== undefined && <p id={alertId} role="alert" className={reconnecting ? css.srOnly : undefined}>{message}</p>}
  </>
}
