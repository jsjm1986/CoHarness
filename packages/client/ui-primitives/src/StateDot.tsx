import clsx from 'clsx'
import css from './StateDot.module.css'
import { IconCheckOutline16 } from './icons/index.tsx'

/**
 * State semantic: green done / amber user-attention / blue running C matrix /
 * red error / grey idle for a tracked subject with nothing in progress.
 */
export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'

/**
 * C letterform on a 5x5 pixel grid, cells ordered along the arc from the
 * upper-right opening to the lower-right so the chase follows the stroke.
 */
const C_PIXELS: ReadonlyArray<readonly [number, number]> = [
  [4, 1], [3, 0], [2, 0], [1, 0], [0, 1], [0, 2],
  [0, 3], [1, 4], [2, 4], [3, 4], [4, 3],
]

/**
 * Render a state dot.
 * @param props.state - which of `done`, `warning`, `ongoing`, `error`, or `idle` to show.
 * @param props.size - outer diameter in px (default 10, the figma size).
 * @param props.className - extra class for layout placement.
 * @param props.appearance - compact dot by default; step uses a filled check or hollow pending circle.
 * @returns the dot element (aria-hidden; pair with text for accessibility).
 */
export function StateDot({ state, size = 10, className, appearance = 'dot' }: {
  state: StateDotState
  size?: number | undefined
  className?: string | undefined
  appearance?: 'dot' | 'step'
}) {
  if (state === 'ongoing') {
    return (
      <svg
        className={clsx(css.mark, className)}
        data-state="ongoing"
        width={size}
        height={size}
        viewBox="0 0 20 20"
        shapeRendering="crispEdges"
        aria-hidden="true"
      >
        {C_PIXELS.map(([x, y], i) => (
          <rect
            key={i}
            className={css.pixel}
            x={x * 4 + 0.5}
            y={y * 4 + 0.5}
            width={3}
            height={3}
            style={{ animationDelay: `${(i - C_PIXELS.length) * 100}ms` }}
          />
        ))}
      </svg>
    )
  }
  return (
    <span
      className={clsx(appearance === 'step' ? css.step : css.dot, className)}
      data-state={state}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >{appearance === 'step' && state === 'done' && <IconCheckOutline16 size={size - 2} />}</span>
  )
}
