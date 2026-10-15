/** Per-pane header actions contributed to the conversation viewport. */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCloseOutline16, IconEllipsisOutline16, IconFolderOpenOutline16, IconFullscreenOutline16,
  IconMinimizeOutline16, Menu, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ProjectUiPolicySnapshot, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { NS } from '../locales.ts'
import { paneIdentity, ScopeTile } from './ScopeTile.tsx'
import css from './Workbench.module.css'

interface Props extends PropsRuntime<'conversation.workbench.pane.header'>, PropsLocale<typeof NS> {
  replacePane: () => void
  movePane: (direction: 'previous' | 'next') => void
  /** Provider availability for this pane's runtime, evaluated at render time. */
  filesAvailable?: () => boolean
  /** Open the Workspace file browser bound to this pane's Session and runtime target. */
  openFiles?: () => void
  /** Account scope policy, resolving the pane's own steward flag. */
  useProjectPolicy: <R>(select: (policy: ProjectUiPolicySnapshot) => R) => R
}

/** Map unavailable or waiting Sessions to a warning, running Sessions to activity, and idle Sessions to completion. */
export function stateOf(summary: SessionListState['byId'][SessionId] | undefined): 'ongoing' | 'warning' | 'done' {
  if (summary === undefined || summary.pendingInteraction !== undefined) return 'warning'
  if (summary.running) return 'ongoing'
  return 'done'
}

/** Render one pane header: space identity, status capsule, hover actions — or the collapsed strip. */
export function WorkbenchPaneHeader({
  sessionId, active, onFocus, onClose, maximized, onMaximize, collapsed = false, collapsible = false,
  onToggleCollapse, solo = false, onSolo, replacePane, movePane,
  filesAvailable, openFiles, useSessions, useWorkspaces, useProjectPolicy, t,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const summary = useSessions(s => s.byId[sessionId])
  const workspaces = useWorkspaces(s => s)
  const policy = useProjectPolicy(value => value)
  const identity = paneIdentity(sessionId, summary, workspaces, policy, t('personal'), t('untitled'))
  const subtitle = identity.workspaceName === '' || identity.workspaceName === identity.scopeName
    ? identity.scopeName
    : `${identity.scopeName} · ${identity.workspaceName}`
  // Completion on a non-focused pane wears the receipt marker until focus
  // (the object layer clears `completed` on selection).
  const receipt = !active && summary?.completed === true
  const state = stateOf(summary)
  const status = summary === undefined ? 'notLoaded' : state === 'warning' ? 'waiting'
    : state === 'ongoing' ? 'running' : receipt ? 'newReply' : 'ready'
  const showFiles = filesAvailable?.() === true && openFiles !== undefined

  if (collapsed) {
    return (
      <button
        type="button"
        className={css.paneStrip}
        data-workbench-pane-header=""
        data-collapsed=""
        aria-label={t('expandPane')}
        title={t('expandPane')}
        onClick={(event) => {
          event.stopPropagation()
          if (onToggleCollapse === undefined) onFocus()
          else onToggleCollapse()
        }}
      >
        <ScopeTile name={identity.scopeName} tone={identity.tone} />
        {receipt
          ? <span className={css.receiptDot} aria-hidden />
          : <StateDot state={state} size={8} />}
        <span className={css.paneStripTitle}>{identity.title}</span>
        <span className={css.srOnly}>{t(status)}</span>
      </button>
    )
  }

  return (
    <header className={css.paneHeader} data-workbench-pane-header="" data-active={active || undefined} onClick={onFocus}>
      <div
        className={css.paneIdentity}
        data-pane-drag=""
        draggable
        title={t('dragReorder')}
      >
        <ScopeTile name={identity.scopeName} tone={identity.tone} />
        <div className={css.paneLead}>
          <strong title={summary?.displayTitle}>{identity.title}</strong>
          <span title={subtitle}>{subtitle}</span>
        </div>
      </div>
      <span className={css.paneState} data-tone={status}>
        {status === 'newReply'
          ? <span className={css.receiptDot} aria-hidden />
          : <StateDot state={state} size={8} />}
        <span>{t(status)}</span>
      </span>
      <span className={css.paneActions}>
        {collapsible && (
          <button
            type="button"
            className={css.iconAction}
            aria-label={t('collapse')}
            title={t('collapse')}
            onClick={(event) => { event.stopPropagation(); onToggleCollapse?.() }}
          >
            <IconMinimizeOutline16 />
          </button>
        )}
        <button
          type="button"
          className={css.iconAction}
          aria-label={t(maximized ? 'restore' : 'maximize')}
          title={t(maximized ? 'restore' : 'maximize')}
          onClick={(event) => { event.stopPropagation(); onMaximize() }}
        >
          <IconFullscreenOutline16 />
        </button>
        <Menu open={menuOpen} onClose={() => { setMenuOpen(false) }} align="end" portal dense
          items={[
            ...(showFiles ? [
              { id: 'files', label: t('files'), icon: <IconFolderOpenOutline16 /> },
              { type: 'separator' as const, id: 'pane-files-separator' },
            ] : []),
            { id: 'replace', label: t('replace') },
            { type: 'separator' as const, id: 'pane-move-separator' },
            { id: 'previous', label: t('previous') },
            { id: 'next', label: t('next') },
            ...(onSolo === undefined ? [] : [
              { type: 'separator' as const, id: 'pane-solo-separator' },
              { id: 'solo', label: t(solo ? 'exitSolo' : 'solo') },
            ]),
          ]}
          onSelect={(id: string) => {
            setMenuOpen(false)
            if (id === 'files') openFiles?.()
            else if (id === 'replace') replacePane()
            else if (id === 'solo') onSolo?.()
            else movePane(id as 'previous' | 'next')
          }}
          anchor={<button type="button" className={css.iconAction} aria-label={t('more')} title={t('more')} onClick={(event) => { event.stopPropagation(); setMenuOpen(open => !open) }}><IconEllipsisOutline16 /></button>}
        />
        <button
          type="button"
          className={css.iconAction}
          aria-label={t('close')}
          title={t('close')}
          onClick={(event) => { event.stopPropagation(); onClose() }}
        >
          <IconCloseOutline16 />
        </button>
      </span>
    </header>
  )
}
