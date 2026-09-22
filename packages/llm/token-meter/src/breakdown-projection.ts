/**
 * Pure fold for the heuristic context-composition projection: system prompt
 * and tool schemas from the newest request envelope, conversation from the
 * live surface. Prices with the same shared estimator as the meter service,
 * so the three figures match `measure()`'s heuristic vocabulary exactly.
 */

import { z } from 'zod'
import { canonicalHeader, isReplacementSurfaceEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { estimateSystemMessage, estimateToolsTokens } from './estimate.ts'
import { foldSurfaceProjection } from './surface-projection.ts'
// Import for the `contextBreakdown` SessionProjectionStateMap key merge.
import type {} from './projection.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    contextBreakdown: ContextBreakdownState
  }
}

/** Non-negative integer token count (the shared figure shape). */
const tokenCount = z.number().int().nonnegative()
const sessionSeq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq)

/** The context-breakdown state schema and source of its inferred type. */
const contextBreakdownStateSchema = z.object({
  messageTokens: tokenCount,
  toolsTokens: tokenCount,
  systems: z.array(z.object({
    seq: sessionSeq,
    tokens: tokenCount,
  }).strict()),
  claim: z.object({
    start: sessionSeq,
    end: sessionSeq,
    tokens: tokenCount,
  }).optional(),
}).strict()
type ContextBreakdownState = z.infer<typeof contextBreakdownStateSchema>

const breakdownSchema = z.object({
  systemTokens: tokenCount,
  toolsTokens: tokenCount,
  messageTokens: tokenCount,
}).strict()

/**
 * Token-meter's context-composition projection unit.
 *
 * Envelope figures are last-wins per `request/header`; the non-system message
 * figure rides {@link foldSurfaceProjection} — the same O(1) fold the
 * occupancy projection uses — so compaction shrinks it by its logged shadow
 * price and a replacement without a claim preserves the previous total.
 *
 * System nodes are priced exactly by a small ordered list of live node
 * estimates (`sourceEventSeqs` covers every shadowed node, so any replace —
 * prompt maintenance or a compaction — retires the entries it shadows). The
 * newest nonempty surviving node is the effective prompt and supplies
 * `systemTokens`; superseded in-history nodes stay model-visible and add to
 * the message figure. The list stays bounded by the active system nodes, so
 * the persisted checkpoint stays near-O(1) over the session's life.
 */
export const contextBreakdownProjectionDefinition = {
  key: 'contextBreakdown',
  stateVersion: 3,
  stateSchema: contextBreakdownStateSchema,
  init: (): ContextBreakdownState => ({ messageTokens: 0, toolsTokens: 0, systems: [] }),
  apply: (state, event) => {
    const fold = foldSurfaceProjection(state.claim, event)
    let toolsTokens = state.toolsTokens
    if (event.type === 'request/header') {
      toolsTokens = estimateToolsTokens(canonicalHeader(event.data.header))
    }
    let systems = state.systems
    let messageDelta = event.type === 'system/message' ? 0 : fold.deltaTokens
    const systemWrite = event.type === 'system/message'
    if (isReplacementSurfaceEvent(event) || systemWrite) {
      const covered = new Set<SessionSeq>(
        isReplacementSurfaceEvent(event) ? event.sourceEventSeqs ?? [] : [],
      )
      const firstCovered = systems.findIndex(entry => covered.has(entry.seq))
      if (firstCovered !== -1) {
        let retired = 0
        systems = systems.filter((entry) => {
          if (!covered.has(entry.seq)) return true
          retired += entry.tokens
          return false
        })
        // A non-system replacement conserves the shadowed estimate inside its
        // total (claim-priced or unclaimed-preserved); a system write settles
        // the node exactly instead.
        if (!systemWrite) messageDelta += retired
      }
      if (systemWrite) {
        const tokens = estimateSystemMessage(event.data.message)
        if (tokens > 0) {
          systems = [...systems]
          systems.splice(firstCovered === -1 ? systems.length : firstCovered, 0, { seq: event.seq, tokens })
        }
      }
    }
    if (messageDelta === 0
      && toolsTokens === state.toolsTokens
      && systems === state.systems
      && fold.claim === undefined
      && state.claim === undefined) return state
    return {
      messageTokens: state.messageTokens + messageDelta,
      toolsTokens,
      systems,
      ...fold.claim === undefined ? {} : { claim: fold.claim },
    }
  },
  wire: {
    viewSchema: breakdownSchema,
    view: ({ messageTokens, toolsTokens, systems }) => {
      const last = systems.at(-1)
      const systemTokens = last?.tokens ?? 0
      let superseded = 0
      for (const entry of systems) superseded += entry.tokens
      return {
        systemTokens,
        toolsTokens,
        messageTokens: messageTokens + superseded - systemTokens,
      }
    },
  },
} satisfies ProjectionDefinition<'contextBreakdown', ContextBreakdownState>
