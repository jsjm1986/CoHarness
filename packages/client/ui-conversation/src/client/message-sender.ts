/** Project-participant labels for user and steering Chat bubbles. */

/** Participant label projected from durable message source metadata. */
export interface MessageSender {
  readonly name: string
  readonly admin: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

/**
 * Project a Chat sender label from durable `user/message` source metadata.
 * @param source - message source recorded on the conversation node.
 * @returns display name and admin flag, or undefined when absent.
 */
export function messageSender(source: unknown): MessageSender | undefined {
  const participant = record(record(source)?.participant)
  if (participant === undefined) return undefined
  const name = trimmed(participant.displayName) ?? trimmed(participant.username)
  if (name === undefined) return undefined
  return { name, admin: participant.role === 'admin' }
}

/**
 * Detect the durable model-visible attribution notice preceding a project message.
 * @param source - message source recorded on the conversation node or event.
 * @returns true when Chat must omit the notice from the transcript.
 */
export function isCollaborationAttributionNotice(source: unknown): boolean {
  const candidate = record(source)
  return candidate?.kind === 'plugin'
    && candidate.plugin === 'collaboration-context'
    && candidate.form === 'notice'
}
