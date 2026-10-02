// @vitest-environment jsdom
/** The right Sidebar root selects the frame's target and mounts every retained view. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { SessionReference } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SidebarSessionViewSnapshot } from '../src/client/session-views.ts'
import { RightbarRoot } from '../src/client/shell/RightbarRoot.tsx'

const SESSION = 's-root' as SessionId
const OTHER = 's-other' as SessionId

afterEach(cleanup)

function view(sessionId: SessionId, selected: boolean): SidebarSessionViewSnapshot {
  return {
    sessionId,
    reference: { sessionId, release: vi.fn() } as unknown as SessionReference,
    selected,
    retainTab: vi.fn(() => () => {}),
  }
}

function mounted(views: readonly SidebarSessionViewSnapshot[], props: Partial<Parameters<typeof RightbarRoot>[0]> = {}) {
  const selectView = vi.fn()
  const mountView = vi.fn(() => () => {})
  const seen: Array<{ sessionId: string | undefined }> = []
  const renderSlot = vi.fn((_slot: string, owner: { active: boolean }) => (
    <span data-rightbar data-active={owner.active} />
  ))
  const root = render(<RightbarRoot
    SessionProvider={((providerProps: { sessionId?: string; children: () => ReactNode }) => {
      seen.push({ sessionId: providerProps.sessionId })
      return providerProps.children()
    }) as never}
    renderSlot={renderSlot as never}
    useSessions={(<T,>(selector: (state: { current: SessionId | undefined }) => T): T => selector({ current: OTHER })) as never}
    useWorkspaces={vi.fn() as never}
    usePanelInfo={vi.fn() as never}
    useViews={(<T,>(selector: (views: readonly SidebarSessionViewSnapshot[]) => T): T => selector(views))}
    mountView={mountView}
    selectView={selectView}
    width={320} viewportWidth={1280} canShow {...props} />)
  return { root, renderSlot, mountView, selectView, seen }
}

describe('RightbarRoot', () => {
  it('selects the pinned target rather than the current session', () => {
    const { selectView } = mounted([view(SESSION, true)], { targetSessionId: SESSION })
    expect(selectView).toHaveBeenCalledWith(SESSION)
  })

  it('follows the current session while no target is pinned', () => {
    const { selectView } = mounted([view(OTHER, true)])
    expect(selectView).toHaveBeenCalledWith(OTHER)
  })

  it('mounts every published view, hides the unselected, and hands each its own provider target', () => {
    const first = view(SESSION, true)
    const second = view(OTHER, false)
    const { root, renderSlot, mountView, seen } = mounted([first, second], { targetSessionId: SESSION })
    expect(mountView).toHaveBeenCalledWith(first.reference)
    expect(mountView).toHaveBeenCalledWith(second.reference)
    expect(seen.map(entry => entry.sessionId)).toEqual([SESSION, OTHER])
    const selected = root.container.querySelector<HTMLElement>(`[data-sidebar-right-session="${SESSION}"]`)
    const background = root.container.querySelector<HTMLElement>(`[data-sidebar-right-session="${OTHER}"]`)
    expect(selected?.hidden).toBe(false)
    expect(background?.hidden).toBe(true)
    expect(renderSlot).toHaveBeenCalledWith('rightbar.session',
      expect.objectContaining({ active: true, retainTab: first.retainTab, canShow: true, width: 320 }))
    expect(renderSlot).toHaveBeenCalledWith('rightbar.session', expect.objectContaining({ active: false }))
  })

  it('renders nothing while the pool publishes no view', () => {
    const { root } = mounted([])
    expect(root.container.querySelector('[data-sidebar-right-session]')).toBeNull()
  })
})
