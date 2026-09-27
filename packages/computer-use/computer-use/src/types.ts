/** Browser-safe desktop confirmation data; no Host service declarations. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Current interactive user's confirmation for one node-local root workflow. */
export interface DesktopConfirmation {
  rootSessionId: SessionId
  nodeId: string
  desktop: string
  userId: number
  eligible: boolean
  confirmed: boolean
}
