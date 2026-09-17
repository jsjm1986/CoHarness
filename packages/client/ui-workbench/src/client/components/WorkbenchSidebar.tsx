/** Sidebar workbench panel: pane roster, pane actions, and the display hole. */
import type {
  HostObservable, PropsHooks, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the region hole's SlotMap merge and the display hole's merge.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationViewportSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { workspaceTitleOf } from '@deepseek-ai/dsh-client-runtime/client'
import { IconCloseOutline16, IconLogoutOutline16, IconPlusOutline16, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { stateOf } from './WorkbenchPaneHeader.tsx'
import type { createWorkbenchStore } from '../stores.ts'
import css from './Workbench.module.css'

/** Registration-side face: the live viewport snapshot plus its pane actions. */
export interface WorkbenchSidebarInjected {
  hooks: {
    /** Current conversation viewport state (mode, pane order, active pane, ratios). */
    viewport: HostObservable<ConversationViewportSnapshot>
  }
  /** Focus one pane and sync the current Session selection. */
  focusPane: (sessionId: SessionId) => void
  /** Release one pane's history window without stopping its task. */
  removePane: (sessionId: SessionId) => void
  /** Normalize pane width weights in pane order. */
  setPaneRatios: (ratios: readonly number[]) => void
  /** Restore the single-conversation surface and the space session list. */
  exitWorkbench: () => void
}

/** Full panel props: region owner share + picker store + viewport face + display hole. */
export type WorkbenchSidebarProps =
  PropsRuntime<'sidebar.workspaces.workbench'>
  & PropsRenderSlots<'conversation.workbench.display'>
  & PropsStore<ReturnType<typeof createWorkbenchStore>>
  & Omit<WorkbenchSidebarInjected, 'hooks'>
  & PropsHooks<WorkbenchSidebarInjected['hooks']>
  & PropsLocale<'workbench'>

/**
 * Render the workbench control panel inside the sidebar browsing region.
 * @param props - composed slot props (runtime seats, picker store, viewport face, locale).
 * @returns the workbench panel.
 */
export function WorkbenchSidebar({
  useViewport, useSessions, useWorkspaces, actions,
  focusPane, removePane, setPaneRatios, exitWorkbench, renderSlot, t,
}: WorkbenchSidebarProps) {
  const viewport = useViewport(state => state)
  const sessions = useSessions(state => state)
  const workspaces = useWorkspaces(state => state)
  const paneIds = viewport.mode === 'workbench' ? viewport.paneIds : []
  return (
    <div className={css.sidebarPanel} role="region" aria-label={t('mode')}>
      <div className={css.sidebarHeader}>
        <span className={css.sidebarTitle}>{t('mode')}</span>
        <Tooltip label={t('exitWorkbench')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.iconAction}
            aria-label={t('exitWorkbench')}
            title={t('exitWorkbench')}
            onClick={exitWorkbench}
          >
            <IconLogoutOutline16 />
          </button>
        </Tooltip>
      </div>
      <div className={css.sidebarSection}>
        <div className={css.sidebarSectionTitle}>
          <span>{t('panes')}</span>
          <span className={css.paneCount} aria-label={`${paneIds.length}/4`}>{paneIds.length}/4</span>
        </div>
        <div className={css.sidebarPanes} role="list" aria-label={t('panes')}>
          {paneIds.length === 0 && <p className={css.sidebarEmpty}>{t('panesEmpty')}</p>}
          {paneIds.map((id) => {
            const summary = sessions.byId[id]
            const state = stateOf(summary)
            const status = state === 'warning' ? 'waiting' : state === 'ongoing' ? 'running' : 'ready'
            const scope = workspaces.items.find(item => item.sessionIds.includes(id))?.title
              ?? summary?.workspaceName
              ?? workspaceTitleOf(summary?.cwd ?? '')
            const active = viewport.activePaneId === id
            return (
              <div key={id} className={css.sidebarPaneRow} data-active={active || undefined} role="listitem">
                <button
                  type="button"
                  className={css.sidebarPaneFocus}
                  aria-current={active || undefined}
                  title={t('focus')}
                  onClick={() => { focusPane(id) }}
                >
                  <StateDot state={state} size={8} />
                  <span className={css.sidebarPaneTitle}>
                    {scope === '' ? '' : `${scope} · `}{summary?.displayTitle ?? t('untitled')}
                  </span>
                  <span className={css.srOnly}>{t(status)}</span>
                </button>
                <Tooltip label={t('close')} side="bottom" delayMs={500}>
                  <button
                    type="button"
                    className={css.iconAction}
                    aria-label={t('close')}
                    onClick={() => { removePane(id) }}
                  >
                    <IconCloseOutline16 />
                  </button>
                </Tooltip>
              </div>
            )
          })}
        </div>
        <div className={css.sidebarActions}>
          <button
            type="button"
            className={css.sidebarAction}
            disabled={paneIds.length >= 4}
            onClick={() => { actions.openPicker() }}
          >
            <IconPlusOutline16 />
            <span>{t('add')}</span>
          </button>
          <button
            type="button"
            className={css.sidebarAction}
            disabled={paneIds.length < 2}
            onClick={() => { setPaneRatios(paneIds.map(() => 1)) }}
          >
            {t('equalize')}
          </button>
        </div>
      </div>
      <div className={css.sidebarSection}>
        <div className={css.sidebarSectionTitle}><span>{t('display')}</span></div>
        {renderSlot('conversation.workbench.display', {})}
      </div>
    </div>
  )
}
