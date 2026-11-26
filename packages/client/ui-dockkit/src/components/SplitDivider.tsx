/** Accessible separator with keyboard resizing and single-click adjustment actions. */
import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import clsx from 'clsx'
import type { SplitNode } from '../contract/types.ts'
import type { PaneCallbacks } from './render.ts'
import { passedThreshold } from '../engine/geometry.ts'
import { TabMenu } from './TabMenu.tsx'
import css from './dockkit.module.css'

/** @param props - split fractions and shared resize intents. @returns one focusable divider. */
export function SplitDivider({ split, sizes, index, callbacks, className, style }: {
  readonly split: SplitNode
  readonly sizes: readonly number[]
  readonly index: number
  readonly callbacks: PaneCallbacks
  readonly className?: string | undefined
  readonly style?: CSSProperties
}): ReactNode {
  const [anchor, setAnchor] = useState<HTMLElement | undefined>(undefined)
  const press = useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined)
  const share = sizes[index] ?? 0
  return <>
    <div className={clsx(css.divider, className)} style={style}
      role="separator" tabIndex={0} aria-label={callbacks.labels.resizePane}
      aria-orientation={split.axis === 'row' ? 'vertical' : 'horizontal'}
      aria-valuemin={Math.round(callbacks.minPaneFraction * 100)}
      aria-valuemax={Math.round((1 - callbacks.minPaneFraction * (sizes.length - 1)) * 100)}
      aria-valuenow={Math.round(share * 100)} data-dockkit-divider={`${split.id}:${index}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        press.current = { x: event.clientX, y: event.clientY, moved: false }
        callbacks.onDividerPressed(split.id, index, event)
      }}
      onPointerMove={(event) => {
        const start = press.current
        if (start !== undefined && passedThreshold(start.x, start.y, event.clientX, event.clientY)) start.moved = true
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (press.current?.moved === true) return
        const target = event.currentTarget
        setAnchor(current => current === undefined ? target : undefined)
      }}
      onKeyDown={(event) => {
        callbacks.onDividerKey(split.id, index, event)
        if (!event.defaultPrevented && !event.nativeEvent.isComposing
          && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
          && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          setAnchor(event.currentTarget)
        }
      }} />
    {anchor !== undefined && <TabMenu labels={callbacks.labels} anchor={anchor} onClose={undefined}
      onDismiss={() => { setAnchor(undefined) }} extras={<>
        <button type="button" role="menuitem" className={css.menuItem}
          onClick={() => { callbacks.onAdjustDivider(split.id, index, 0.1) }}>{callbacks.labels.expandBefore}</button>
        <button type="button" role="menuitem" className={css.menuItem}
          onClick={() => { callbacks.onAdjustDivider(split.id, index, -0.1) }}>{callbacks.labels.expandAfter}</button>
        <button type="button" role="menuitem" className={css.menuItem}
          onClick={() => { callbacks.onAdjustDivider(split.id, index, ((sizes[index + 1] ?? 0) - share) / 2) }}>
          {callbacks.labels.equalPanes}</button>
      </>} />}
  </>
}
