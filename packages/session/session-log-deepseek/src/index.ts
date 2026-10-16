/**
 * Incremental session-log contribution for official DeepSeek LLM API requests.
 * Accepted sequence watermarks live in the canonical log, so restart recovery
 * can conservatively resend uncertain tails without maintaining another store.
 * @module @deepseek-ai/dsh-session-log-deepseek
 */

import { Buffer } from 'node:buffer'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { isSurfaceEvent, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  JsonValue,
  Session,
  SessionEvent,
  SessionLogOffset as SessionLogOffsetType,
  SessionSeq as SessionSeqType,
  SessionSeqCursor,
} from '@deepseek-ai/dsh-session'
import type {
  DeepSeekSessionLogExtension,
  DeepSeekSessionLogWireEvent,
  DeepSeekSessionLogWireHeader,
} from './types.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'session-log-deepseek'
/** Services required to resolve sessions and contribute the provider request field. */
export const inject = ['deepseekLlmApiExtensions', 'sessions']

/** Session-log request contribution configuration. */
export interface Config {
  /** Contribute `dsh_session_log` to official DeepSeek requests. Defaults to `false`. */
  enabled: Volatile<boolean>
  /** Optional exact endpoint allowlist; an empty list preserves the adapter's configured endpoint. */
  allowedEndpoints: string[]
  /** Environment key whose non-empty value disables new deliveries immediately. */
  killSwitchEnv: string
  /** Emit metadata-only delivery audit records through the host logger. */
  audit: boolean
  /**
   * Largest serialized `dsh_session_log` field, in UTF-8 bytes, that one request carries.
   * A request uploads the longest pending event prefix that fits; later requests continue
   * after its acceptance. Defaults to 8 MiB.
   */
  maxBytes: number
}

/** Validated Session-log request contribution configuration. */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  allowedEndpoints: z.array(z.string()).default([]),
  killSwitchEnv: z.string().default('COHARNESS_DISABLE_SESSION_LOG_UPLOAD'),
  audit: z.boolean().default(true),
  maxBytes: z.number().step(1).min(1).default(8 * 1024 * 1024),
})

interface AcceptanceFold {
  readonly scannedEvents: SessionLogOffsetType
  readonly throughSeq: SessionSeqCursor
}

const acceptanceFolds = new WeakMap<Session, AcceptanceFold>()
/** Per-session sequence of the first pending event that did not fit; warns once each time the boundary moves. */
const blockedWarnings = new WeakMap<Session, number>()

/**
 * UTF-8 length of one value's JSON text as the request body encodes it.
 * @returns `Infinity` when the value fails to serialize, which counts as exceeding every limit.
 */
function jsonBytes(value: DeepSeekSessionLogExtension | DeepSeekSessionLogWireEvent): number {
  let text: string
  try {
    text = JSON.stringify(value)
  } catch (_unserializable) {
    // No request can carry a value that fails to serialize.
    return Number.POSITIVE_INFINITY
  }
  return Buffer.byteLength(text)
}

/** Translate logical Session metadata back to the stable version-0 wire header. */
function wireHeader(session: Session): DeepSeekSessionLogWireHeader {
  const header = session.header
  return {
    version: header.version,
    id: String(header.id),
    createdAt: header.createdAt,
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    ...header.parentSession === undefined ? {} : { parentSession: String(header.parentSession) },
    ...header.isSeeded ? { seedLength: Number(session.inheritedEventCount) } : {},
    ...header.origin === undefined ? {} : { origin: header.origin },
    ...header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth },
    ...header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset },
  }
}

/** Translate compile-time sequence brands to raw numeric request fields. */
function wireEvent(event: SessionEvent): DeepSeekSessionLogWireEvent {
  const surfaceEvent = isSurfaceEvent(event) ? event : undefined
  const surfaceOp = surfaceEvent?.surfaceOp
  return {
    type: event.type,
    seq: Number(event.seq),
    time: event.time,
    data: event.data as JsonValue,
    ...event.ignorable === undefined ? {} : { ignorable: event.ignorable },
    ...surfaceEvent?.sourceEventSeqs === undefined
      ? {}
      : { sourceEventSeqs: surfaceEvent.sourceEventSeqs.map(Number) },
    ...surfaceOp === undefined
      ? {}
      : surfaceOp === 'append'
        ? { surfaceOp }
        : { surfaceOp: { op: 'replace' as const, start: Number(surfaceOp.startSeq), end: Number(surfaceOp.endSeq) } },
  }
}

/**
 * Highest confirmed sequence for this exact session identity.
 * @param session - canonical log whose matching acceptance events are folded.
 * @returns greatest accepted sequence, or `-1` before any accepted request.
 */
export function acceptedThrough(session: Session): SessionSeqCursor {
  const previous = acceptanceFolds.get(session)
  let throughSeq = previous?.throughSeq ?? -1
  const length = session.seq
  const start = previous?.scannedEvents ?? SessionLogOffset(0)
  for (let index = start; index < length; index++) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = session.eventAt(SessionSeq(index))
    if (event === undefined) {
      throw new Error(`session-log-deepseek: missing event ${String(index)} below captured length ${String(length)}`)
    }
    if (event.type !== 'session-log-deepseek/delivery-accepted') continue
    const acceptedFormatVersion = event.data.sessionFormatVersion ?? 0
    if (!Number.isSafeInteger(acceptedFormatVersion)
      || acceptedFormatVersion < 0
      || Object.is(acceptedFormatVersion, -0)) {
      throw new Error(`session-log-deepseek: malformed acceptance format version at seq ${event.seq}`)
    }
    if (acceptedFormatVersion !== session.header.version) continue
    let acceptedSeq: SessionSeqType
    try {
      acceptedSeq = SessionSeq(event.data.throughSeq)
    } catch {
      throw new Error(`session-log-deepseek: malformed acceptance watermark at seq ${event.seq}`)
    }
    if (typeof event.data.sessionId !== 'string' || event.data.sessionId.length === 0
      || acceptedSeq >= event.seq) {
      throw new Error(`session-log-deepseek: malformed acceptance watermark at seq ${event.seq}`)
    }
    if (event.data.sessionId !== session.id) continue
    if (acceptedSeq > throughSeq) throughSeq = acceptedSeq
  }
  acceptanceFolds.set(session, { scannedEvents: length, throughSeq })
  return throughSeq
}

/**
 * Register the incremental `dsh_session_log` request contribution when enabled.
 * @param ctx - plugin context carrying Sessions and the DeepSeek request-extension registry.
 * @param config - validated opt-in configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const endpoints = config.allowedEndpoints.map(endpoint => normalizeEndpoint(endpoint))
  if (endpoints.some(endpoint => endpoint === undefined)) {
    throw new Error('session-log-deepseek: allowedEndpoints must contain absolute http(s) URLs')
  }
  const { killSwitchEnv, audit, maxBytes } = config
  ctx.deepseekLlmApiExtensions.register('dsh_session_log', {
    prepare: (request) => {
      if (!config.enabled.get()) return undefined
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
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const pending = session.snapshotEvents(SessionLogOffset(afterSeq + 1))
      const envelope = {
        version: 1,
        sessionFormatVersion: session.header.version,
        session: wireHeader(session),
        afterSeq: Number(afterSeq),
      } as const
      // Field bytes without events or throughSeq digits; each candidate prefix adds its own.
      let bytes = jsonBytes({ ...envelope, throughSeq: 0, events: [] }) - 1
      const events: DeepSeekSessionLogWireEvent[] = []
      // Field bytes with the last examined event; when none fits, the first event's own field size.
      let candidateBytes = 0
      for (const event of pending) {
        const wire = wireEvent(event)
        const next = bytes + (events.length === 0 ? 0 : 1) + jsonBytes(wire)
        candidateBytes = next + String(event.seq).length
        if (candidateBytes > maxBytes) break
        bytes = next
        events.push(wire)
      }
      const last = events.length === 0 ? undefined : pending[events.length - 1]
      if (last === undefined) {
        const first = pending[0]
        if (first !== undefined && blockedWarnings.get(session) !== first.seq) {
          blockedWarnings.set(session, first.seq)
          const seq = String(first.seq)
          ctx.logger.warn(Number.isFinite(candidateBytes)
            ? `session-log-deepseek: event ${seq} of session "${session.id}" needs a ${String(candidateBytes)}-byte`
              + ` dsh_session_log field, above maxBytes ${String(maxBytes)}; this session's upload stays at event ${seq}`
              + ' until maxBytes admits it'
            : `session-log-deepseek: event ${seq} of session "${session.id}" is too large to serialize into a dsh_session_log field;`
              + ` this session's upload stays at event ${seq}`)
        }
        return undefined
      }
      const throughSeq = last.seq
      const value: DeepSeekSessionLogExtension = { ...envelope, throughSeq: Number(throughSeq), events }
      return {
        value,
        accept: () => {
          session.append('session-log-deepseek/delivery-accepted', {
            sessionId: session.id,
            sessionFormatVersion: session.header.version,
            throughSeq,
          })
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
