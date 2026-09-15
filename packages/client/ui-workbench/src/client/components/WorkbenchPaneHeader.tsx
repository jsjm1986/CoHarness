/** Per-pane header actions contributed to the conversation viewport. */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCloseOutline16, IconFolderOpenOutline16, IconFullscreenOutline16, Menu, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { workspaceTitleOf, type SessionId, type SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { NS } from '../locales.ts'
import css from './Workbench.module.css'

interface Props extends PropsRuntime<'conversation.workbench.pane.header'>, PropsLocale<typeof NS> {
  replacePane: () => void
  movePane: (direction: 'previous' | 'next') => void
  /** Provider availability for this pane's runtime, evaluated at render time. */
  filesAvailable?: () => boolean
  /** Open the Workspace file browser bound to this pane's Session and runtime target. */
  openFiles?: () => void
}

function stateOf(summary: SessionListState['byId'][SessionId] | undefined): 'ongoing' | 'warning' | 'done' {
  if (summary?.pendingInteraction !== undefined) return 'warning'
  if (summary?.running) return 'ongoing'
  return 'done'
}

/** Render one compact pane title and close action. */
export function WorkbenchPaneHeader({
  sessionId, active, onFocus, onClose, maximized, onMaximize, replacePane, movePane,
  filesAvailable, openFiles, useSessions, useWorkspaces, t,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const workspaceTitle = useWorkspaces(s => s.items.find(item => item.sessionIds.includes(sessionId))?.title)
  const summary = useSessions(s => s.byId[sessionId])
  const workspace = workspaceTitle ?? summary?.workspaceName ?? workspaceTitleOf(summary?.cwd ?? '')
  const showFiles = filesAvailable?.() === true && openFiles !== undefined
  return (
    <header className={css.paneHeader} data-workbench-pane-header="" onClick={onFocus}>
      <span className={css.paneStatus} title={t(stateOf(summary) === 'warning' ? 'waiting' : stateOf(summary) === 'ongoing' ? 'running' : 'ready')}>
        <StateDot state={stateOf(summary)} size={8} />
        <span className={css.srOnly}>{t(stateOf(summary) === 'warning' ? 'waiting' : stateOf(summary) === 'ongoing' ? 'running' : 'ready')}</span>
      </span>
      <div className={css.paneTitle}>
        <strong title={summary?.displayTitle}>{summary?.displayTitle ?? t('untitled')}</strong>
        <span className={css.paneWorkspace} title={summary?.cwd}>{workspace || t('personal')}</span>
      </div>
      {showFiles && (
        <button
          type="button"
          className={css.iconAction}
          aria-label={t('files')}
          title={t('files')}
          onClick={(event) => { event.stopPropagation(); openFiles() }}
        >
          <IconFolderOpenOutline16 />
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
          { id: 'replace', label: t('replace') },
          { id: 'previous', label: t('previous') },
          { id: 'next', label: t('next') },
        ]}
        onSelect={(id: string) => {
          setMenuOpen(false)
          if (id === 'replace') { replacePane() }
          else { movePane(id as 'previous' | 'next') }
        }}
        anchor={<button type="button" className={css.iconAction} aria-label={t('more')} title={t('more')} onClick={(event) => { event.stopPropagation(); setMenuOpen(open => !open) }}>···</button>}
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
      <span className={css.activeMark} data-active={active || undefined} aria-hidden />
    </header>
  )
}
