/** Root-scoped controller for the right Sidebar's Session content. */
import { useLayoutEffect } from 'react'
import type { ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationViewportSnapshot, SessionReference } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '../contract/slots.ts'
import type { SidebarSessionViewSnapshot } from '../session-views.ts'
import css from './SidebarRight.module.css'

/** Root-only retained Session targets and their committed mount lifetimes. */
export interface RightbarRootInjected {
  readonly hooks: {
    readonly views: HostObservable<readonly SidebarSessionViewSnapshot[]>
    readonly viewport: HostObservable<ConversationViewportSnapshot>
  }
  /** Claim one root share of a View's mounted lifetime; releases on unmount. */
  readonly mountView: (reference: SessionReference) => () => void
  /** Change the foreground Session; the pool retains held background views. */
  readonly selectView: (sessionId: SessionId | undefined) => void
}

type RootProps = PropsRuntime<'rightbar'> & PropsRenderSlots<'rightbar.session'> & InjectFace<RightbarRootInjected>

function SessionView({ view, active, SessionProvider, renderSlot, mountView, width, viewportWidth, canShow }:
  Pick<RootProps, 'SessionProvider' | 'renderSlot' | 'mountView' | 'width' | 'viewportWidth' | 'canShow'>
  & { readonly view: SidebarSessionViewSnapshot; readonly active: boolean }): ReactNode {
  useLayoutEffect(() => mountView(view.reference), [mountView, view.reference])
  return <div className={css.session} hidden={!active} aria-hidden={!active || undefined} data-sidebar-right-session={view.sessionId}>
    <SessionProvider sessionId={view.sessionId}>
      {() => renderSlot('rightbar.session', { width, viewportWidth, canShow, active, retainTab: view.retainTab })}
    </SessionProvider>
  </div>
}

/**
 * Keep independent Session subtrees and hide those outside the selected Conversation.
 *
 * The frame's `targetSessionId` pin wins while a conversation-bound open asked
 * for a Session. Automatic selection follows the Session model after it agrees
 * with the active workbench pane. Retained views remain mounted while inactive.
 * @param props - frame geometry, view targets and the authorized Session renderer.
 * @returns the foreground and retained background Sidebars.
 */
export function RightbarRoot({
  SessionProvider, renderSlot, mountView, selectView, useSessions, useViews, useViewport,
  width, viewportWidth, canShow, targetSessionId,
}: RootProps): ReactNode {
  const views = useViews(value => value)
  const current = useSessions(sessions => sessions.current)
  const viewport = useViewport(value => value)
  const followsCurrent = viewport.mode !== 'workbench'
    || (viewport.pendingIdentity !== true && viewport.activePaneId === current)
  const target = targetSessionId ?? (followsCurrent ? current : undefined)
  useLayoutEffect(() => { selectView(target) }, [selectView, target])
  return <>{views.map(view => (
    <SessionView
      key={view.sessionId} view={view} active={view.selected && view.sessionId === target}
      SessionProvider={SessionProvider} renderSlot={renderSlot} mountView={mountView}
      width={width} viewportWidth={viewportWidth} canShow={canShow}
    />
  ))}</>
}
