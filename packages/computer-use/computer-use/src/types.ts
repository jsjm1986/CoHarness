/** Browser-safe desktop confirmation data; no Host service declarations. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Live coordinator occupancy of the addressed desktop resource. */
export interface DesktopOccupancy {
  /** The resource accepts new work; `unavailable` blocks every caller. */
  available: boolean
  /** Some root workflow currently holds or is settling the exclusive grant. */
  inUse: boolean
  /** The held grant belongs to this confirmation's root Session. */
  heldByThisSession: boolean
  /** Acquisitions queued behind the current holder. */
  queued: number
}

/** Current interactive user's confirmation for one node-local root workflow. */
export interface DesktopConfirmation {
  rootSessionId: SessionId
  nodeId: string
  desktop: string
  userId: number
  eligible: boolean
  confirmed: boolean
  occupancy: DesktopOccupancy
}
