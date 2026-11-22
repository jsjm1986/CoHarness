/** On-demand Gateway performance diagnostics panel: zero mount overhead, live metrics, and abort hygiene. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as perfApi from '../performance-api.ts'
import { PerformanceDiagnosticsSection } from './PerformanceDiagnosticsSection.tsx'

vi.mock('../performance-api.ts', () => ({
  getPerformanceDiagnostics: vi.fn(),
}))

const sampleSnapshot: perfApi.PerformanceDiagnosticsSnapshot = {
  schemaVersion: 1,
  enabled: true,
  disposed: false,
  measurement: { kind: 'cumulative', startedAtUnixMs: 1_700_000_000_000, endedAtUnixMs: 1_700_000_365_000, elapsedMs: 365_000 },
  requests: {
    started: 120, completed: 120, inflight: 0, peakInflight: 6, errors: 1, clientErrors: 2, aborted: 0,
    durationMs: { count: 120, sumMs: 2400, maxMs: 95, p50Ms: 12, p95Ms: 42, p99Ms: 80 },
  },
  operationClasses: {
    http: {
      started: 100, completed: 100, inflight: 2, peakInflight: 5, errors: 1, clientErrors: 2, aborted: 0,
      durationMs: { count: 100, sumMs: 1800, maxMs: 95, p50Ms: 10, p95Ms: 38, p99Ms: 75 },
    },
    websocket: {
      started: 10, completed: 8, inflight: 2, peakInflight: 3, errors: 0, clientErrors: 0, aborted: 0,
      durationMs: { count: 8, sumMs: 400, maxMs: 80, p50Ms: 40, p95Ms: 70, p99Ms: 80 },
    },
    internal: {
      started: 10, completed: 10, inflight: 0, peakInflight: 2, errors: 0, clientErrors: 0, aborted: 0,
      durationMs: { count: 10, sumMs: 100, maxMs: 20, p50Ms: 8, p95Ms: 18, p99Ms: 20 },
    },
  },
  readySession: {
    forwarded: { ready: 45, delegated: 5, fallbackNotRetained: 2, refused: 0 },
    ordinary: { ready: 30, delegated: 0, fallbackNotRetained: 1, refused: 0 },
  },
  eventLoop: { samples: 200, meanMs: 1.2, maxMs: 12, p50Ms: 1.0, p95Ms: 3.4, p99Ms: 8.5, utilization: 0.082 },
  memory: { rss: 96 * 1024 * 1024, heapUsed: 48 * 1024 * 1024, heapTotal: 64 * 1024 * 1024 },
  databasePool: { maxConnections: 20, active: 2, idle: 6, waiting: 0, maxWaiting: 1, checkoutErrors: 0, checkoutWaitMs: { p95Ms: 1.5, maxMs: 5 } },
  nodeForwarding: {
    httpTotal: 50, upgradeTotal: 4, accessSyncCalls: 12, accessSyncSkipped: 38,
    preparedReadEligible: 20, preparedReadHit: 18, preparedReadFallback: 2,
    pool: { reused: 46, opened: 4, queued: 1, active: 2, idle: 4, waiting: 0, closedIdleEntries: 1 },
  },
  runtimeAssets: {
    remoteCacheHits: 19, remoteCacheMisses: 1, remoteCacheEntries: 4, remoteCacheBytes: 2 * 1024 * 1024,
  },
}

describe('PerformanceDiagnosticsSection', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('localStorage', { getItem: () => 'zh' })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('starts collapsed without issuing any network request until expanded', async () => {
    vi.mocked(perfApi.getPerformanceDiagnostics).mockResolvedValue(sampleSnapshot)
    render(<PerformanceDiagnosticsSection />)
    expect(perfApi.getPerformanceDiagnostics).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '展开诊断' }))
    expect(await screen.findByText('92.0%')).toBeTruthy()
    expect(screen.getByText('95.0%')).toBeTruthy()
    expect(screen.getByText('38 ms')).toBeTruthy()
    expect(perfApi.getPerformanceDiagnostics).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '刷新诊断' }))
    expect(perfApi.getPerformanceDiagnostics).toHaveBeenCalledTimes(2)
  })

  it('renders error notice on failure and aborts an in-flight read on unmount', async () => {
    const pending = Promise.withResolvers<perfApi.PerformanceDiagnosticsSnapshot>()
    vi.mocked(perfApi.getPerformanceDiagnostics).mockReturnValueOnce(pending.promise)
    const view = render(<PerformanceDiagnosticsSection />)
    fireEvent.click(screen.getByRole('button', { name: '展开诊断' }))
    const signal = vi.mocked(perfApi.getPerformanceDiagnostics).mock.calls[0]![0]!
    expect(signal.aborted).toBe(false)
    view.unmount()
    expect(signal.aborted).toBe(true)

    vi.mocked(perfApi.getPerformanceDiagnostics).mockRejectedValueOnce(new Error('HTTP 503'))
    render(<PerformanceDiagnosticsSection />)
    fireEvent.click(screen.getByRole('button', { name: '展开诊断' }))
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 503')
  })
})
