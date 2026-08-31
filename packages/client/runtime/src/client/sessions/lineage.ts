// flattenLineage: summaries -> flat list with lineage indentation (pure function).
// The input order is authoritative; lineage only makes each child adjacent to its parent.
// Orphaned lineage degrades to root level; cycles fail soft and emit as roots.

import type { SessionId, SessionSummary, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { PendingInteractionStatus } from './pending.ts'

/** Host list summary enriched with the latest mux-projected durable title. */
export interface TitledSessionSummary extends SessionSummary {
  title?: string
  /** Client-local Workspace hint for a blank Session before Host attachment. */
  workspaceId?: WorkspaceId
  /** Current host-computed projection values for list consumers. */
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
}

/** One flattened session-list row with lineage depth and live pending interaction. */
export interface SessionListEntry {
  sessionId: SessionId
  title?: string
  updatedAt: number
  running: boolean
  /** No-visible-content bit mirrored from the summary; lists hide blank sessions (filtering stays with the consumer). */
  blank: boolean
  /** Highest visible-content event sequence known to the Host or live stream. */
  visibleContentSeq?: number
  parentSessionId?: SessionId
  /** Coarse durable origin for navigation filtering; not a continuation capability. */
  origin?: 'subagent'
  cwd?: string
  /** Client-local Workspace hint for a blank Session before Host attachment. */
  workspaceId?: WorkspaceId
  /** Agent preset the session's agent was composed from (summary passthrough). */
  agentPreset?: string
  /** Current host-computed projection values for list consumers. */
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
  /** User interaction currently blocking this session, derived from live mux frames. */
  pendingInteraction?: PendingInteractionStatus
  /** Finished running while not selected and not yet opened — the sidebar's green "done" reminder (clears on select or the next run). */
  completed: boolean
  /** Lineage indent depth: root = 0; the UI just multiplies by the indent width. */
  depth: number
}

/** Fixed safety limits for the display-only lineage projection. */
export const MAX_LINEAGE_DEPTH = 256
/** Maximum summary nodes whose child lists the display projection expands. */
export const MAX_LINEAGE_EXPANDED_NODES = 100_000

/** Optional limits for one lineage projection. */
export interface FlattenLineageOptions {
  /** Maximum depth at which child expansion is attempted. */
  readonly maxDepth?: number
  /** Maximum number of summary nodes whose children are expanded. */
  readonly maxExpandedNodes?: number
}

/**
 * Summaries -> flat list with lineage indentation. Root and sibling order
 * follows the established input order; this projection never re-sorts a
 * hydrated list from mutable timestamps.
 * @param summaries - the host's session.list items.
 * @param pendingInteractions - current manager-owned interaction status by session.
 * @param completed - sessions with a pending completion reminder (manager-owned live fact; absent = false).
 * @param options - optional safety limits for depth and child expansion.
 * @returns display rows in render order.
 */
export function flattenLineage(
  summaries: readonly TitledSessionSummary[],
  pendingInteractions?: ReadonlyMap<SessionId, PendingInteractionStatus>,
  completed?: ReadonlySet<SessionId>,
  options: FlattenLineageOptions = {},
): SessionListEntry[] {
  const maxDepth = options.maxDepth ?? MAX_LINEAGE_DEPTH
  const maxExpandedNodes = options.maxExpandedNodes ?? MAX_LINEAGE_EXPANDED_NODES
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) throw new TypeError('maxDepth must be a non-negative safe integer')
  if (!Number.isSafeInteger(maxExpandedNodes) || maxExpandedNodes < 0) {
    throw new TypeError('maxExpandedNodes must be a non-negative safe integer')
  }
  const byId = new Map<SessionId, TitledSessionSummary>()
  for (const s of summaries) byId.set(s.sessionId, s)

  const children = new Map<SessionId, TitledSessionSummary[]>()
  const roots: TitledSessionSummary[] = []
  for (const s of summaries) {
    if (s.parentSessionId !== undefined && byId.has(s.parentSessionId)) {
      const list = children.get(s.parentSessionId) ?? []
      list.push(s)
      children.set(s.parentSessionId, list)
    } else {
      roots.push(s) // root, or an orphan whose parent is absent from summaries (degrade to root, never drop)
    }
  }

  const out: SessionListEntry[] = []
  const visited = new Set<SessionId>()
  const stack: Array<{ readonly summary: TitledSessionSummary; readonly depth: number }> = []
  const pushRoots = (items: readonly TitledSessionSummary[]): void => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const summary = items[index]
      if (summary !== undefined) stack.push({ summary, depth: 0 })
    }
  }
  pushRoots(roots)
  let expandedNodes = 0
  let depthLimitWarned = false
  let expansionLimitWarned = false
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    const { summary: s, depth } = current
    if (visited.has(s.sessionId)) {
      console.warn(`[web-runtime] lineage cycle or duplicate at ${s.sessionId}; skipping repeated row`)
      continue
    }
    visited.add(s.sessionId)
    const pendingInteraction = pendingInteractions?.get(s.sessionId)
    out.push({
      ...s,
      ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
      completed: completed?.has(s.sessionId) ?? false,
      depth,
    })
    const kids = children.get(s.sessionId)
    if (kids === undefined || kids.length === 0) continue
    if (depth >= maxDepth) {
      if (!depthLimitWarned) {
        console.warn(`[web-runtime] lineage depth limit ${String(maxDepth)} reached; remaining descendants emit as roots`)
        depthLimitWarned = true
      }
      continue
    }
    if (expandedNodes >= maxExpandedNodes) {
      if (!expansionLimitWarned) {
        console.warn(`[web-runtime] lineage expansion limit ${String(maxExpandedNodes)} reached; remaining descendants emit as roots`)
        expansionLimitWarned = true
      }
      continue
    }
    expandedNodes += 1
    for (let index = kids.length - 1; index >= 0; index -= 1) {
      const kid = kids[index]
      if (kid !== undefined) stack.push({ summary: kid, depth: depth + 1 })
    }
  }
  // Cycle members (unreachable from any root): emit as roots so no entry is lost.
  for (const s of summaries) {
    if (visited.has(s.sessionId)) continue
    stack.push({ summary: s, depth: 0 })
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined) break
      if (visited.has(current.summary.sessionId)) continue
      const pendingInteraction = pendingInteractions?.get(current.summary.sessionId)
      visited.add(current.summary.sessionId)
      out.push({
        ...current.summary,
        ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
        completed: completed?.has(current.summary.sessionId) ?? false,
        depth: 0,
      })
      const kids = children.get(current.summary.sessionId)
      if (kids?.some(kid => visited.has(kid.sessionId)) === true) {
        console.warn(`[web-runtime] lineage cycle or duplicate at ${current.summary.sessionId}; skipping repeated row`)
      }
    }
  }
  return out
}
