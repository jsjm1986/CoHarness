/** Remote-desktop glyphs for the sidebar guide. */
import type { ReactNode } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Render the guide's remote-desktop card glyph.
 * @param props - canvas size and layout class supplied by the guide.
 * @returns a dark rounded monitor card with a small desktop landscape.
 */
export function RemoteDesktopGuideIcon({ size = 26, className }: IconProps): ReactNode {
  return <svg width={size} height={size} className={className} viewBox="0 0 28 28" fill="none" aria-hidden="true">
    <rect x="2" y="4" width="24" height="16" rx="3" fill="#17191d" />
    <path d="M6 14l4-3 4 2.5L18 9l4 3.5V16H6Z" fill="#3f5aa8" />
    <circle cx="10" cy="9" r="1.4" fill="#9fb6ea" />
    <rect x="11" y="21" width="6" height="1.6" rx="0.8" fill="#17191d" />
    <rect x="8" y="24" width="12" height="1.4" rx="0.7" fill="#17191d" />
  </svg>
}
