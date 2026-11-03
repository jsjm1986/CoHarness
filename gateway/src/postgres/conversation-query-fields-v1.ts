/** Version-one query fields derived from immutable Session events; free text remains JSON-encoded. @module */

/** PostgreSQL jsonb fields contain no decoded NUL; encoded scalar values are read through native json. */
export interface ConversationQueryFieldsV1 {
  readonly turn?: string
  readonly actorUid?: string
  readonly actorLabelJson?: string
  readonly callId?: string
  readonly argumentsJson?: string
}

/**
 * @param event - parsed durable event, including legacy records.
 * @returns turn, member-attribution and tool-correlation fields; other events yield an empty object.
 */
export function conversationQueryFieldsV1(event: unknown): ConversationQueryFieldsV1 {
  if (typeof event !== 'object' || event === null) return {}
  const value = event as { type?: unknown; data?: unknown }
  if (typeof value.data !== 'object' || value.data === null) return {}
  const data = value.data as { source?: unknown; callId?: unknown; arguments?: unknown; turn?: unknown }
  if (value.type === 'turn/start') {
    return typeof data.turn === 'number' && Number.isSafeInteger(data.turn) && data.turn >= 0 ? { turn: String(data.turn) } : {}
  }
  if (value.type === 'user/message') {
    if (typeof data.source !== 'object' || data.source === null) return {}
    const participant = (data.source as { participant?: unknown }).participant
    if (typeof participant !== 'object' || participant === null) return {}
    const actor = participant as { userId?: unknown; displayName?: unknown; username?: unknown }
    const userId = actor.userId
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) return {}
    const label = typeof actor.displayName === 'string' && actor.displayName !== '' ? actor.displayName : actor.username
    return { actorUid: String(userId), ...(typeof label === 'string' ? { actorLabelJson: JSON.stringify(label) } : {}) }
  }
  if (value.type === 'tool/call' || value.type === 'tool/result') {
    return {
      ...(typeof data.callId === 'string' && !data.callId.includes('\u0000') ? { callId: data.callId } : {}),
      ...(value.type === 'tool/call' && typeof data.arguments === 'string' ? { argumentsJson: JSON.stringify(data.arguments) } : {}),
    }
  }
  return {}
}
