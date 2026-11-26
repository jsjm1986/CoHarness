/**
 * Shell frame, registered into the built-in 'root' slot (the web shell
 * renders only 'root'). One frame, three viewport modes (viewport.ts):
 * expanded/wide keep the three grid columns (sidebar | center | details),
 * the drag handles (pointer capture + rAF throttle), and the concession
 * chain (columns.ts); medium keeps the rail-or-squeezed sidebar column but
 * lifts details into a right-edge overlay above the center; compact renders
 * a single column under a shell topbar, with the sidebar as a left drawer
 * and details as a full-frame overlay, both scrim-dismissed. Slots stay
 * mounted across open/close inside one mode (overlays hide by transform);
 * crossing a mode boundary may re-seat the sidebar and details subtrees.
 * The sidebar slot renders with live parameters from the mode decision, and
 * the session-aware occupants render in fixed positions; strict entries gate
 * themselves on current-session availability while session-maybe entries
 * retain identity. Pure component: everything arrives through the framework
 * shares — zero cordis or framework imports, zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { holdInert, IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  clampWidth, computeColumns, DETAILS_DEFAULT_RATIO, DETAILS_MAX_RATIO, DETAILS_MIN, SIDEBAR_DEFAULT,
} from './columns.ts'
import { isShortCompactViewport, viewportClassOf } from './viewport.ts'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share + locale seat. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'main' | 'rightbar' | 'shell.bottom' | 'shell.overlay' | 'shell.mobile.header.context' | 'shell.mobile.header.title' | 'shell.mobile.header.actions'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & PropsLocale<'layout'>
  & { dismissRightbar: () => void }

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/**
 * Details column grid item: a track, not a box. The column never clips — the
 * panel shell anchors a fixed-width surface to the column's right edge (the
 * frame's edge, which never moves) and slides it off-edge while closed, so a
 * conceding track never crops the panel into a strip. The track only decides
 * whether the center makes room.
 */
function DetailsColumn(props: { children?: ReactNode; fullscreen: boolean }) {
  return <div className={css.detailsCol} data-fullscreen={props.fullscreen || undefined}>{props.children}</div>
}

/**
 * One 8px resize strip centered on a column border. `left` is the track edge;
 * for details the stylesheet shifts the strip the column inset's width onto
 * the floating panel's left border. Pointer capture keeps the gesture on the
 * strip; moves are rAF-batched into a single width write per frame; `side`
 * keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: { side: 'sidebar' | 'details'; left: number; onStart: () => void; onDrag: (dx: number) => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag }

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
  }, [])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

/** The mode-switching shell frame (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
  SessionProvider,
  t,
  dismissRightbar,
}: AppFrameProps) {
  const panels = useStore(s => s)
  const detailsSession = useSessions((s) => {
    const current = panels.detailsSessionId ?? s.current
    return current !== undefined && s.byId[current] !== undefined ? current : undefined
  })
  const currentSession = useSessions(s => s.current)
  const currentTitle = useSessions((s) => {
    const current = s.current
    if (current === undefined) return undefined
    const summary = s.byId[current]
    return summary?.blank === false ? summary.displayTitle : undefined
  })
  const frameRef = useRef<HTMLDivElement | null>(null)
  const topbarToggleRef = useRef<HTMLButtonElement | null>(null)
  const drawerWasOpen = useRef(false)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight)
  const mode = viewportClassOf(viewport)
  const shortCompact = isShortCompactViewport(viewport, viewportHeight)
  // compact and medium lift details out of the grid into an overlay; the
  // sidebar column survives into medium (rail or squeezed-open) while
  // compact re-seats it as the drawer.
  const overlayPanels = mode === 'compact' || mode === 'medium'

  // Compact session navigation dismisses the drawer: tapping a session in it
  // must land on the conversation, not stay under the still-open drawer.
  const modeRef = useRef(mode)
  modeRef.current = mode
  const lastNavigation = useRef(currentSession)
  useEffect(() => {
    if (lastNavigation.current === currentSession) return
    lastNavigation.current = currentSession
    if (modeRef.current === 'compact') actions.collapseNarrow()
  }, [actions, currentSession])

  // Shrinking INTO compact drops the narrow override: a medium squeeze-open
  // sidebar must not reappear as the modal drawer blocking the content
  // (narrow itself does not flip across that boundary, so setNarrow cannot).
  const lastMode = useRef(mode)
  useEffect(() => {
    if (lastMode.current === mode) return
    const entered = mode === 'compact' && lastMode.current !== 'compact'
    lastMode.current = mode
    if (entered) actions.collapseNarrow()
  }, [actions, mode])

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  // The store mirror feeds the ratio-based actions (details drag clamps,
  // narrow toggle semantics) the measured width rather than window.innerWidth.
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const rect = el.getBoundingClientRect()
        if (rect.width > 0) {
          setViewport(rect.width)
          actions.setViewportWidth(rect.width)
          if (rect.height > 0) setViewportHeight(rect.height)
        }
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [actions])

  // Narrow viewports (compact + medium) auto-collapse the sidebar; the store
  // mirror keeps toggleSidebar's semantics right (narrow toggles flip the
  // manual open override, stores.ts). Collapsed is decided here, so the
  // solver stays breakpoint-free: a medium re-expand passes the preference
  // (or the default when the wide preference is closed) and the center
  // absorbs the squeeze, while compact renders the override as the drawer.
  const narrow = overlayPanels
  const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar
  // The details preference stays null until the user drags; while unset the
  // resolved width tracks the live viewport ratio. The resolution feeds both
  // the overlay width and the track solve, and an overlay's ceiling is the
  // same viewport-ratio clamp the drag enforces.
  const detailsPreference = panels.details ?? viewport * DETAILS_DEFAULT_RATIO
  const detailsOverlayWidth = Math.min(
    viewport,
    clampWidth(detailsPreference, DETAILS_MIN, Math.max(DETAILS_MIN, viewport * DETAILS_MAX_RATIO)),
  )
  // Overlay modes keep details out of the track solve (the chain would
  // auto-close it against the narrow width); its open state is the overlay's.
  const rightbarTrack = overlayPanels || detailsSession === undefined || !panels.rightbarTrack ? 0 : detailsPreference
  const cols = computeColumns(viewport, sidebarPreference, rightbarTrack)
  const colsRef = useRef(cols)
  colsRef.current = cols
  // The rightbar occupant reads its would-be width even while closed, so the
  // mounted-but-hidden panel lays out against the width it will open at.
  const normal = computeColumns(viewport, sidebarPreference, detailsPreference)
  const drawerOpen = mode === 'compact' && panels.narrowExpanded
  const detailsOpen = overlayPanels && detailsSession !== undefined && panels.rightbarShown
  const detailsRendered = overlayPanels ? (detailsOpen ? detailsOverlayWidth : 0) : cols.details

  useEffect(() => {
    if (narrow && panels.narrowExpanded && panels.rightbarShown) dismissRightbar()
  }, [narrow, panels.narrowExpanded, panels.rightbarShown, dismissRightbar])

  // The shell owns the two mobile/medium overlay surfaces, so Escape is a
  // shell action only when a nested menu/dialog does not own the gesture.
  // Nested surfaces register their own document listeners and keep their
  // focus inside a menu or dialog; closing the drawer underneath them would
  // otherwise make an Escape press feel like two back steps.
  useEffect(() => {
    if (!drawerOpen && !detailsOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target
      if (target instanceof Element
        && target.closest('[role="dialog"], [role="menu"], [role="listbox"]') !== null) return
      event.preventDefault()
      if (detailsOpen) dismissRightbar()
      else actions.collapseNarrow()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [actions, detailsOpen, drawerOpen, dismissRightbar])

  // Navigation from the drawer can close it without another pointer gesture
  // (session selection, scrim tap, or Escape). Return focus to the persistent
  // topbar control so keyboard and switch-control users never lose their
  // place in the shell.
  useEffect(() => {
    if (drawerWasOpen.current && !drawerOpen) {
      topbarToggleRef.current?.focus({ preventScroll: true })
    }
    drawerWasOpen.current = drawerOpen
  }, [drawerOpen])

  // Phone drawers are swipe-driven surfaces: a rightward edge-swipe opens
  // and a leftward drag on the open drawer closes, both finger-tracking.
  // The listeners are native — React binds touch handlers passive, and the
  // gesture needs preventDefault to win against the drawer's own vertical
  // scroll once horizontal intent shows.
  const drawerEl = useRef<HTMLDivElement | null>(null)
  const scrimEl = useRef<HTMLDivElement | null>(null)
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  useLayoutEffect(() => {
    const drawer = drawerEl.current
    if (mode !== 'compact' || drawerOpen || drawer === null) return
    return holdInert(drawer)
  }, [mode, drawerOpen])
  useEffect(() => {
    if (mode !== 'compact') return
    const drawer = drawerEl.current
    const scrim = scrimEl.current
    const frame = frameRef.current
    if (drawer === null || scrim === null || frame === null) return
    interface Swipe {
      kind: 'open' | 'close'
      x0: number
      y0: number
      t0: number
      lastDx: number
      phase: 'pending' | 'claimed' | 'engaged'
      width: number
    }
    let swipe: Swipe | null = null
    let finishTransition: (() => void) | undefined
    const clearInline = () => {
      drawer.style.transform = ''
      drawer.style.visibility = ''
      drawer.style.transition = ''
      scrim.style.opacity = ''
      scrim.style.transition = ''
    }
    /* End the gesture on the stylesheet transition rather than snapping:
       inline overrides carry the panel from its dragged spot to the target,
       then clear so the [data-open] rules own the steady state. */
    const settle = (opened: boolean, width: number) => {
      finishTransition?.()
      drawer.style.transition = ''
      scrim.style.transition = ''
      let finished = false
      const done = () => {
        if (finished) return
        finished = true
        window.clearTimeout(timer)
        drawer.removeEventListener('transitionend', done)
        finishTransition = undefined
        clearInline()
      }
      finishTransition = done
      drawer.addEventListener('transitionend', done)
      const timer = window.setTimeout(done, 400)
      if (opened) {
        drawer.style.visibility = 'visible'
        drawer.style.transform = 'translateX(0)'
        scrim.style.opacity = '1'
      } else {
        drawer.style.transform = `translateX(${-width}px)`
        drawer.style.visibility = ''
        scrim.style.opacity = '0'
      }
    }
    const cancel = () => {
      swipe = null
      finishTransition?.()
      clearInline()
    }
    const start = (event: TouchEvent) => {
      cancel()
      const t = event.touches[0]
      if (t === undefined || event.touches.length !== 1) return
      if (!drawerOpen) {
        const offset = t.clientX - frame.getBoundingClientRect().left
        if (offset < 0 || offset >= 24) return
        if (event.target instanceof Element && event.target.closest(
          'button, a[href], input, select, textarea, label, summary, [role="button"], [role="link"], ' +
          '[contenteditable]:not([contenteditable="false"])',
        ) !== null) return
      }
      swipe = { kind: drawerOpen ? 'close' : 'open', x0: t.clientX, y0: t.clientY, t0: performance.now(), lastDx: 0,
        phase: 'pending', width: drawer.offsetWidth || 300 }
    }
    const move = (event: TouchEvent) => {
      const s = swipe
      const t = event.touches[0]
      if (s === null || t === undefined) return
      if (event.touches.length !== 1 || !event.cancelable) { cancel(); return }
      const dx = t.clientX - s.x0
      const dy = t.clientY - s.y0
      const distance = s.kind === 'open' ? dx : -dx
      if (s.phase === 'pending') {
        if (dx === 0 && dy === 0) return
        if (distance <= Math.abs(dy)) {
          swipe = null
          return
        }
        s.phase = 'claimed'
      }
      // The browser may make later moves uncancellable after an unprevented first move.
      // Reserve horizontal input before the 12px visual threshold without cancelling taps at touchstart.
      event.preventDefault()
      if (s.phase === 'claimed') {
        if (distance <= 12) return
        s.phase = 'engaged'
        drawer.style.transition = 'none'
        scrim.style.transition = 'none'
      }
      s.lastDx = dx
      if (s.kind === 'open') {
        const slid = Math.min(dx, s.width)
        drawer.style.visibility = 'visible'
        drawer.style.transform = `translateX(${slid - s.width}px)`
        scrim.style.opacity = String(Math.max(0, slid / s.width))
      } else {
        const slid = Math.min(0, dx)
        drawer.style.transform = `translateX(${slid}px)`
        scrim.style.opacity = String(Math.max(0, 1 + slid / s.width))
      }
    }
    const finish = () => {
      const s = swipe
      swipe = null
      if (s === null || s.phase !== 'engaged') return
      const velocity = s.lastDx / Math.max(1, performance.now() - s.t0)
      const passed = s.kind === 'open'
        ? s.lastDx > s.width * 0.3 || velocity > 0.35
        : s.lastDx < -s.width * 0.3 || velocity < -0.35
      const opened = s.kind === 'open' ? passed : !passed
      settle(opened, s.width)
      if (opened && s.kind === 'open') actionsRef.current.toggleSidebar()
      if (!opened && s.kind === 'close') actionsRef.current.collapseNarrow()
    }
    const surface = drawerOpen ? drawer : frame
    const capture = !drawerOpen
    surface.addEventListener('touchstart', start, { passive: true, capture })
    surface.addEventListener('touchmove', move, { passive: false, capture })
    surface.addEventListener('touchend', finish, capture)
    surface.addEventListener('touchcancel', cancel, capture)
    return () => {
      surface.removeEventListener('touchstart', start, capture)
      surface.removeEventListener('touchmove', move, capture)
      surface.removeEventListener('touchend', finish, capture)
      surface.removeEventListener('touchcancel', cancel, capture)
      cancel()
    }
  }, [mode, drawerOpen])

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped or overlay-rendered panel must not jump back to the
  // stored preference); it stays frozen for the whole gesture so dx deltas
  // do not compound.
  const sidebarBase = useRef(0)
  const detailsBase = useRef(0)
  const detailsRenderedRef = useRef(detailsRendered)
  detailsRenderedRef.current = detailsRendered
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar }, [])
  const onDetailsStart = useCallback(() => { detailsBase.current = detailsRenderedRef.current }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onDetailsDrag = useCallback((dx: number) => {
    actions.setDetails(detailsBase.current - dx)
  }, [actions])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      // The compact template is CSS-owned (topbar row + single column); the
      // wider modes drive their column tracks from the mode decision here.
      style={mode === 'compact'
        ? undefined
        : {
          gridTemplateColumns: overlayPanels
            ? `${cols.sidebar}px minmax(0, 1fr)`
            : `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px`,
        }}
      data-viewport={mode}
      data-viewport-short={shortCompact || undefined}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={(overlayPanels ? !detailsOpen : cols.details === 0) || undefined}
    >
      {mode === 'compact' && (
        <div className={css.topbar}>
          {/* The compact mode has no rail, so the shell owns the drawer
              affordance; ui-sidebar's own toggle serves the wider modes. */}
          <button
            ref={topbarToggleRef}
            type="button"
            className={css.topbarToggle}
            aria-label={drawerOpen ? t('drawer.close') : t('drawer.open')}
            aria-expanded={drawerOpen}
            onClick={() => { actions.toggleSidebar() }}
          >
            <IconPanelLeftOutline16 />
          </button>
          <div className={css.topbarContext} data-mobile-app-header>
            <span className={css.topbarTitle} data-mobile-page-title
              title={panels.panelInfo.activePanelId === null ? currentTitle ?? t('app.title') : undefined}>
              {panels.panelInfo.activePanelId === null
                ? currentTitle ?? t('app.title')
                : renderSlot('shell.mobile.header.title', {}, {
                  entryKey: panels.panelInfo.activePanelId,
                  fallback: t('app.title'),
                })}
            </span>
            <div className={css.topbarEnvironment}>
              {renderSlot('shell.mobile.header.context', { compact: true })}
            </div>
          </div>
          <div className={css.topbarActions} data-mobile-session-actions>
            <SessionProvider empty={() => null}>
              {() => renderSlot('shell.mobile.header.actions', {})}
            </SessionProvider>
          </div>
        </div>
      )}
      {mode === 'compact' && (
        <div
          ref={scrimEl}
          className={css.scrim}
          data-open={drawerOpen || undefined}
          aria-hidden
          onClick={() => { actions.collapseNarrow() }}
        />
      )}
      {/* One sidebar owner preserves open portals and drafts across viewport modes. */}
      <div ref={drawerEl} className={mode === 'compact' ? css.drawer : css.sidebarCol} data-open={drawerOpen || undefined}>
        {renderSlot('sidebar', {
          collapsed: mode === 'compact' ? false : sidebarCollapsed,
          // Match the drawer's min(82%, 300px) width, including narrow phones.
          width: mode === 'compact'
            ? viewport > 0 ? Math.min(Math.round(viewport * 0.82), 300) : SIDEBAR_DEFAULT
            : cols.sidebar,
        })}
      </div>
      {/* The center column is keyed between the Conversation and any
          registered global panel; details use the selected Session unless an
          explicit pane action pins their target. */}
      <CenterColumn>
        {mode !== 'compact' && sidebarCollapsed && <div className={css.railEnvironment}>
          {renderSlot('shell.mobile.header.context', { compact: false })}
        </div>}
        {renderSlot('main', { compact: mode === 'compact' }, {
          entryKey: panels.panelInfo.activePanelId ?? 'conversation',
        })}
      </CenterColumn>
      {overlayPanels && <div className={css.scrim} data-open={detailsOpen || undefined} aria-hidden onClick={dismissRightbar} />}
      <DetailsColumn fullscreen={panels.rightbarFullscreen}>
        {renderSlot('rightbar', {
          width: overlayPanels ? detailsOverlayWidth : normal.details,
          viewportWidth: viewport,
          canShow: overlayPanels || normal.details > 0,
          ...(panels.detailsSessionId === undefined ? {} : { targetSessionId: panels.detailsSessionId }),
        })}
      </DetailsColumn>
      <div className={css.bottomRow} data-shell-bottom>
        {renderSlot('shell.bottom', {})}
      </div>
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {/* The collapsed rail is fixed-width and the compact drawer is not a
          column: resize handles belong to the wider modes only. */}
      {mode !== 'compact' && !sidebarCollapsed && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} />}
      {detailsRendered > 0 && !panels.rightbarFullscreen && <DragHandle side="details" left={viewport - detailsRendered} onStart={onDetailsStart} onDrag={onDetailsDrag} />}
    </div>
  )
}
