/**
 * Byte/count queue semantics of {@link ByteBoundedLogProcessor}: records are
 * measured once through the SDK request serializer, packed greedily under the
 * uncompressed request ceiling, and exported through one transport slot that
 * a watchdog warning never releases.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoggerProvider, type LogRecordExporter, type ReadableLogRecord } from '@opentelemetry/sdk-logs'
import type { AnyValue } from '@opentelemetry/api-logs'
import { JsonLogsSerializer } from '@opentelemetry/otlp-transformer'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import {
  ByteBoundedLogProcessor,
  TELEMETRY_MAX_REQUEST_BYTES,
  resolveTelemetryLimits,
  resolveTelemetryProcessorConfig,
  type TelemetryProcessorOptions,
} from '../src/processor.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
  } finally {
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

interface Harness {
  emit: (body: unknown) => void
  warn: ReturnType<typeof vi.fn>
  provider: LoggerProvider
}

function harness(
  exporter: LogRecordExporter,
  options: { limit?: number; processor?: TelemetryProcessorOptions } = {},
): Harness {
  const warn = vi.fn()
  const processor = new ByteBoundedLogProcessor(
    exporter,
    options.limit ?? TELEMETRY_MAX_REQUEST_BYTES,
    resolveTelemetryProcessorConfig(options.processor),
    warn,
  )
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ 'service.name': 'byte-bound-test' }),
    processors: [processor],
  })
  cleanup.push(() => provider.shutdown())
  const logger = provider.getLogger('byte-bound-test')
  return { emit: (body) => { logger.emit({ body: body as AnyValue }) }, warn, provider }
}

/** Exporter that captures every request and answers immediately. */
function captureExporter(result: ExportResult = { code: ExportResultCode.SUCCESS }) {
  const requests: ReadableLogRecord[][] = []
  const exportFn = vi.fn<LogRecordExporter['export']>((records, callback) => {
    requests.push(records)
    callback(result)
  })
  const exporter: LogRecordExporter = { export: exportFn, forceFlush: async () => {}, shutdown: async () => {} }
  return { exporter, requests }
}

function requestBytes(records: ReadableLogRecord[]): number {
  const serialized = JsonLogsSerializer.serializeRequest(records)
  if (serialized === undefined) throw new Error('serialization produced no request')
  return serialized.byteLength
}

describe('resolveTelemetryLimits', () => {
  it.each([0, -1, 1.5, 4_000_001, Infinity])('rejects byte limit %s', (maxRequestBytes) => {
    expect(() => resolveTelemetryLimits({ maxRequestBytes })).toThrow('maxRequestBytes')
  })

  it.each(['maxQueueSize', 'maxExportBatchSize', 'scheduledDelayMillis', 'exportTimeoutMillis'] as const)(
    'rejects invalid %s', (key) => {
      expect(() => resolveTelemetryLimits({ processor: { [key]: 0 } })).toThrow(`processor.${key}`)
    })

  it('rejects a batch count above the queue capacity', () => {
    expect(() => resolveTelemetryLimits({ processor: { maxQueueSize: 1, maxExportBatchSize: 2 } }))
      .toThrow('maxExportBatchSize must not exceed processor.maxQueueSize')
  })

  it('defaults to the collector ceiling and accepts lower limits', () => {
    expect(resolveTelemetryLimits({})).toBe(TELEMETRY_MAX_REQUEST_BYTES)
    expect(resolveTelemetryLimits({ maxRequestBytes: 1 })).toBe(1)
  })
})

describe('ByteBoundedLogProcessor', () => {
  it('packs requests greedily under the byte limit and preserves order', async () => {
    const { exporter, requests } = captureExporter()
    const { emit, warn } = harness(exporter, { limit: 2_000, processor: { scheduledDelayMillis: 5 } })
    const bodies = Array.from({ length: 10 }, (_, i) => `record-${i}-${'x'.repeat(400)}`)
    for (const body of bodies) emit(body)
    await vi.waitFor(() => { expect(requests.flat()).toHaveLength(10) })
    expect(requests.length).toBeGreaterThan(1)
    for (const records of requests) expect(requestBytes(records)).toBeLessThanOrEqual(2_000)
    expect(requests.flat().map(record => record.body)).toEqual(bodies)
    expect(warn).not.toHaveBeenCalled()
  })

  it('admits a record at exactly the limit and diagnoses an oversized record once', async () => {
    const first = captureExporter()
    const probe = harness(first.exporter, { processor: { scheduledDelayMillis: 5 } })
    const body = `exact-${'y'.repeat(200)}`
    probe.emit(body)
    await vi.waitFor(() => { expect(first.requests).toHaveLength(1) })
    const limit = requestBytes(first.requests[0]!)

    const exact = captureExporter()
    harness(exact.exporter, { limit, processor: { scheduledDelayMillis: 5 } }).emit(body)
    await vi.waitFor(() => { expect(exact.requests).toHaveLength(1) })

    const small = captureExporter()
    const { emit, warn } = harness(small.exporter, { limit: limit - 1, processor: { scheduledDelayMillis: 5 } })
    emit(body)
    await Promise.resolve()
    expect(small.requests).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('Session telemetry record rejected; content was not truncated', expect.any(Error))
  })

  it('rejects a single oversized record without blocking later records', async () => {
    const { exporter, requests } = captureExporter()
    const { emit, warn } = harness(exporter, { limit: 1_500, processor: { scheduledDelayMillis: 5 } })
    emit(`small-${'a'.repeat(100)}`)
    emit('b'.repeat(10_000))
    emit(`last-${'c'.repeat(100)}`)
    await vi.waitFor(() => { expect(requests.flat().map(record => record.body)).toEqual([`small-${'a'.repeat(100)}`, `last-${'c'.repeat(100)}`]) })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('Session telemetry record rejected; content was not truncated', expect.any(Error))
  })

  it.each([new Error('serialize'), 'serialize', undefined])('contains serializer failures %s', (failure) => {
    const { exporter } = captureExporter()
    const { emit, warn } = harness(exporter)
    vi.spyOn(JsonLogsSerializer, 'serializeRequest').mockImplementationOnce(() => {
      if (failure === undefined) return undefined
      throw failure
    })
    emit('invalid')
    expect(warn).toHaveBeenCalledWith('Session telemetry serialization failed; record rejected', expect.any(Error))
  })

  it('measures each record once instead of serializing the full candidate batch', async () => {
    const { exporter, requests } = captureExporter()
    const { emit } = harness(exporter, { limit: 1_300, processor: { scheduledDelayMillis: 5 } })
    const serialize = vi.spyOn(JsonLogsSerializer, 'serializeRequest')
    for (let i = 0; i < 20; i++) emit(`batch-${i}-${'d'.repeat(60)}`)
    await vi.waitFor(() => { expect(requests.flat()).toHaveLength(20) })
    // onEmit measures one record at a time; the exporter serialization is the mock-free path.
    expect(serialize.mock.calls.filter(([records]) => records.length === 1)).toHaveLength(20)
    expect(serialize).toHaveBeenCalledTimes(20)
  })

  it('keeps one transport slot across byte batches and warns without releasing it at the watchdog', async () => {
    vi.useFakeTimers()
    let active = 0
    let peak = 0
    const sent: unknown[] = []
    const callbacks: ((result: ExportResult) => void)[] = []
    const exporter: LogRecordExporter = {
      export(records, callback) {
        active++
        peak = Math.max(peak, active)
        sent.push(...records.map(record => record.body))
        callbacks.push((result) => { active--; callback(result) })
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    }
    const { emit, warn, provider } = harness(exporter, {
      limit: 1_300,
      processor: { maxExportBatchSize: 1, scheduledDelayMillis: 60_000, exportTimeoutMillis: 100 },
    })
    emit('first')
    emit('second')
    await vi.advanceTimersByTimeAsync(150)
    expect(warn).toHaveBeenCalledWith('Session telemetry request exceeded exportTimeoutMillis; waiting for transport settlement')
    expect(peak).toBe(1)
    callbacks[0]!({ code: ExportResultCode.SUCCESS })
    await vi.advanceTimersByTimeAsync(0)
    callbacks[1]!({ code: ExportResultCode.SUCCESS })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['first', 'second'])
    await provider.shutdown()
  })

  it('drops queued records at stopPending and ignores later emits', async () => {
    const callbacks: ((result: ExportResult) => void)[] = []
    const send = vi.fn<LogRecordExporter['export']>((_records, callback) => { callbacks.push(callback) })
    const exporter: LogRecordExporter = { export: send, forceFlush: async () => {}, shutdown: async () => {} }
    const warn = vi.fn()
    const processor = new ByteBoundedLogProcessor(exporter, TELEMETRY_MAX_REQUEST_BYTES,
      resolveTelemetryProcessorConfig({ maxExportBatchSize: 1, maxQueueSize: 4, scheduledDelayMillis: 60_000 }), warn)
    const provider = new LoggerProvider({ processors: [processor] })
    const logger = provider.getLogger('stop-pending')
    logger.emit({ body: 'held' })
    logger.emit({ body: 'queued' })
    processor.stopPending()
    logger.emit({ body: 'after-stop' })
    const done = provider.shutdown()
    callbacks[0]!({ code: ExportResultCode.SUCCESS })
    await done
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('bounds the queued record count while a transport request is unsettled', async () => {
    const release = Promise.withResolvers<(result: ExportResult) => void>()
    const exporter: LogRecordExporter = {
      export(_records, callback) { release.resolve(callback) },
      forceFlush: async () => {},
      shutdown: async () => {},
    }
    const warn = vi.fn()
    const processor = new ByteBoundedLogProcessor(exporter, TELEMETRY_MAX_REQUEST_BYTES,
      resolveTelemetryProcessorConfig({ maxExportBatchSize: 1, maxQueueSize: 2 }), warn)
    const provider = new LoggerProvider({ processors: [processor] })
    cleanup.push(() => provider.shutdown())
    const logger = provider.getLogger('queue-full')
    for (let i = 0; i < 4; i++) logger.emit({ body: `queued-${i}` })
    const finish = await release.promise
    expect(warn).toHaveBeenCalledWith('Session telemetry queue is full; record rejected')
    processor.stopPending()
    finish({ code: ExportResultCode.SUCCESS })
    await provider.shutdown()
  })

  it.each([new Error('transport'), 'transport', undefined])('contains transport failures %s and continues later requests', async (failure) => {
    const send = vi.fn<LogRecordExporter['export']>()
      .mockImplementationOnce((_records, callback) => {
        if (failure === undefined) callback({ code: ExportResultCode.FAILED })
        else throw failure
      })
      .mockImplementation((_records, callback) => { callback({ code: ExportResultCode.SUCCESS }) })
    const exporter: LogRecordExporter = { export: send, forceFlush: async () => {}, shutdown: async () => {} }
    const { emit, warn, provider } = harness(exporter, { processor: { maxExportBatchSize: 1 } })
    emit('failed')
    emit('next')
    await provider.shutdown()
    expect(send).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('flushes on the scheduled delay without a batch trigger', async () => {
    vi.useFakeTimers()
    const { exporter, requests } = captureExporter()
    const { emit, provider } = harness(exporter, { processor: { scheduledDelayMillis: 50 } })
    emit('delayed')
    expect(requests).toEqual([])
    await vi.advanceTimersByTimeAsync(50)
    expect(requests.flat().map(record => record.body)).toEqual(['delayed'])
    await provider.shutdown()
  })
})
