/**
 * Incremental session-log contribution for official DeepSeek LLM API requests.
 * Accepted sequence watermarks live in the canonical log, so restart recovery
 * can conservatively resend uncertain tails without maintaining another store.
 * @module @deepseek-ai/dsh-session-log-deepseek
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { DeepSeekSessionLogExtension } from './types.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'session-log-deepseek'
/** Services required to resolve sessions and contribute the provider request field. */
export const inject = ['deepseekLlmApiExtensions', 'sessions']

/** Session-log request contribution configuration. */
export interface Config {
  /** Contribute `dsh_session_log` to official DeepSeek requests. Defaults to `false`. */
  enabled?: boolean
  /** Optional exact endpoint allowlist; an empty list preserves the adapter's configured endpoint. */
  allowedEndpoints?: string[]
  /** Environment key whose non-empty value disables new deliveries immediately. */
  killSwitchEnv?: string
  /** Emit metadata-only delivery audit records through the host logger. */
  audit?: boolean
}

/** Validated Session-log request contribution configuration. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  allowedEndpoints: z.array(z.string()).default([]),
  killSwitchEnv: z.string().default('COHARNESS_DISABLE_SESSION_LOG_UPLOAD'),
  audit: z.boolean().default(true),
})

interface AcceptanceFold {
  readonly scannedEvents: number
  readonly throughSeq: number
}

const acceptanceFolds = new WeakMap<Session, AcceptanceFold>()

/**
 * Highest confirmed sequence for this exact session identity.
 * @param session - canonical log whose matching acceptance events are folded.
 * @returns greatest accepted sequence, or `-1` before any accepted request.
 */
export function acceptedThrough(session: Session): number {
  const previous = acceptanceFolds.get(session)
  let throughSeq = previous?.throughSeq ?? -1
  const events = session.events
  const start = previous?.scannedEvents ?? 0
  for (let index = start; index < events.length; index++) {
    const event = events[index] as SessionEvent
    if (event.type !== 'session-log-deepseek/delivery-accepted') continue
    if (typeof event.data.sessionId !== 'string' || event.data.sessionId.length === 0
      || !Number.isSafeInteger(event.data.throughSeq) || event.data.throughSeq < 0
      || event.data.throughSeq >= event.seq) {
      throw new Error(`session-log-deepseek: malformed acceptance watermark at seq ${event.seq}`)
    }
    if (event.data.sessionId !== session.id) continue
    throughSeq = Math.max(throughSeq, event.data.throughSeq)
  }
  acceptanceFolds.set(session, { scannedEvents: events.length, throughSeq })
  return throughSeq
}

/**
 * Register the incremental `dsh_session_log` request contribution when enabled.
 * @param ctx - plugin context carrying Sessions and the DeepSeek request-extension registry.
 * @param config - validated opt-in configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.enabled !== true) return
  const endpoints = (config.allowedEndpoints ?? []).map(endpoint => normalizeEndpoint(endpoint))
  if (endpoints.some(endpoint => endpoint === undefined)) {
    throw new Error('session-log-deepseek: allowedEndpoints must contain absolute http(s) URLs')
  }
  const killSwitchEnv = config.killSwitchEnv ?? 'COHARNESS_DISABLE_SESSION_LOG_UPLOAD'
  const audit = config.audit !== false
  ctx.deepseekLlmApiExtensions.register('dsh_session_log', {
    prepare: (request) => {
      const killSwitchValue = killSwitchEnv.length > 0 ? process.env[killSwitchEnv] : undefined
      if (killSwitchValue !== undefined && killSwitchValue.length > 0) {
        if (audit) ctx.logger.warn('session-log-deepseek: delivery suppressed by kill switch')
        return undefined
      }
      const endpoint = request.endpoint === undefined ? undefined : normalizeEndpoint(request.endpoint)
      if (endpoint === undefined && request.endpoint !== undefined) {
        if (audit) ctx.logger.warn('session-log-deepseek: delivery suppressed for an invalid endpoint')
        return undefined
      }
      if (endpoints.length > 0 && (endpoint === undefined || !endpoints.includes(endpoint))) {
        if (audit) ctx.logger.warn(`session-log-deepseek: delivery suppressed for endpoint ${endpoint ?? 'unknown'}`)
        return undefined
      }
      // TODO: Define an explicit wire result for direct or stale-session calls if they become a supported product path.
      if (request.sessionId === undefined) return undefined
      const session = ctx.sessions.get(SessionId(request.sessionId))
      if (session === undefined) return undefined

      const afterSeq = acceptedThrough(session)
      const snapshot = session.events
      const throughSeq = snapshot.length - 1
      if (throughSeq < 0) return undefined
      const suffix = snapshot.slice(afterSeq + 1)
      const value: DeepSeekSessionLogExtension = {
        version: 1,
        session: session.header,
        afterSeq,
        throughSeq,
        events: suffix,
      }
      return {
        value,
        accept: () => {
          session.append('session-log-deepseek/delivery-accepted', { sessionId: session.id, throughSeq })
          if (audit) {
            ctx.logger.info(`session-log-deepseek: accepted session ${session.id} through seq ${throughSeq}`)
          }
          // TODO: Add an immediate lightweight checkpoint if duplicate replay after a 2xx crash window becomes unacceptable.
        },
      }
    },
  })
}

function normalizeEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.username.length > 0 || url.password.length > 0) return undefined
    url.hash = ''
    url.search = ''
    url.pathname = url.pathname.replace(/\/+$/u, '') || '/'
    return url.toString()
  } catch {
    return undefined
  }
}
