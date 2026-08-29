/** Durable per-session state for the user-controlled child model allowlist. */

import type { Session } from '@deepseek-ai/dsh-session'
import { assertAllowedModelRoutes, type AllowedModelRoute } from './model-selection.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact child routes exposed by this Session's delegation tool. */
    'subagent/model-selection-policy': { allowedModels: AllowedModelRoute[] }
  }
}

/** Read a Session's captured child-route policy. */
export function subagentModelSelectionPolicy(session: Session): AllowedModelRoute[] | undefined {
  const event = session.events.find(candidate => candidate.type === 'subagent/model-selection-policy')
  if (event?.type !== 'subagent/model-selection-policy') return undefined
  assertAllowedModelRoutes(event.data.allowedModels)
  if (event.data.allowedModels.length === 0) throw new Error('subagent/model-selection-policy requires at least one route')
  return event.data.allowedModels.map(route => ({ ...route }))
}

/** Capture the route policy once before the first request. */
export function recordSubagentModelSelection(session: Session, allowedModels: readonly AllowedModelRoute[]): void {
  if (subagentModelSelectionPolicy(session) !== undefined) return
  session.append('subagent/model-selection-policy', { allowedModels: allowedModels.map(route => ({ ...route })) })
}
