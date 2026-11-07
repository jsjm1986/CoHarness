/** Explicit ownership choices for saved layouts whose Session IDs predate Runtime qualification. */
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkbenchConversation } from './catalog.ts'

/** One original Session identity that cannot be resolved from current metadata alone. */
export interface LegacyWorkbenchIssue {
  readonly sessionId: SessionId
  readonly candidates: readonly WorkbenchConversation[]
}

/** Retained saved layout and its unresolved original identities. */
export interface LegacyWorkbenchRestore {
  readonly workbenchId: string | undefined
  readonly issues: readonly LegacyWorkbenchIssue[]
}

/** View-owned restoration; null explicitly removes a pane reference without deleting its Session. */
export interface WorkbenchRestoreOptions {
  readonly signal?: AbortSignal
  readonly selection?: {
    readonly workbenchId: string | undefined
    readonly owners: Readonly<Partial<Record<SessionId, SessionId | null>>>
  }
}
