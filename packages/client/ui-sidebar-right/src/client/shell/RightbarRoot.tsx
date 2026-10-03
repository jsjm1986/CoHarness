/** Root-scoped controller for the right Sidebar's Session content. */
import { useLayoutEffect } from 'react'
import type { ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionReference } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '../contract/slots.ts'
import type { SidebarSessionViewSnapshot } from '../session-views.ts'
import css from './SidebarRight.module.css'

/** Root-only retained Session targets and their committed mount lifetimes. */
export interface RightbarRootInjected {
  readonly hooks: { readonly views: HostObservable<readonly SidebarSessionViewSnapshot[]> }
  /** Claim one root share of a View's mounted lifetime; releases on unmount. */
  readonly mountView: (reference: SessionReference) => () => void
  /** Change the foreground Session; the pool retains held background views. */
  readonly selectView: (sessionId: SessionId | undefined) => void
}

type RootProps = PropsRuntime<'rightbar'> & PropsRenderSlots<'rightbar.session'> & InjectFace<RightbarRootInjected>

function SessionView({ view, SessionProvider, renderSlot, mountView, width, viewportWidth, canShow }:
  Pick<RootProps, 'SessionProvider' | 'renderSlot' | 'mountView' | 'width' | 'viewportWidth' | 'canShow'>
  & { readonly view: SidebarSessionViewSnapshot }): ReactNode {
  useLayoutEffect(() => mountView(view.reference), [mountView, view.reference])
  const active = view.selected
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
 * for a Session; selection follows the Session model otherwise. `selectView`
 * runs in a layout effect so the committed selection the seats render is the
 * one the pool published.
 * @param props - frame geometry, view targets and the authorized Session renderer.
 * @returns the foreground and retained background Sidebars.
 */
export function RightbarRoot({
  SessionProvider, renderSlot, mountView, selectView, useSessions, useViews,
  width, viewportWidth, canShow, targetSessionId,
}: RootProps): ReactNode {
  const views = useViews(value => value)
  const current = useSessions(sessions => sessions.current)
  const target = targetSessionId ?? current
  useLayoutEffect(() => { selectView(target) }, [selectView, target])
  return <>{views.map(view => (
    <SessionView
      key={view.sessionId} view={view}
      SessionProvider={SessionProvider} renderSlot={renderSlot} mountView={mountView}
      width={width} viewportWidth={viewportWidth} canShow={canShow}
    />
  ))}</>
}
