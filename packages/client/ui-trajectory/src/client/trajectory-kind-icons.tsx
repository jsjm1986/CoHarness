// Information and compacted row icons shared by the trajectory surfaces; each
// surface passes its own pixel size and optional `data-role-icon` marker.

import type { ReactNode } from 'react'
import { IconInfoOutline16, IconMinimizeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Render the information (context) row icon.
 * @param props.size - icon edge in pixels.
 * @param props.roleIcon - optional `data-role-icon` marker for surface styling.
 * @returns the svg element.
 */
export function InformationIcon({ size, roleIcon }: { size: number; roleIcon?: string }): ReactNode {
  return <IconInfoOutline16 size={size} data-role-icon={roleIcon} aria-hidden="true" />
}

/**
 * Render the compacted row icon.
 * @param props.size - icon edge in pixels.
 * @param props.roleIcon - optional `data-role-icon` marker for surface styling.
 * @returns the svg element.
 */
export function CompactedIcon({ size, roleIcon }: { size: number; roleIcon?: string }): ReactNode {
  return <IconMinimizeOutline16 size={size} data-role-icon={roleIcon} aria-hidden="true" />
}
