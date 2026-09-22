// Information and compacted row icons shared by the trajectory surfaces; each
// surface passes its own pixel size and optional `data-role-icon` marker.

import type { ReactNode } from 'react'

/**
 * Render the information (context) row icon.
 * @param props.size - icon edge in pixels.
 * @param props.roleIcon - optional `data-role-icon` marker for surface styling.
 * @returns the svg element.
 */
export function InformationIcon({ size, roleIcon }: { size: number; roleIcon?: string }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      data-role-icon={roleIcon}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.7" />
      <circle cx="8" cy="5.5" r=".85" fill="currentColor" stroke="none" />
      <path d="M8 7.75v3.4" strokeWidth="1.8" />
    </svg>
  )
}

/**
 * Render the compacted row icon.
 * @param props.size - icon edge in pixels.
 * @param props.roleIcon - optional `data-role-icon` marker for surface styling.
 * @returns the svg element.
 */
export function CompactedIcon({ size, roleIcon }: { size: number; roleIcon?: string }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-role-icon={roleIcon}
      aria-hidden="true"
    >
      <path d="m2.5 2.5 3.75 3.75M3 6.25h3.25V3" />
      <path d="m13.5 2.5-3.75 3.75M13 6.25H9.75V3" />
      <path d="m2.5 13.5 3.75-3.75M3 9.75h3.25V13" />
      <path d="m13.5 13.5-3.75-3.75M13 9.75H9.75V13" />
    </svg>
  )
}
