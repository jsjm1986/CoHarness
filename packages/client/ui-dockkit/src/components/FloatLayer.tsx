/**
 * The floating layer: one overlay panel per floating pane, bottom-to-top in the
 * model's z order. A floating pane hosts exactly one tab; its header is the
 * strip's row holding that tab's chip, never selectable or closable from the
 * chip, and the send-back and close controls. Pressing a panel's body raises it. Its grip
 * and corner report through their gesture instead: a press released in place is
 * a click and raises the panel; a drag records the move or resize, and that
 * operation raises the panel itself, so one gesture is one intent. Raising a
 * panel that is active and on top already changes nothing and reports nothing.
 *
 * The layer owns its own drag and resize gestures, so where it mounts is not
 * part of its contract: panels are positioned in viewport coordinates and read
 * only `state` and the outward contracts. An embedder may portal it anywhere,
 * and nothing here assumes the docked tree is an ancestor or even present.
 */
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import clsx from 'clsx'
import { IconCloseOutline16, IconPanelLeftOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DockIntents, DockLabels, TabRenderer } from '../contract/adapter.ts'
import type { FloatRect, LayoutState, PaneId, TabId, TabRecord } from '../contract/types.ts'
import { FLOAT_MIN_SIZE } from '../engine/constraints.ts'
import { movedRect, passedThreshold, resizedRect } from '../engine/geometry.ts'
import { floatRect, getPane, getTab, onlyTabId } from '../engine/tree.ts'
import { useGesture } from './pointer.ts'
import { TabTitle } from './TabTitle.tsx'
import { TabMenu } from './TabMenu.tsx'
import css from './dockkit.module.css'

/** The layout whose `floats` this layer draws. */
export interface FloatLayerProps {
  readonly state: LayoutState
  readonly intents: DockIntents
  readonly labels: DockLabels
  readonly renderTab: TabRenderer
  /** Whether a floating tab offers its close control; defaults to true. Called per tab on every render. */
  readonly canCloseTab?: (tabId: TabId) => boolean
  /** The panel header's title content; omit to show the record's `title` text (see `DockSurfaceProps`). */
  readonly renderTabTitle?: TabRenderer
}

/** A floating-panel gesture: what it moves and where it started. */
interface FloatDrag {
  readonly mode: 'move' | 'resize'
  readonly originX: number
  readonly originY: number
  readonly rect: FloatRect
}

/** The rectangle a gesture has reached. */
function draggedRect(drag: FloatDrag, x: number, y: number): FloatRect {
  const dx = x - drag.originX
  const dy = y - drag.originY
  return drag.mode === 'move'
    ? movedRect(drag.rect, dx, dy)
    : resizedRect(drag.rect, dx, dy, FLOAT_MIN_SIZE)
}

/** Whether two rectangles agree in every coordinate. */
function sameRect(a: FloatRect, b: FloatRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** Whether a floating pane is already where a raise would put it: focused and on top. */
function raised(state: LayoutState, paneId: PaneId): boolean {
  return state.activePaneId === paneId && state.floats.at(-1) === paneId
}

/** Keep the complete header and resize control inside the available viewport. */
function viewportRect(rect: FloatRect): FloatRect {
  const root = document.documentElement
  const windows = root.hasAttribute('data-windows-titlebar')
  const caption = windows && !root.hasAttribute('data-fullscreen')
    ? Number.parseFloat(root.style.getPropertyValue('--dsh-windows-titlebar-height')) : 0
  const top = windows ? caption + 20 : 0
  const viewport = window.visualViewport
  const viewportHeight = viewport == null ? window.innerHeight : viewport.height * viewport.scale
  const width = Math.min(rect.width, window.innerWidth)
  const height = Math.min(rect.height, Math.max(0, viewportHeight - top))
  return { width, height, x: Math.max(0, Math.min(rect.x, window.innerWidth - width)),
    y: Math.max(top, Math.min(rect.y, viewportHeight - height)) }
}

/**
 * Shared move/resize gestures; changing layout mode never owns the content DOM.
 * @param state - committed layout and float stacking order.
 * @param intents - gesture settlements.
 * @returns the current preview and focus/gesture callbacks.
 */
export function useFloatGestures(state: LayoutState, intents: DockIntents) {
  const [preview, setPreview] = useState<{ paneId: PaneId; rect: FloatRect } | undefined>(undefined)
  const begin = useGesture(() => { setPreview(undefined) })
  const dragged = useRef(false)
  const [, resized] = useState(0)
  useEffect(() => {
    const update = (): void => { resized(value => value + 1) }
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    return () => {
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
    }
  }, [])

  const rect = (paneId: PaneId): FloatRect => viewportRect(preview?.paneId === paneId ? preview.rect : floatRect(getPane(state, paneId)))
  const adjust = (mode: FloatDrag['mode'], paneId: PaneId, dx: number, dy: number): void => {
    const previous = rect(paneId)
    const next = viewportRect(mode === 'move' ? movedRect(previous, dx, dy) : resizedRect(previous, dx, dy, FLOAT_MIN_SIZE))
    if (sameRect(previous, next)) return
    if (mode === 'move') intents.moveFloat(paneId, next.x, next.y)
    else intents.resizeFloat(paneId, next)
  }

  /** Focus and raise a panel from a press or click on it, unless it is raised already. */
  const raise = (paneId: PaneId): void => {
    if (raised(state, paneId)) return
    intents.focusPane(paneId)
  }

  /** Start a move or resize from a press on the panel's grip or corner; a release that moved nothing is a click. */
  const drag = (mode: 'move' | 'resize', paneId: PaneId, event: ReactPointerEvent<HTMLElement>): void => {
    // The press stops here: the panel's own press-to-focus would record a focus
    // entry before the drag's, and the release below decides which one it is.
    event.stopPropagation()
    if (event.button !== 0) return
    dragged.current = false
    const start: FloatDrag = { mode, originX: event.clientX, originY: event.clientY, rect: rect(paneId) }
    begin(event.currentTarget, event.pointerId, {
      move: (moved) => {
        if (passedThreshold(start.originX, start.originY, moved.clientX, moved.clientY)) dragged.current = true
        setPreview({ paneId, rect: viewportRect(draggedRect(start, moved.clientX, moved.clientY)) })
      },
      up: (released) => {
        const rect = viewportRect(draggedRect(start, released.clientX, released.clientY))
        if (sameRect(rect, start.rect)) raise(paneId)
        else if (mode === 'move') intents.moveFloat(paneId, rect.x, rect.y)
        else intents.resizeFloat(paneId, rect)
      },
    })
  }

  const consumeDragClick = (): boolean => {
    const suppress = dragged.current
    dragged.current = false
    return suppress
  }
  return { preview, raise, drag, rect, adjust, consumeDragClick }
}

/** A native handle offers arrow keys and a click menu alongside dragging. */
function FloatHandle({ mode, paneId, labels, gestures, children }: {
  readonly mode: FloatDrag['mode']
  readonly paneId: PaneId
  readonly labels: DockLabels
  readonly gestures: ReturnType<typeof useFloatGestures>
  readonly children?: ReactNode
}): ReactNode {
  const [anchor, setAnchor] = useState<HTMLElement | undefined>(undefined)
  const [announcement, setAnnouncement] = useState('')
  const choices = mode === 'move'
    ? ['left', 'right', 'up', 'down'] as const : ['narrower', 'wider', 'shorter', 'taller'] as const
  const delta = (choice: typeof choices[number], step: number): [number, number] => {
    if (choice === 'left' || choice === 'narrower') return [-step, 0]
    if (choice === 'right' || choice === 'wider') return [step, 0]
    return [0, choice === 'up' || choice === 'shorter' ? -step : step]
  }
  return <>
    <button type="button" className={mode === 'move' ? clsx(css.tab, css.floatTitle) : css.floatResize}
      aria-label={mode === 'move' ? labels.moveFloat : labels.resizeFloat} aria-haspopup="menu" aria-expanded={anchor !== undefined}
      data-dockkit-float-grip={mode === 'move' ? paneId : undefined}
      data-dockkit-float-title={mode === 'move' ? true : undefined}
      data-dockkit-float-resize={mode === 'resize' ? paneId : undefined}
      onPointerDown={(event) => { gestures.drag(mode, paneId, event) }}
      onClick={(event) => {
        event.stopPropagation()
        if (gestures.consumeDragClick()) return
        const target = event.currentTarget
        setAnchor(current => current === undefined ? target : undefined)
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
        const index = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(event.key)
        const choice = choices[index]
        if (choice === undefined) return
        event.preventDefault()
        gestures.adjust(mode, paneId, ...delta(choice, event.shiftKey ? 40 : 10))
        setAnnouncement(labels.adjustFloat[choice])
      }}>{children}</button>
    <span role="status" className={css.visuallyHidden}>{announcement}</span>
    {anchor !== undefined && <TabMenu labels={labels} anchor={anchor} onClose={undefined}
      onDismiss={() => { setAnchor(undefined) }} extras={choices.map(choice =>
        <button key={choice} type="button" role="menuitem" className={css.menuItem} onClick={() => {
          gestures.adjust(mode, paneId, ...delta(choice, 40))
          setAnnouncement(labels.adjustFloat[choice])
        }}>{labels.adjustFloat[choice]}</button>)} />}
  </>
}

/** @param props - floating pane and gestures. @returns its keyboard and pointer resize control. */
export function FloatResize(props: {
  readonly paneId: PaneId
  readonly labels: DockLabels
  readonly gestures: ReturnType<typeof useFloatGestures>
}): ReactNode {
  return <FloatHandle {...props} mode="resize" />
}

/**
 * Header-only controls, usable above either retained or visibility-mounted bodies.
 * @param props - owning pane/tab, localized labels and gesture callbacks.
 * @returns the float header without a content container.
 */
export function FloatHeader({ paneId, tab, labels, intents, renderTabTitle, canCloseTab, gestures, onDock }: {
  readonly paneId: PaneId
  readonly tab: TabRecord
  readonly labels: DockLabels
  readonly intents: DockIntents
  readonly renderTabTitle: TabRenderer | undefined
  readonly canCloseTab: ((id: TabId) => boolean) | undefined
  readonly gestures: ReturnType<typeof useFloatGestures>
  readonly onDock?: () => void
}): ReactNode {
  return (
    <header className={clsx(css.tabStrip, css.floatHeader)}>
      <FloatHandle mode="move" paneId={paneId} labels={labels} gestures={gestures}>
        <TabTitle>{renderTabTitle?.(tab) ?? tab.title}</TabTitle>
      </FloatHandle>
      <div className={css.stripFill} />
      <Tooltip label={labels.dockFloat} side="bottom" delayMs={500}>
        <button type="button" className={css.iconButton} aria-label={labels.dockFloat}
          data-dockkit-float-dock={paneId} onPointerDown={(event) => { event.stopPropagation() }}
          onClick={() => { if (onDock === undefined) intents.unfloatPane(paneId); else onDock() }}>
          <IconPanelLeftOutline16 className={css.dockGlyph} />
        </button>
      </Tooltip>
      {(canCloseTab?.(tab.id) ?? true) && (
        <Tooltip label={labels.closeTab} shortcutKeys={labels.closeTabKeys} side="bottom" delayMs={500}>
          <button type="button" className={css.iconButton} aria-label={labels.closeTab}
            data-dockkit-float-close={paneId} onPointerDown={(event) => { event.stopPropagation() }}
            onClick={() => { intents.closeTab(tab.id) }}>
            <IconCloseOutline16 />
          </button>
        </Tooltip>
      )}
    </header>
  )
}

/** Every floating panel, in z order. */
export function FloatLayer({ state, intents, labels, renderTab, renderTabTitle, canCloseTab }: FloatLayerProps): ReactNode {
  const gestures = useFloatGestures(state, intents)
  const { preview, raise } = gestures

  return (
    <>
      {state.floats.map((paneId, depth) => {
        const pane = getPane(state, paneId)
        const tab = getTab(state, onlyTabId(pane))
        // A panel mid-gesture draws where the pointer has taken it and on top,
        // as the operation its release records will leave it.
        const lifted = preview?.paneId === paneId ? preview.rect : undefined
        const live = gestures.rect(paneId)
        return (
          <div
            key={paneId}
            className={css.float}
            data-dockkit-float={paneId}
            tabIndex={-1}
            data-dockkit-float-active={state.activePaneId === paneId || undefined}
            style={{
              left: live.x,
              top: `max(var(--dsh-dockkit-float-top, 0px), ${live.y}px)`,
              width: live.width,
              height: live.height,
              zIndex: lifted === undefined ? depth + 1 : state.floats.length + 1,
            }}
            onPointerDown={() => { raise(paneId) }}
          >
            <FloatHeader {...{ paneId, tab, labels, intents, renderTabTitle, canCloseTab, gestures }} />
            <div className={css.floatBody}>{renderTab(tab)}</div>
            <FloatResize paneId={paneId} labels={labels} gestures={gestures} />
          </div>
        )
      })}
    </>
  )
}
