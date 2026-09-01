import {
  memo, useEffect, useId, useRef, useState,
  type CSSProperties, type MouseEvent, type PointerEvent,
} from 'react'
import type { TurnNavigationItem } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './TurnNavigator.module.css'

interface TurnNavigatorProps {
  readonly items: readonly TurnNavigationItem[]
  readonly activeTurn: number | null
  /** Turn whose jump is paging history in; its mark pulses. */
  readonly busyTurn?: number | null
  readonly onNavigate: (item: TurnNavigationItem) => void
  readonly t: ChatViewSlotProps['t']
}

const TURN_SPACING_PX = 10
const RAIL_INSET_PX = 6

type TurnPositionStyle = CSSProperties & {
  readonly '--turn-natural-position': string
}

type TurnFrameStyle = CSSProperties & {
  readonly '--turn-natural-height': string
  readonly '--turn-rail-inset': string
  readonly '--turn-scroll-top': string
}

function itemPosition(index: number): TurnPositionStyle {
  return { '--turn-natural-position': `${String(index * TURN_SPACING_PX)}px` }
}

function frameStyle(count: number, scrollTop: number): TurnFrameStyle {
  return {
    '--turn-natural-height': `${String((count - 1) * TURN_SPACING_PX + 2 * RAIL_INSET_PX)}px`,
    '--turn-rail-inset': `${String(RAIL_INSET_PX)}px`,
    '--turn-scroll-top': `${String(scrollTop)}px`,
  }
}

function itemAtPointer(
  items: readonly TurnNavigationItem[],
  frame: HTMLElement,
  scrollTop: number,
  clientY: number,
): TurnNavigationItem | undefined {
  const rect = frame.getBoundingClientRect()
  const offset = clientY - rect.top + scrollTop - RAIL_INSET_PX
  const index = Math.max(0, Math.min(items.length - 1, Math.round(offset / TURN_SPACING_PX)))
  return items[index]
}

interface RailScrollState {
  readonly top: number
  readonly canScrollUp: boolean
  readonly canScrollDown: boolean
}

const RAIL_AT_REST: RailScrollState = { top: 0, canScrollUp: false, canScrollDown: false }

function railScrollState(scroller: HTMLElement): RailScrollState {
  const top = scroller.scrollTop
  return {
    top,
    canScrollUp: top > 1,
    canScrollDown: top < scroller.scrollHeight - scroller.clientHeight - 1,
  }
}

function sameRailScrollState(left: RailScrollState, right: RailScrollState): boolean {
  return left.top === right.top
    && left.canScrollUp === right.canScrollUp
    && left.canScrollDown === right.canScrollDown
}

function TurnNavigatorRail({ items, activeTurn, busyTurn = null, onNavigate, t }: TurnNavigatorProps) {
  const [previewTurn, setPreviewTurn] = useState<number | null>(null)
  const [scrollState, setScrollState] = useState<RailScrollState>(RAIL_AT_REST)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const pointerInsideRef = useRef(false)
  const previewId = useId()

  const syncScrollState = (): void => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    const next = railScrollState(scroller)
    setScrollState(current => sameRailScrollState(current, next) ? current : next)
  }

  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(syncScrollState)
    observer.observe(scroller)
    return () => { observer.disconnect() }
  }, [])
  useEffect(syncScrollState, [items.length])

  // Keep the active marker reachable when the fixed-pitch ladder overflows.
  useEffect(() => {
    const scroller = scrollerRef.current
    const index = items.findIndex(item => item.turn === activeTurn)
    if (scroller === null || index < 0 || pointerInsideRef.current) return
    const markTop = index * TURN_SPACING_PX + RAIL_INSET_PX
    const viewTop = scroller.scrollTop
    const viewHeight = scroller.clientHeight
    if (viewHeight <= 0 || (markTop >= viewTop + 24 && markTop <= viewTop + viewHeight - 24)) return
    const target = Math.max(0, markTop - viewHeight / 2)
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: target, behavior: reduced ? 'auto' : 'smooth' })
    else scroller.scrollTop = target
    syncScrollState()
  }, [activeTurn, items])

  if (items.length < 2) return null
  const previewIndex = items.findIndex(item => item.turn === previewTurn)
  const preview = previewIndex < 0 ? undefined : items[previewIndex]
  const previewPosition = previewIndex < 0 ? undefined : itemPosition(previewIndex)
  const previewAtPointer = (event: PointerEvent<HTMLElement>): void => {
    setPreviewTurn(itemAtPointer(items, event.currentTarget, scrollerRef.current?.scrollTop ?? 0, event.clientY)?.turn ?? null)
  }
  const navigateAtPointer = (event: MouseEvent<HTMLElement>): void => {
    const item = itemAtPointer(items, event.currentTarget, scrollerRef.current?.scrollTop ?? 0, event.clientY)
    if (item !== undefined) onNavigate(item)
  }
  const fadeClasses = [css.scroller]
  if (scrollState.canScrollUp) fadeClasses.push(css.fadeTop)
  if (scrollState.canScrollDown) fadeClasses.push(css.fadeBottom)
  return (
    <div className={css.slot} data-turn-navigator="">
      <nav
        className={css.frame}
        style={frameStyle(items.length, scrollState.top)}
        aria-label={t('chat.turnNavigation.label')}
        onClick={navigateAtPointer}
        onPointerMove={previewAtPointer}
        onPointerEnter={() => { pointerInsideRef.current = true }}
        onPointerLeave={() => {
          pointerInsideRef.current = false
          setPreviewTurn(null)
        }}
      >
        <div
          ref={scrollerRef}
          className={fadeClasses.join(' ')}
          onScroll={() => { syncScrollState() }}
        >
          <div className={css.marks}>
            {items.map((item, index) => {
              const active = item.turn === activeTurn
              const showingPreview = item.turn === previewTurn
              const classes = [css.mark]
              if (item.loaded === false || item.anchorKey === '') classes.push(css.markIndexed)
              if (active) classes.push(css.markActive)
              else if (showingPreview) classes.push(css.markPreview)
              if (item.turn === busyTurn) classes.push(css.markBusy)
              return (
                <div key={item.turn} className={css.markPosition} style={itemPosition(index)}>
                  <button
                    type="button"
                    className={classes.join(' ')}
                    aria-label={t('chat.turnNavigation.jump', { turn: item.turn })}
                    aria-current={active ? 'true' : undefined}
                    aria-describedby={showingPreview ? previewId : undefined}
                    onClick={(event) => {
                      event.stopPropagation()
                      onNavigate(item)
                    }}
                    onFocus={() => { setPreviewTurn(item.turn) }}
                    onBlur={() => { setPreviewTurn(null) }}
                  />
                </div>
              )
            })}
          </div>
        </div>
        {preview !== undefined && previewPosition !== undefined && (
          <div id={previewId} role="tooltip" className={css.preview} style={previewPosition}>
            <div className={css.previewPrompt}>{preview.prompt || t('chat.turnNavigation.turn', { turn: preview.turn })}</div>
            {preview.response !== '' && <div className={css.previewResponse}>{preview.response}</div>}
          </div>
        )}
      </nav>
    </div>
  )
}

/** Compact rail for loaded Turns with keyboard, pointer, and preview support. */
export const TurnNavigator = memo(TurnNavigatorRail)
