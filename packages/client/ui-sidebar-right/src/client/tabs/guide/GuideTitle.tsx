/**
 * The guide type's chip title: the compass before the type's label. Registered
 * under `sidebar.right.pane.tab.title`; without it the chip would show the
 * bare label. Both guide glyphs live here: the compass the chip and the body's
 * hero draw, and the cube the body's icon-less capsules fall back to.
 */
import type { ReactNode } from 'react'
import { IconBoxOutline16, IconCompassOutline16, type IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './GuideBody.module.css'

/**
 * The compass: a ring with the needle's rhombus pointing north-east, on
 * `currentColor` so each rendering picks its own ink.
 * @param props - rendered size and class.
 * @returns the compass glyph.
 */
export function CompassGlyph({ size = 16, className }: IconProps): ReactNode {
  return <IconCompassOutline16 size={size} className={className} aria-hidden="true" />
}

/**
 * The cube: an isometric box — hexagonal silhouette, the top face's two edges,
 * and the front seam — in straight strokes with softly rounded joins, on
 * `currentColor`. The guide body draws it in a capsule whose type registered
 * no glyph of its own.
 * @param props - rendered size and class.
 * @returns the cube glyph.
 */
export function CubeGlyph({ size = 16, className }: IconProps): ReactNode {
  return <IconBoxOutline16 size={size} className={className} aria-hidden="true" />
}

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook.
 * @returns the compass followed by the tab's title text.
 */
export function GuideTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return (
    <>
      <CompassGlyph className={css.titleIcon} />
      {tab.title}
    </>
  )
}
