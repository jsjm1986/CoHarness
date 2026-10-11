/** Terminal glyphs for the sidebar guide and tab title. */
import type { ReactNode } from 'react'
import { IconTerminalOutline16, type IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Render the tab title's terminal prompt in the surrounding text color.
 * @returns a decorative sixteen-pixel line glyph.
 */
export function TerminalIcon(): ReactNode {
  return <IconTerminalOutline16 aria-hidden="true" />
}

/**
 * Render the guide's terminal card within the folder glyph's painted bounds.
 * @param props - canvas size and layout class supplied by the guide.
 * @returns a dark rounded terminal card with a white prompt.
 */
export function TerminalGuideIcon({ size = 26, className }: IconProps): ReactNode {
  return <svg width={size} height={size} className={className} viewBox="0 0 28 28" fill="none" aria-hidden="true">
    <rect x="3" y="5" width="22" height="19" rx="3" fill="#17191d" />
    <path d="m8 10 4 4-4 4M15 18h5" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}
