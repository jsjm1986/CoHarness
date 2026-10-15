/** Sidebar workbench panel: pane roster, pane actions, and the display hole. */
import type {
  HostObservable, PropsHooks, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the region hole's SlotMap merge and the display hole's merge.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationViewportSnapshot, ProjectUiPolicySnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { IconCloseOutline16, IconLogoutOutline16, IconPlusOutline16, relativeTime, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { paneIdentity, ScopeTile } from './ScopeTile.tsx'
import { stateOf } from './WorkbenchPaneHeader.tsx'
import type { createWorkbenchStore } from '../stores.ts'
import css from './Workbench.module.css'

/** Registration-side face: the live viewport snapshot plus its pane actions. */
export interface WorkbenchSidebarInjected {
  hooks: {
    /** Current conversation viewport state (mode, pane order, active pane, ratios). */
    viewport: HostObservable<ConversationViewportSnapshot>
    /** Account scope policy: each row's tile resolves the pane's own steward tone. */
    projectPolicy: HostObservable<ProjectUiPolicySnapshot>
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
 * The roster carries one card per pane; Exit Workbench lives in the footer so
 * the destructive-adjacent action never sits beside pane navigation.
 * @param props - composed slot props (runtime seats, picker store, viewport face, locale).
 * @returns the workbench panel.
 */
export function WorkbenchSidebar({
  useViewport, useSessions, useWorkspaces, useProjectPolicy, actions,
  focusPane, removePane, setPaneRatios, exitWorkbench, renderSlot, t,
}: WorkbenchSidebarProps) {
  const viewport = useViewport(state => state)
  const sessions = useSessions(state => state)
  const workspaces = useWorkspaces(state => state)
  const policy = useProjectPolicy(state => state)
  const paneIds = viewport.mode === 'workbench' ? viewport.paneIds : []
  const now = Date.now()
  const seatsLeft = 4 - paneIds.length
  return (
    <div className={css.sidebarPanel} role="region" aria-label={t('mode')}>
      <div className={css.sidebarHeader}>
        <span className={css.sidebarTitle}>{t('mode')}</span>
      </div>
      <div className={css.sidebarSection}>
        <div className={css.sidebarSectionTitle}>
          <span>{t('panes')}</span>
          <span className={css.sidebarCount}>{paneIds.length}/4</span>
        </div>
        <div className={css.sidebarPanes} role="list" aria-label={t('panes')}>
          {paneIds.length === 0 && <p className={css.sidebarEmpty}>{t('panesEmpty')}</p>}
          {paneIds.map((id, index) => {
            const summary = sessions.byId[id]
            const state = stateOf(summary)
            const status = summary === undefined ? 'notLoaded' : state === 'warning' ? 'waiting' : state === 'ongoing' ? 'running' : 'ready'
            const identity = paneIdentity(id, summary, workspaces, policy, t('personal'), t('untitled'))
            const active = viewport.activePaneId === id
            const attention = summary?.pendingInteraction !== undefined
            const receipt = !active && summary?.completed === true
            const { unit, n } = relativeTime(summary?.updatedAt ?? now, now)
            const ago = unit === 'now' ? t('time.now') : t(`time.${unit}`, { n })
            const workspace = identity.workspaceName === '' ? '' : ` · ${identity.workspaceName}`
            const statusTone = receipt ? 'reply' : state === 'warning' ? 'warn' : undefined
            return (
              <div key={id} className={css.sidebarPaneRow} data-active={active || undefined} data-attention={attention || undefined} role="listitem">
                <button
                  type="button"
                  className={css.sidebarPaneFocus}
                  aria-current={active || undefined}
                  title={t('focusPaneN', { n: index + 1 })}
                  onClick={() => { focusPane(id) }}
                >
                  <span className={css.sidebarPaneIndex} aria-hidden="true">
                    <span className={css.sidebarPaneNum}>{index + 1}</span>
                    <span className={css.sidebarPaneKey}>⌘{index + 1}</span>
                  </span>
                  <ScopeTile name={identity.scopeName} tone={identity.tone} />
                  <span className={css.sidebarPaneText}>
                    <span className={css.sidebarPaneLine}>
                      <span className={css.sidebarPaneTitle}>{identity.title}</span>
                      <span className={css.sidebarPaneAgo}>{ago}</span>
                    </span>
                    <span className={css.sidebarPaneStatus} data-tone={statusTone}>
                      {receipt ? <span className={css.sidebarReplyDot} aria-hidden="true" /> : <StateDot state={state} size={7} />}
                      <span className={css.sidebarPaneStatusWord}>{receipt ? t('newReply') : t(status)}</span>
                      <span aria-hidden="true">·</span>
                      <span className={css.sidebarPaneScope}>{identity.scopeName}{workspace}</span>
                    </span>
                  </span>
                </button>
                <Tooltip label={t('close')} side="bottom" delayMs={500}>
                  <button
                    type="button"
                    className={css.sidebarPaneClose}
                    aria-label={t('close')}
                    onClick={() => { removePane(id) }}
                  >
                    <IconCloseOutline16 />
                  </button>
                </Tooltip>
              </div>
            )
          })}
          <button
            type="button"
            className={css.sidebarAdd}
            disabled={paneIds.length >= 4 || viewport.pendingIdentity === true}
            onClick={() => { actions.openPicker() }}
          >
            <span className={css.sidebarAddPlus} aria-hidden="true"><IconPlusOutline16 /></span>
            <span>{t('add')}</span>
          </button>
          <div className={css.sidebarCapacity}>
            <span>{t('capacityLine', { used: paneIds.length, left: seatsLeft })}</span>
            <button
              type="button"
              className={css.sidebarEqualize}
              disabled={paneIds.length < 2 || viewport.pendingIdentity === true}
              onClick={() => { setPaneRatios(paneIds.map(() => 1)) }}
            >
              {t('equalize')}
            </button>
          </div>
        </div>
      </div>
      <div className={css.sidebarSection}>
        <div className={css.sidebarSectionTitle}><span>{t('display')}</span></div>
        {renderSlot('conversation.workbench.display', {})}
      </div>
      <div className={css.sidebarFooter}>
        <button
          type="button"
          className={css.sidebarExit}
          aria-label={t('exitWorkbench')}
          onClick={exitWorkbench}
        >
          <IconLogoutOutline16 />
          <span>{t('exitWorkbench')}</span>
          <span className={css.sidebarExitHint}>{t('exitHint')}</span>
        </button>
      </div>
    </div>
  )
}
