/**
 * Byte- and count-bounded log scheduling for the telemetry OTLP channel.
 *
 * The SDK's `BatchLogRecordProcessor` counts records but cannot bound bytes:
 * a Session event's serialized size is known only after UTF-8 encoding and
 * JSON escaping. This processor measures each record once through the SDK's
 * own request serializer — including the resource/scope envelope — and packs
 * requests greedily under the collector's uncompressed byte ceiling. One HTTP
 * request owns the transport slot until settlement, even after its watchdog
 * fires; the backend's outer shutdown deadline is what abandons the queue.
 *
 * @module @deepseek-ai/dsh-session-telemetry-otel/processor
 */

import { ExportResultCode } from '@opentelemetry/core'
import { JsonLogsSerializer } from '@opentelemetry/otlp-transformer'
import type {
  BatchLogRecordProcessorOptions,
  LogRecordExporter,
  LogRecordProcessor,
  SdkLogRecord,
} from '@opentelemetry/sdk-logs'

/** Collector request ceiling in uncompressed UTF-8 bytes, including the OTLP envelope. */
export const TELEMETRY_MAX_REQUEST_BYTES = 4_000_000

/**
 * Count, queue, cadence, and per-request watchdog knobs accepted by
 * {@link ByteBoundedLogProcessor}. The exporter slot belongs to the owning
 * pipeline, and `selfObsMeterProvider` is excluded because this processor
 * implements no self-observability metering.
 */
export type TelemetryProcessorOptions = Omit<BatchLogRecordProcessorOptions, 'exporter' | 'selfObsMeterProvider'>

/** Diagnostic hook for rejected records and transport failures; content is never reported. */
export type TelemetryWarn = (message: string, error?: Error) => void

/** Byte and queue settings validated before constructing the SDK pipeline. */
export interface TelemetryLimitOptions {
  /** May lower, but never exceed, the collector's {@link TELEMETRY_MAX_REQUEST_BYTES} limit. */
  maxRequestBytes?: number
  /** Queue settings; defaults track the SDK's documented batch-processor values. */
  processor?: TelemetryProcessorOptions
}

/**
 * Validate byte and queue settings before constructing an SDK pipeline.
 * @param options - limits supplied by the owning configuration.
 * @returns the resolved collector request limit.
 */
export function resolveTelemetryLimits(options: TelemetryLimitOptions): number {
  const limit = options.maxRequestBytes ?? TELEMETRY_MAX_REQUEST_BYTES
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TELEMETRY_MAX_REQUEST_BYTES) {
    throw new Error(`session-telemetry-otel: maxRequestBytes must be an integer between 1 and ${TELEMETRY_MAX_REQUEST_BYTES}`)
  }
  for (const key of ['maxQueueSize', 'maxExportBatchSize', 'scheduledDelayMillis', 'exportTimeoutMillis'] as const) {
    const value = options.processor?.[key]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)) {
      throw new Error(`session-telemetry-otel: processor.${key} must be a positive integer no greater than 2147483647`)
    }
  }
  const queue = options.processor?.maxQueueSize ?? 2048
  const batch = options.processor?.maxExportBatchSize ?? 512
  if (batch > queue) {
    throw new Error('session-telemetry-otel: processor.maxExportBatchSize must not exceed processor.maxQueueSize')
  }
  return limit
}

/** Resolved queue cadence after defaults; the export timeout is a watchdog, not an abort. */
export type ResolvedTelemetryProcessorConfig = Required<Pick<TelemetryProcessorOptions,
  'maxQueueSize' | 'maxExportBatchSize' | 'scheduledDelayMillis' | 'exportTimeoutMillis'>>

/**
 * Resolve the queue knobs this processor consumes; SDK env fallbacks do not
 * apply.
 * @param options - caller overrides, or undefined for the SDK defaults.
 * @returns the fully populated cadence and queue limits.
 */
export function resolveTelemetryProcessorConfig(options: TelemetryProcessorOptions | undefined): ResolvedTelemetryProcessorConfig {
  return {
    maxQueueSize: options?.maxQueueSize ?? 2048,
    maxExportBatchSize: options?.maxExportBatchSize ?? 512,
    scheduledDelayMillis: options?.scheduledDelayMillis ?? 1000,
    exportTimeoutMillis: options?.exportTimeoutMillis ?? 30000,
  }
}

/**
 * Byte/count batching with one transport request in flight, including after a
 * watchdog warning. Queued records carry their measured serialized size, so
 * drain never re-serializes the candidate batch; a single record that cannot
 * fit any request is diagnosed once and does not block later records.
 */
export class ByteBoundedLogProcessor implements LogRecordProcessor {
  private readonly queue: { record: SdkLogRecord; bytes: number }[] = []
  private bytes = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private active: Promise<void> | undefined
  private shutdownPromise: Promise<void> | undefined
  private stopped = false

  constructor(
    private readonly exporter: LogRecordExporter,
    private readonly limit: number,
    private readonly config: ResolvedTelemetryProcessorConfig,
    private readonly warn: TelemetryWarn,
  ) {}

  /**
   * Accept one SDK-produced record into the batching queue.
   * @param record - record handed over by the SDK logger after instrumentation.
   */
  onEmit(record: SdkLogRecord): void {
    if (this.stopped) return
    if (this.queue.length >= this.config.maxQueueSize) {
      this.warn('Session telemetry queue is full; record rejected')
      return
    }
    let bytes: number
    try {
      const serialized = JsonLogsSerializer.serializeRequest([record])
      if (serialized === undefined) throw new Error('telemetry record serialization produced no request')
      bytes = serialized.byteLength
    } catch (error) {
      this.warn('Session telemetry serialization failed; record rejected', error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (bytes > this.limit) {
      this.warn('Session telemetry record rejected; content was not truncated',
        new Error(`telemetry record exceeds maxRequestBytes: ${bytes} > ${this.limit}`))
      return
    }
    this.queue.push({ record, bytes })
    this.bytes += bytes
    if (this.active !== undefined) return
    if (this.queue.length >= this.config.maxExportBatchSize || this.bytes >= this.limit) {
      void this.forceFlush()
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => { void this.forceFlush() }, this.config.scheduledDelayMillis)
      this.timer.unref()
    }
  }

  forceFlush(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.active !== undefined) return this.active
    if (this.queue.length === 0) return Promise.resolve()
    this.active = this.drain()
    return this.active
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped && this.queue.length > 0) {
        let bytes = 0
        let count = 0
        for (const entry of this.queue) {
          if (count === this.config.maxExportBatchSize || bytes + entry.bytes > this.limit) break
          bytes += entry.bytes
          count++
        }
        // Each measured record includes its resource/scope envelope. The shared
        // envelope in a multi-record request cannot exceed their sum.
        const records = this.queue.splice(0, count).map(entry => entry.record)
        this.bytes -= bytes
        await this.send(records)
        // The export callback precedes removal from the SDK concurrency queue.
        await this.exporter.forceFlush()
      }
    } finally { this.active = undefined }
  }

  private send(records: SdkLogRecord[]): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.warn('Session telemetry request exceeded exportTimeoutMillis; waiting for transport settlement')
      }, this.config.exportTimeoutMillis)
      timer.unref()
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        if (error !== undefined) this.warn('Session telemetry export failed', error)
        resolve()
      }
      try {
        this.exporter.export(records, (result) => {
          finish(result.code === ExportResultCode.SUCCESS
            ? undefined : result.error ?? new Error('telemetry HTTP export failed'))
        })
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Drop queued records at the owning backend's shutdown deadline; an active transport may still settle. */
  stopPending(): void {
    this.stopped = true
    this.queue.length = 0
    this.bytes = 0
    clearTimeout(this.timer)
    this.timer = undefined
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.forceFlush().then(() => this.exporter.shutdown())
    return this.shutdownPromise
  }
}
