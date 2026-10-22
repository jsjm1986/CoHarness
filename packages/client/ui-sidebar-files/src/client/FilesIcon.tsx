/** File-tree glyphs for the sidebar guide and tab title. */
import type { ReactNode } from 'react'
import { IconWorkspaceTreeOutline16, type IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Render the tab title's folder tree in the surrounding text color.
 * @returns a decorative sixteen-pixel line glyph.
 */
export function FilesIcon(): ReactNode {
  return <IconWorkspaceTreeOutline16 aria-hidden="true" />
}

/**
 * Render the guide's folder card with a document row.
 * @param props - canvas size and layout class supplied by the guide.
 * @returns a dark rounded folder card with a document outline.
 */
export function FilesGuideIcon({ size = 26, className }: IconProps): ReactNode {
  return <svg width={size} height={size} className={className} viewBox="0 0 28 28" fill="none" aria-hidden="true">
    <rect x="3" y="6" width="22" height="17" rx="3" fill="#17191d" />
    <path d="M7 9.5h5l1.5 2H21" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9 15h10M9 18h7" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
}
