/**
 * OpenTelemetry Service Provider for the DeepSeek Harness telemetry capability.
 *
 * Composes a `LoggerProvider` with the package's byte/count-bounded processor
 * and an OTLP/HTTP log exporter — and maps each record handed over by the
 * capture coordinator onto `logger.emit()`. The processor measures every
 * record once through the SDK's request serializer and packs requests
 * greedily under the collector's uncompressed byte ceiling
 * (`maxRequestBytes`, at most {@link TELEMETRY_MAX_REQUEST_BYTES}); one HTTP
 * request owns the transport slot until settlement. This package also owns
 * capture mode and an outer shutdown deadline: at that deadline queued
 * records are dropped and every tracked transport agent is destroyed.
 *
 * @module @deepseek-ai/dsh-session-telemetry-otel
 */

import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-command-feedback'
import type {} from '@deepseek-ai/dsh-message-feedback'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  SessionTelemetryBackend,
  SessionTelemetryCoordinator,
  type SessionTelemetrySink,
  type SessionTelemetryRecord,
  type SessionTelemetrySeverity,
  type SessionTelemetrySharingStatus,
} from '@deepseek-ai/dsh-session-telemetry'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { LoggerProvider } from '@opentelemetry/sdk-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import type { OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base'
import { httpAgentFactoryFromOptions } from '@opentelemetry/otlp-exporter-base/node-http'
import type { Agent as HttpAgent } from 'node:http'
import type { Agent as HttpsAgent } from 'node:https'
import { SeverityNumber, type AnyValue } from '@opentelemetry/api-logs'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  ByteBoundedLogProcessor,
  resolveTelemetryLimits,
  resolveTelemetryProcessorConfig,
  type TelemetryProcessorOptions,
} from './processor.ts'

// The package's own manifest is the single source of the instrumentation-scope
// version (same pattern as dsh-llm's attribution identity).
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

type TransportAgent = HttpAgent | HttpsAgent
/** Same signature as the SDK's `HttpAgentFactory`, which the package does not re-export. */
type TransportAgentFactory = (protocol: string) => TransportAgent | Promise<TransportAgent>

/**
 * Wrap the SDK's `agentFactory` selection — function verbatim, options object
 * merged over `keepAlive`, SDK default `keepAlive: true` — so every agent the
 * transport creates also lands in {@link track} for the shutdown deadline.
 * The transport invokes the factory once per protocol and caches the result.
 * @param config - the verbatim `exporter` config object, guaranteed defined by the `url` validation.
 * @param track - set receiving every created agent.
 * @returns the `httpAgentOptions` factory handed to the exporter.
 */
function trackedAgentFactory(config: OTLPExporterNodeConfigBase, track: Set<TransportAgent>): TransportAgentFactory {
  let options = config.httpAgentOptions
  if (config.keepAlive !== undefined && typeof options !== 'function') options = { keepAlive: config.keepAlive, ...options }
  const delegate: TransportAgentFactory = typeof options === 'function'
    ? options
    : httpAgentFactoryFromOptions(options ?? { keepAlive: true })
  return async (protocol) => {
    const agent = await delegate(protocol)
    track.add(agent)
    return agent
  }
}


/** Session-sharing policy selected by {@link Config.mode}. */
export enum SessionTelemetryMode {
  FEEDBACK_ONLY = 'FEEDBACK_ONLY',
  DISABLED = 'DISABLED',
}

/** Default session-sharing policy for schema and direct construction. */
export const DEFAULT_TELEMETRY_MODE = SessionTelemetryMode.FEEDBACK_ONLY

const DISABLED_FEEDBACK_WARNING = 'OpenTelemetry session upload is DISABLED; this feedback is not uploaded through OpenTelemetry'
const NON_CANONICAL_EVENT_WARNING = 'session telemetry ignored an event absent from the canonical session log'

/** Only this Session's explicit feedback authorizes replay; fork seeds do not. */
function isFeedback(session: Session, event: SessionEvent): boolean {
  if (event.seq < session.inheritedEventCount) return false
  switch (event.type) {
    case 'feedback/record': return true
    case 'feedback/message-put':
    case 'feedback/message-delete': return event.data.sessionId === session.id
    default: return false
  }
}

/** Resolve the default and reject unknown runtime values before transport setup. */
function resolveMode(mode: SessionTelemetryMode | undefined): SessionTelemetryMode {
  const resolved = mode ?? DEFAULT_TELEMETRY_MODE
  switch (resolved) {
    case SessionTelemetryMode.FEEDBACK_ONLY:
    case SessionTelemetryMode.DISABLED:
      return resolved
    default:
      return assertNever(resolved)
  }
}

/** Fail closed when direct construction bypasses the runtime config schema. */
function assertNever(value: never): never {
  throw new Error(`session-telemetry-otel: unsupported mode ${JSON.stringify(value)}`)
}

/** Map the serialized mode onto the seam's backend-independent sharing vocabulary. */
function sharingStatusFor(mode: SessionTelemetryMode): SessionTelemetrySharingStatus {
  switch (mode) {
    case SessionTelemetryMode.FEEDBACK_ONLY: return 'feedback-only'
    case SessionTelemetryMode.DISABLED: return 'disabled'
    /* v8 ignore next 2 -- resolveMode already rejected unknown values before this switch; the closed enum cannot reach the default. */
    default: return assertNever(mode)
  }
}

/**
 * Plugin configuration: one sharing policy, two verbatim SDK option objects,
 * and one DSH-owned shutdown bound. Uploading modes validate their endpoint
 * and shutdown deadline at plugin load; `DISABLED` reads neither.
 */
export interface Config {
  /** Defaults to `FEEDBACK_ONLY`: capture session history only when feedback is explicitly submitted. */
  mode?: SessionTelemetryMode
  /**
   * Passed verbatim to the SDK's OTLP/HTTP log exporter — the
   * `OTLPExporterNodeConfigBase` shape (`headers`, `timeoutMillis`,
   * `compression`, `keepAlive`, …) minus self-observability metering, which
   * no owning MeterProvider exists to consume. `url` is the one field this
   * package requires and validates itself.

   */
  exporter?: Omit<OTLPExporterNodeConfigBase, 'selfObsMeterProvider'> & {

    /** Full logs endpoint (e.g. `https://collector.example.com/v1/logs`). Required outside `DISABLED`; validated at load. */
    url?: string
  }
  /**
   * Count, queue, cadence, and per-request watchdog settings for the
   * byte-bounded processor (minus the exporter slot, which this plugin
   * fills, and self-observability metering, which no owning MeterProvider
   * exists to consume). A watchdog warning never releases an unsettled
   * transport slot.

   */
  processor?: TelemetryProcessorOptions

  /** Uncompressed OTLP request byte limit, at most 4,000,000. */
  maxRequestBytes?: number
  /** Maximum time spent awaiting the SDK provider's complete shutdown path. */
  shutdownTimeoutMillis?: number
}

/**
 * Schemastery validator for {@link Config}; cordis runs it before the plugin
 * starts. It checks only the top-level fields; value checks live in the constructor
 * so their errors name the fields. Both SDK option objects pass through unchanged:
 * the SDK defines and validates their fields. Re-declaring them here would
 * silently drop every field this plugin did not repeat.

 */
export const Config: z<Config> = z.object({
  mode: z.union(Object.values(SessionTelemetryMode)).default(DEFAULT_TELEMETRY_MODE),
  exporter: z.any(),
  processor: z.any(),
  maxRequestBytes: z.number(),
  shutdownTimeoutMillis: z.number(),
})

/** Default outer allowance for the SDK's complete shutdown sequence. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MILLIS = 3_000

// Node clamps larger timer delays to one millisecond. This is a runtime
// protocol limit, not a deployment default.
const MAX_TIMER_DELAY_MILLIS = 2_147_483_647

/** Severity mapping from the Service Definition's three-level vocabulary to OTel severity numbers. */
const SEVERITY: Record<SessionTelemetrySeverity, { severityNumber: SeverityNumber; severityText: string }> = {
  info: { severityNumber: SeverityNumber.INFO, severityText: 'INFO' },
  warn: { severityNumber: SeverityNumber.WARN, severityText: 'WARN' },
  error: { severityNumber: SeverityNumber.ERROR, severityText: 'ERROR' },
}

/**
 * The backend plugin — the only entry a deployment loads. It always registers
 * the `sessionTelemetry` service (duplicate load throws). `FEEDBACK_ONLY` wires the SDK
 * pipeline and on-demand {@link SessionTelemetryCoordinator}; `DISABLED` constructs no
 * SDK state and listens only to warn when recorded feedback stays local.
 */
export class OpenTelemetrySessionBackend extends SessionTelemetryBackend {
  static inject = ['sessions']
  static Config = Config

  private readonly provider: LoggerProvider | undefined
  private readonly processor: ByteBoundedLogProcessor | undefined
  private readonly shutdownTimeoutMillis: number
  /**
   * Agents the transport created through the tracking factory, at most one
   * per protocol. The SDK never destroys them itself — its transport
   * `shutdown()` is a no-op — so this set is the only handle the shutdown
   * deadline has on sockets a hung export still holds.
   */
  private readonly transportAgents = new Set<HttpAgent | HttpsAgent>()
  override readonly sharing: SessionTelemetrySharingStatus

  constructor(ctx: Context, config: Config) {
    const mode = resolveMode(config.mode)
    super(ctx)
    this.sharing = sharingStatusFor(mode)
    if (mode === SessionTelemetryMode.DISABLED) {
      this.provider = undefined
      this.processor = undefined
      this.shutdownTimeoutMillis = DEFAULT_SHUTDOWN_TIMEOUT_MILLIS
      ctx.on('session/event', (session, event) => {
        if (isFeedback(session, event)) ctx.logger.warn(DISABLED_FEEDBACK_WARNING)
      })
      return
    }

    const exporter = config.exporter
    const url = exporter?.url
    if (exporter === undefined || url === undefined || url.length === 0) {
      throw new Error('session-telemetry-otel: exporter.url is required (the full OTLP logs endpoint)')
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      // Re-thrown as a config error: the only way here is a malformed url string.
      throw new Error(`session-telemetry-otel: exporter.url is not a valid URL: ${JSON.stringify(url)}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`session-telemetry-otel: exporter.url must be http(s), got ${parsed.protocol}`)
    }
    const requestLimit = resolveTelemetryLimits({
      ...(config.maxRequestBytes === undefined ? {} : { maxRequestBytes: config.maxRequestBytes }),
      ...(config.processor === undefined ? {} : { processor: config.processor }),
    })
    const shutdownTimeoutMillis = config.shutdownTimeoutMillis ?? DEFAULT_SHUTDOWN_TIMEOUT_MILLIS
    if (!Number.isFinite(shutdownTimeoutMillis) || shutdownTimeoutMillis <= 0 || shutdownTimeoutMillis > MAX_TIMER_DELAY_MILLIS) {
      throw new Error(`session-telemetry-otel: shutdownTimeoutMillis must be a positive finite number no greater than ${MAX_TIMER_DELAY_MILLIS}, got ${String(shutdownTimeoutMillis)}`)
    }
    this.shutdownTimeoutMillis = shutdownTimeoutMillis
    this.processor = new ByteBoundedLogProcessor(
      // The complete validated exporter object, verbatim: every SDK
      // option (`timeoutMillis`, `compression`, `keepAlive`, …) reaches
      // the exporter — rebuilding selected fields here would silently
      // ignore the rest. App identity travels in the Resource
      // (service.name/version); the transport-level user-agent is the
      // SDK's own, per the axiom.
      new OTLPLogExporter({
        ...exporter,
        httpAgentOptions: trackedAgentFactory(exporter, this.transportAgents),
      }),
      requestLimit,
      resolveTelemetryProcessorConfig(config.processor),
      (message, error) => { ctx.logger.warn(message, error) },
    )
    this.provider = new LoggerProvider({
      resource: resourceFromAttributes({
        'service.name': APP_IDENTITY.product,
        'service.version': APP_IDENTITY.version,
        // OTel semconv's standard user attribute, carried once per export
        // batch on the Resource rather than per record: the collector
        // aggregates by Resource, and the id is process-stable anyway.
        'user.id': getOrCreateAnonymousUserId(),
      }),
      processors: [this.processor],
    })
    const ledger = this.provider.getLogger('@deepseek-ai/dsh-session-telemetry-otel', version)
    const enqueue: SessionTelemetrySink['emit'] = (record) => {
      ledger.emit({
        timestamp: record.time,
        observedTimestamp: record.time,
        ...SEVERITY[record.severity],
        // JSON-serializable by the seam's contract (validated at Session.append),
        // which is exactly the AnyValue subset.
        body: record.body as AnyValue,
        attributes: record.attributes,
      })
    }
    const backend: SessionTelemetrySink = {
      emit: enqueue,
      shutdown: () => this.shutdown(),
    }
    const coordinator = new SessionTelemetryCoordinator(ctx, backend, {
      capture: 'on-demand',
      includeHistory: true,
    })
    ctx.on('session/event', (session, event) => {
      if (!isFeedback(session, event)) return
      // Only the canonical appended event authorizes this exact prefix.
      if (session.eventAt(event.seq) !== event) {
        ctx.logger.warn(NON_CANONICAL_EVENT_WARNING)
        return
      }
      coordinator.captureSession(session, event.seq)
    })
  }

  /**
   * Drop direct records. Only a new canonical feedback submission can authorize
   * capture through the private coordinator sink, for every provider.
   * @param _record - the direct record, never uploaded.
   */
  emit(_record: SessionTelemetryRecord): void {}

  // The Service Definition's optional flush() hint is deliberately NOT implemented. The
  // batch processor exports on its own cadence (`processor.scheduledDelayMillis`,
  // the SDK's documented knob), and this backend is the SDK pipeline's only
  // caller — forwarding the hint to `forceFlush()` would be the sole source of
  // concurrent flushes, whose undocumented interactions with shutdown's
  // internal drain (concurrent-flush guard, provider-level flush timeout)
  // silently drop tail records. Rationale and the revival trigger: the
  // revival Agent Note.

  /**
   * Ask the SDK to drain and quiesce, but reject after the backend-owned
   * deadline. The processor's export watchdog warns without releasing an
   * unsettled transport slot; shutdown awaits `exporter.forceFlush()` first,
   * which can remain pending when the transport never obtains a socket. At
   * the deadline the queued records are dropped and every tracked transport
   * agent is destroyed: this fails the in-flight request instead of leaving
   * it pending behind the rejection, and on success releases idle keepAlive
   * sockets the SDK's no-op transport shutdown never closes. The provider
   * promise remains observed after the deadline so a later rejection cannot
   * become unhandled. `DISABLED` has no provider and resolves immediately.
   * @returns resolves when the SDK pipeline quiesces or is disabled, or rejects at the configured deadline.
   */
  async shutdown(): Promise<void> {
    if (this.provider === undefined) return
    const providerShutdown = this.provider.shutdown()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.processor?.stopPending()
        reject(new Error(`session-telemetry-otel: provider shutdown exceeded ${this.shutdownTimeoutMillis}ms`))
      }, this.shutdownTimeoutMillis)
    })
    try {
      await Promise.race([providerShutdown, deadline])
    } finally {
      /* v8 ignore else -- the Promise executor assigns timer synchronously before this race starts. */
      if (timer !== undefined) clearTimeout(timer)
      for (const agent of this.transportAgents) agent.destroy()
    }
  }
}

export default OpenTelemetrySessionBackend
