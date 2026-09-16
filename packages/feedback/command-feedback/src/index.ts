/**
 * Session feedback event plus the human-facing `/feedback` producer. Recording
 * appends one authoritative log-only event and does not start model work. The
 * append is eager but unflushed, so acknowledgement reports that the entry is
 * logged, not that it reached disk.
 * @module @deepseek-ai/dsh-command-feedback
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionTelemetryBackend, SessionTelemetrySharingStatus } from '@deepseek-ai/dsh-session-telemetry'
import type { Session } from '@deepseek-ai/dsh-session'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { FeedbackCategory, FeedbackRecord, SessionFeedbackRecordRequest, SessionFeedbackRecordResult } from './types.ts'

export type * from './types.ts'

/**
 * Every feedback category in the order product surfaces present them; each
 * surface owns its localized labels.
 */
export const FEEDBACK_CATEGORIES = [
  'task-result',
  'instruction-following',
  'product-interaction',
  'service-stability',
  'resource-cost',
  'security-privacy-permission',
  'other',
] as const satisfies readonly FeedbackCategory[]

export const name = 'command-feedback'
export const inject = ['commands']

const USAGE = 'Usage: /feedback <text>'

/** Fail closed when a future sharing status reaches the sentence switch. */
/* v8 ignore next 3 -- only the ignored default arm calls this; the closed union cannot reach it via the public API. */
function assertNever(value: never): never {
  throw new Error(`command-feedback: unsupported sharing status ${JSON.stringify(value)}`)
}

/** The acknowledgement's sharing sentence for a disclosed policy. */
function sharingSentence(sharing: SessionTelemetrySharingStatus): string {
  switch (sharing) {
    case 'full':
      return 'Session sharing is enabled.'
    case 'feedback-only':
      return 'Session sharing is feedback-gated; recording feedback releases the session prefix for sharing.'
    case 'disabled':
      return 'Session sharing is disabled.'
    /* v8 ignore next 2 -- the seam's closed union cannot reach the default; a future status must be given a sentence here. */
    default:
      return assertNever(sharing)
  }
}

/**
 * The sharing disclosure appended to the acknowledgement: the mounted
 * backend's disclosed policy, or a "not configured" notice when no backend
 * is mounted. Read through the plugin context so the command still works
 * when the telemetry service is absent.
 * @param telemetry - the mounted telemetry service, or undefined.
 * @returns one sentence describing this session's sharing policy.
 */
function sharingDisclosure(telemetry: SessionTelemetryBackend | undefined): string {
  if (telemetry === undefined) {
    return 'Session sharing is not configured.'
  }
  return sharingSentence(telemetry.sharing)
}

/**
 * Record feedback independently of any UI trigger. Surrounding whitespace is
 * discarded and a blank text is recorded as absent; an entry with neither
 * text nor category is still recorded.
 * @param session - session the feedback describes.
 * @param entry - human-authored remark and its category.
 */
export function recordFeedback(session: Session, entry: FeedbackRecord): void {
  const text = entry.text?.trim() ?? ''
  session.append('feedback/record', {
    ...(text.length === 0 ? {} : { text }),
    ...(entry.category === undefined ? {} : { category: entry.category }),
  })
}

/**
 * Validate, record, and acknowledge one feedback entry. Returning an error
 * leaves no `feedback/record` event.
 * @param invocation - receiving agent, raw command input, and UI cancellation.
 * @param ctx - plugin context used to read the optional telemetry service.
 * @returns an acknowledgement containing the receiving session and anonymous
 * user ids plus the session-sharing disclosure, or a usage error when no
 * feedback text was supplied.
 */
function executeFeedbackCommand(invocation: CommandInvocation, ctx: Context): CommandResult {
  if (invocation.rawInput.trim().length === 0) {
    return { kind: 'error', text: `Feedback text is required. ${USAGE}` }
  }
  recordFeedback(invocation.agent.session, { text: invocation.rawInput })
  const telemetry = ctx.get('sessionTelemetry')
  return {
    kind: 'success',
    text: `Feedback recorded for session ${invocation.agent.session.id}\nAnonymous user: ${getOrCreateAnonymousUserId()}. ${sharingDisclosure(telemetry)}`,
  }
}

/** Host Remote through which a product surface records a Session-level remark. */
export class SessionFeedbackService extends TypertRemoteService {
  static inject = ['sessions']

  /**
   * @param ctx - Host context carrying the live Session store.
   */
  constructor(ctx: Context) {
    super(ctx, 'sessionFeedback')
  }

  /**
   * Record one remark on a live Session.
   * @param request - target Session plus the optional text and category.
   * @returns the recorded postcondition, or `session-not-found` when no live
   * Session carries the id.
   */
  @Remote('record')
  record(request: SessionFeedbackRecordRequest): Promise<SessionFeedbackRecordResult> {
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      return Promise.resolve({ ok: false, error: { code: 'session-not-found', sessionId: request.sessionId } })
    }
    recordFeedback(session, request)
    return Promise.resolve({ ok: true, value: { recorded: true } })
  }
}

/** Register the global `/feedback` command for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.plugin(SessionFeedbackService)
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-feedback'),
    name: 'feedback',
    description: 'record feedback about this session',
    input: { hint: '<text>' },
    recordInput: false,
    handler: invocation => executeFeedbackCommand(invocation, ctx),
  })
}
