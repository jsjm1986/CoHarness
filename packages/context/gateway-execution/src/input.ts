/** Input digests cover the exact admitted JSON content, independently of display authorship. */
import { createHash } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ExecutionInheritance, ExecutionInputId, ExecutionState } from '@deepseek-ai/dsh-execution-authority/types'

/**
 * Hash the JSON value crossing the input registration operation.
 * @param value - lossless JSON content already validated by its owning parser.
 * @returns the lower-case SHA-256 digest of the serialized value.
 */
export function inputDigest(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (typeof encoded !== 'string') throw new TypeError('execution input must be JSON')
  return createHash('sha256').update(encoded).digest('hex')
}

/**
 * Read an execution reference from durable message metadata.
 * @param message - admitted or restored message.
 * @returns the immutable reference, or absence for input without a Gateway attestation.
 */
export function executionInputOf(message: UserMessage): ExecutionInputId | undefined {
  const value = (message.source as unknown as Record<string, unknown>).gatewayExecutionInput
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError('invalid Gateway execution input reference')
  }
  return value as ExecutionInputId
}

/**
 * Decode a Gateway response or durable authority mirror.
 * @param value - untrusted JSON value.
 * @returns validated identity references; roles are deliberately not accepted as authority.
 */
export function executionState(value: unknown): ExecutionState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('invalid Gateway execution state')
  const row = value as Record<string, unknown>
  if (typeof row.revision !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.revision)
    || !Array.isArray(row.inputs) || !row.inputs.every(id => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    || !Array.isArray(row.actors) || !row.actors.every(actor => typeof actor === 'object' && actor !== null
      && Number.isSafeInteger((actor as { userId?: unknown }).userId) && (actor as { userId: number }).userId > 0)
    || typeof row.unverifiedHistory !== 'boolean'
    || (row.primaryActorUserId !== undefined && (!Number.isSafeInteger(row.primaryActorUserId) || Number(row.primaryActorUserId) <= 0))) {
    throw new TypeError('invalid Gateway execution state')
  }
  const inputs = row.inputs as ExecutionInputId[]
  const actors = (row.actors as { userId: number }[]).map(actor => ({ userId: actor.userId })).sort((a, b) => a.userId - b.userId)
  if (new Set(inputs).size !== inputs.length || new Set(actors.map(actor => actor.userId)).size !== actors.length) {
    throw new TypeError('duplicate Gateway execution identity')
  }
  return {
    revision: row.revision,
    inputs,
    actors,
    ...(row.primaryActorUserId === undefined ? {} : { primaryActorUserId: row.primaryActorUserId as number }),
    unverifiedHistory: row.unverifiedHistory,
  }
}

/**
 * Decode captured delegation or relay metadata at a durable input boundary.
 * @param value - JSON read from the Session log or message metadata.
 * @returns detached references; the Gateway still verifies lineage and ownership.
 */
export function executionScope(value: unknown): ExecutionInheritance {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('invalid Gateway execution scope')
  const row = value as Record<string, unknown>
  if (typeof row.parentSessionId !== 'string' || row.parentSessionId.length === 0
    || !Array.isArray(row.inputs) || !row.inputs.every(id => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    || new Set(row.inputs).size !== row.inputs.length
    || typeof row.unverifiedHistory !== 'boolean'
    || (row.primaryActorUserId !== undefined && (!Number.isSafeInteger(row.primaryActorUserId) || Number(row.primaryActorUserId) <= 0))
    || (row.inputs.length > 0 && row.primaryActorUserId === undefined)
    || (row.inputs.length === 0 && (!row.unverifiedHistory || row.primaryActorUserId !== undefined))) {
    throw new TypeError('invalid Gateway execution scope')
  }
  const inputs = row.inputs as ExecutionInputId[]
  return Object.freeze({
    parentSessionId: row.parentSessionId as SessionId,
    inputs: Object.freeze([...inputs]),
    unverifiedHistory: row.unverifiedHistory,
    ...(row.primaryActorUserId === undefined ? {} : { primaryActorUserId: row.primaryActorUserId as number }),
  })
}

/**
 * Identify durable human or Agent input whose participant constraints are unknown.
 * @param message - restored or newly admitted user message.
 * @returns whether privileged execution must remain unavailable.
 */
export function hasUnverifiedExecutionInput(message: UserMessage): boolean {
  const source = message.source as unknown as Record<string, unknown>
  if (source.gatewayExecutionScope !== undefined) return executionScope(source.gatewayExecutionScope).unverifiedHistory
  return (source.kind === 'user' && executionInputOf(message) === undefined)
    || source.kind === 'agent-message' || source.kind === 'subagent-settled' || source.kind === 'team-message'
}
