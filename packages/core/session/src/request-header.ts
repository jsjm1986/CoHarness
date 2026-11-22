/**
 * Request-header reconstruction utilities over full `request/header` session
 * events. Anyone holding a session log reconstructs the {@link EpochHeader}
 * any request was built under by taking the latest canonical snapshot; the
 * loop uses the same equality helper to avoid logging unchanged headers.
 *
 * @module dsh-session/request-header
 */

import { callConfigEquals } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { EpochHeader, SessionEvent } from './types.ts'

/**
 * Normalize a header to canonical form: an empty tool list becomes an absent
 * field, matching how requests are built. Logging, folding, and comparison use
 * this one representation.
 * @param header - the header to normalize (not mutated).
 * @returns the canonical header.
 */
export function canonicalHeader(header: EpochHeader): EpochHeader {
  const adapterDefaults = header.adapterDefaults
  return {
    config: header.config,
    ...adapterDefaults?.reasoningEffort === true || adapterDefaults?.maxTokens === true
      ? { adapterDefaults }
      : {},
    ...header.tools !== undefined && header.tools.length > 0 ? { tools: header.tools } : {},
  }
}

/**
 * Compare lossless JSON tool schemas in serialization order without encoding their text.
 * @param a - one tool schema.
 * @param b - the other tool schema.
 * @returns whether both schemas have identical structure and property order.
 */
export function sameToolSchema(a: ToolSchema, b: ToolSchema): boolean {
  const pending: Array<readonly [unknown, unknown]> = [[a, b]]
  const visited = new WeakSet<object>()
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [left, right] = pair
    if (left === right) continue
    if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false
    const leftArray = Array.isArray(left)
    if (leftArray !== Array.isArray(right)) return false
    if (leftArray) {
      if (left.length !== (right as unknown[]).length) return false
    } else {
      const leftPrototype: unknown = Object.getPrototypeOf(left)
      const rightPrototype: unknown = Object.getPrototypeOf(right)
      if ((leftPrototype !== Object.prototype && leftPrototype !== null)
        || (rightPrototype !== Object.prototype && rightPrototype !== null)) {
        return JSON.stringify(a) === JSON.stringify(b)
      }
    }
    // The canonical snapshot has no repeated nodes. Preserve serialization for a shared noncanonical graph.
    if (visited.has(left)) return JSON.stringify(a) === JSON.stringify(b)
    visited.add(left)
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    let index = 0
    for (const key of leftKeys) {
      if (key !== rightKeys[index++]) return false
      const leftValue = (left as Record<string, unknown>)[key]
      const rightValue = (right as Record<string, unknown>)[key]
      if (leftValue !== rightValue) pending.push([leftValue, rightValue])
    }
  }
  return true
}

/**
 * Field-wise equality over canonical headers. Tool schemas use lossless JSON
 * values and compare both tool order and object property order.
 * @param a - one canonical header.
 * @param b - the other.
 * @returns whether config and tools all match.
 */
export function headerEquals(a: EpochHeader, b: EpochHeader): boolean {
  if (
    !callConfigEquals(a.config, b.config)
    || a.adapterDefaults?.reasoningEffort !== b.adapterDefaults?.reasoningEffort
    || a.adapterDefaults?.maxTokens !== b.adapterDefaults?.maxTokens
  ) return false
  const at = a.tools ?? []
  const bt = b.tools ?? []
  return at.length === bt.length && at.every((tool, i) => sameToolSchema(tool, bt[i] as ToolSchema))
}

/**
 * Fold the header events of a log (or any prefix) into the
 * {@link EpochHeader} in force after the last snapshot. Non-header events are
 * skipped. This is the pure offline reconstruction path; the live session
 * tracks the same fold incrementally.
 * @param events - session events in log order.
 * @param from - a previously folded state to continue from.
 * @returns the latest canonical header, or undefined when none exists yet.
 */
export function foldRequestHeader(events: readonly SessionEvent[], from?: EpochHeader): EpochHeader | undefined {
  let state = from
  for (const event of events) {
    if (event.type === 'request/header') state = canonicalHeader(event.data.header)
  }
  return state
}
