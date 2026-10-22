/** Fixed-memory process observation with caller-controlled request lifetimes. */
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayPerformanceObserver } from '../src/performance-observer.ts'

const observers: GatewayPerformanceObserver[] = []
afterEach(() => {
  for (const observer of observers.splice(0)) observer.dispose()
  vi.restoreAllMocks()
})

function create(enabled = true): GatewayPerformanceObserver {
  const observer = new GatewayPerformanceObserver({ enabled, eventLoopResolutionMs: 20 })
  observers.push(observer)
  return observer
}

function response(): ServerResponse {
  return new ServerResponse(new IncomingMessage(new Socket()))
}

describe('GatewayPerformanceObserver', () => {
  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])('rejects invalid sampler resolution %s', (eventLoopResolutionMs) => {
    expect(() => new GatewayPerformanceObserver({ enabled: false, eventLoopResolutionMs })).toThrow('eventLoopResolutionMs')
  })

  it('separates simultaneous HTTP, WebSocket and internal lifetimes without retaining request labels', () => {
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const observer = create()
    const http = observer.beginRequest('http')
    const stream = observer.beginRequest('websocket')
    const internal = observer.beginRequest('internal')
    expect(observer.snapshot(null).requests.inflight).toBe(3)
    now += 2
    http(200)
    now += 98
    internal(503)
    now += 60_000
    stream(200, true)
    stream(500)
    const snapshot = observer.snapshot({ running: 2 })
    expect(snapshot.schemaVersion).toBe(1)
    expect(snapshot.measurement).toMatchObject({ kind: 'cumulative', elapsedMs: 60_100 })
    expect(snapshot.requests).toMatchObject({ started: 3, completed: 3, inflight: 0, peakInflight: 3, errors: 2, aborted: 1 })
    expect(snapshot.operationClasses.http.durationMs.p99Ms).toBe(2)
    expect(snapshot.operationClasses.internal.durationMs.p99Ms).toBe(100)
    expect(snapshot.operationClasses.websocket.durationMs).toMatchObject({ maxMs: 60_100, overflow: 1, p99Ms: 60_100 })
    expect(Object.keys(snapshot.operationClasses)).toEqual(['http', 'websocket', 'internal'])
    expect(snapshot.runtimeCapacity).toEqual({ running: 2 })
    expect(snapshot.memory.rss).toBeGreaterThan(0)
    expect(Number.isFinite(snapshot.eventLoop.meanMs)).toBe(true)
  })

  it('reports fixed bucket upper bounds, exact totals and a separately counted overflow', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const observer = create()
    const durations = [0, 1, 1.001, 60_000, 60_000.001]
    for (const duration of durations) {
      const finish = observer.beginRequest()
      now += duration
      finish(404)
    }
    const { requests } = observer.snapshot(null)
    expect(requests.clientErrors).toBe(5)
    expect(requests.errors).toBe(0)
    expect(requests.durationMs).toMatchObject({ count: 5, sumMs: 120_002.002, maxMs: 60_000.001, overflow: 1, percentileMethod: 'bucket-upper-bound', p50Ms: 2 })
    expect(requests.durationMs.buckets).toHaveLength(16)
    expect(requests.durationMs.buckets.slice(0, 2).map(bucket => bucket.count)).toEqual([2, 1])
    expect(requests.durationMs.buckets.at(-1)).toEqual({ upperBoundMs: null, count: 1 })
  })

  it('provides independent cumulative snapshots with fixed storage after many completions', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const observer = create()
    const before = observer.snapshot(null)
    for (let index = 0; index < 20_000; index++) observer.beginRequest()(200)
    const after = observer.snapshot(null)
    expect(before.requests.completed).toBe(0)
    expect(after.requests.completed).toBe(20_000)
    expect(after.requests.durationMs.buckets).toHaveLength(before.requests.durationMs.buckets.length)
    expect(after.requests.durationMs.buckets.reduce((count, bucket) => count + bucket.count, 0)).toBe(20_000)
    expect(after.requests.durationMs.p50Ms).toBe(1)
  })

  it('counts a finished response once and removes both lifecycle listeners', () => {
    const observer = create()
    const res = response()
    observer.observeResponse(res, 'websocket')
    Object.defineProperty(res, 'writableFinished', { value: true })
    res.emit('finish')
    res.emit('close')
    expect(observer.snapshot(null).operationClasses.websocket).toMatchObject({ completed: 1, inflight: 0, aborted: 0 })
    expect(res.listenerCount('finish')).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
  })

  it('counts response close before finish as an interruption', () => {
    const observer = create()
    const res = response()
    observer.observeResponse(res)
    res.emit('close')
    expect(observer.snapshot(null).requests).toMatchObject({ completed: 1, errors: 1, aborted: 1 })
    expect(res.listenerCount('finish')).toBe(0)
  })

  it('detaches pending responses and freezes its measurement at disposal', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const observer = create()
    const res = response()
    const late = observer.beginRequest()
    observer.observeResponse(res)
    now = 20
    observer.dispose()
    const before = observer.snapshot(null)
    now = 1_000
    late(200)
    res.emit('close')
    observer.beginRequest()(200)
    observer.observeResponse(res)
    observer.dispose()
    const after = observer.snapshot(null)
    expect(after.requests).toEqual(before.requests)
    expect(after.measurement).toEqual(before.measurement)
    expect(after.eventLoop).toEqual(before.eventLoop)
    expect(after.disposed).toBe(true)
    expect(res.listenerCount('finish')).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
  })

  it('keeps disabled observation empty and attaches no response listeners', () => {
    const observer = create(false)
    const res = response()
    observer.beginRequest('internal')(500)
    observer.observeResponse(res)
    const snapshot = observer.snapshot(null)
    expect(snapshot.requests).toMatchObject({ started: 0, completed: 0, inflight: 0 })
    expect(snapshot.eventLoop).toMatchObject({ samples: 0, utilization: 0 })
    expect(res.listenerCount('finish')).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
  })
})
