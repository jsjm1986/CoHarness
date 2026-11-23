/** On-demand collapsible diagnostics panel displaying live Gateway latency, forwarding pool, and asset cache metrics. */
import { Activity, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getPerformanceDiagnostics, type PerformanceDiagnosticsSnapshot } from '../performance-api.ts'
import { Button, ErrorBanner, IconButton, LoadingState, Section, StatusBadge } from '../components/ui.tsx'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh, en } from './performance-diagnostics.copy.ts'

function formatMs(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ms`
}

function formatPct(numerator: number, denominator: number, fallback: string): string {
  if (denominator <= 0) return fallback
  return `${((numerator / denominator) * 100).toFixed(1)}%`
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function formatDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`
  const hours = Math.floor(minutes / 60)
  return `${String(hours)}h ${String(minutes % 60)}m`
}

function readySummary(record: Readonly<Record<string, number>>) {
  const hits = (record.ready ?? 0) + (record.delegated ?? 0)
  const fallbacks = (record.fallbackUnavailable ?? 0) + (record.fallbackNotRetained ?? 0)
    + (record.fallbackMaintenance ?? 0) + (record.fallbackCandidate ?? 0) + (record.fallbackDelegation ?? 0)
  const refused = (record.refused ?? 0) + (record.failed ?? 0)
  const total = hits + fallbacks + refused + (record.cancelled ?? 0)
  return { hits, fallbacks, refused, total }
}

/**
 * Collapsible Deployment page section inspecting `GET /admin/api/performance` for the active computer.
 * Starts collapsed so page load incurs zero extra network requests.
 * @returns the diagnostics section element.
 */
export function PerformanceDiagnosticsSection() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [snapshot, setSnapshot] = useState<PerformanceDiagnosticsSnapshot | null>(null)
  const [error, setError] = useState('')
  const activeRequest = useRef<AbortController | undefined>(undefined)

  const refresh = useCallback(async () => {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setLoading(true)
    setError('')
    try {
      const next = await getPerformanceDiagnostics(controller.signal)
      if (!controller.signal.aborted) setSnapshot(next)
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(t('loadFailed', { error: message }))
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (!expanded) {
      activeRequest.current?.abort()
      return
    }
    void refresh()
    return () => { activeRequest.current?.abort() }
  }, [expanded, refresh])

  const forwardedReady = snapshot === null ? null : readySummary(snapshot.readySession.forwarded)
  const ordinaryReady = snapshot === null ? null : readySummary(snapshot.readySession.ordinary)
  const combinedReadyHits = (forwardedReady?.hits ?? 0) + (ordinaryReady?.hits ?? 0)
  const combinedReadyTotal = (forwardedReady?.total ?? 0) + (ordinaryReady?.total ?? 0)
  const forwarding = snapshot?.nodeForwarding ?? null
  const assets = snapshot?.runtimeAssets ?? null
  const db = snapshot?.databasePool ?? null

  return (
    <Section
      title={t('sectionTitle')}
      meta={snapshot === null ? t('sectionMeta') : t('uptimeMeta', { value: formatDuration(snapshot.measurement.elapsedMs) })}
      actions={(
        <div className="statusRow">
          {expanded ? (
            <IconButton label={t('refresh')} icon={RefreshCw} loading={loading} onClick={() => void refresh()} />
          ) : null}
          <Button
            variant="ghost"
            icon={expanded ? ChevronUp : ChevronDown}
            onClick={() => setExpanded(current => !current)}
          >
            {expanded ? t('collapse') : t('expand')}
          </Button>
        </div>
      )}
    >
      {!expanded ? (
        <p className="sectionMeta">{t('collapsedHint')}</p>
      ) : (
        <div className="deploymentStatus">
          <ErrorBanner message={error} />
          {loading && snapshot === null ? <LoadingState label={t('loading')} /> : null}
          {snapshot === null ? null : (
            <>
              <div className="statusRow">
                <StatusBadge tone={snapshot.enabled ? 'success' : 'neutral'}>
                  {snapshot.enabled ? t('statusEnabled') : t('statusDisabled')}
                </StatusBadge>
                {snapshot.enabled ? null : <span className="sectionMeta">{t('disabledNotice')}</span>}
              </div>

              <div className="metricGrid" aria-label={t('metricsAria')}>
                <div className={snapshot.operationClasses.http.durationMs.p95Ms >= 500 ? 'metric metric-warning' : 'metric'}>
                  <span>{t('httpP95Label')}</span>
                  <strong>{formatMs(snapshot.operationClasses.http.durationMs.p95Ms)}</strong>
                  <span className="metricSub">{t('httpSub', {
                    p50: formatMs(snapshot.operationClasses.http.durationMs.p50Ms),
                    p99: formatMs(snapshot.operationClasses.http.durationMs.p99Ms),
                    errors: String(snapshot.operationClasses.http.errors),
                  })}</span>
                </div>

                <div className={snapshot.eventLoop.p95Ms >= 50 ? 'metric metric-warning' : 'metric'}>
                  <span>{t('eventLoopP95Label')}</span>
                  <strong>{formatMs(snapshot.eventLoop.p95Ms)}</strong>
                  <span className="metricSub">{t('eventLoopSub', {
                    util: `${(snapshot.eventLoop.utilization * 100).toFixed(1)}%`,
                    rss: formatMiB(snapshot.memory.rss),
                  })}</span>
                </div>

                {forwarding !== null ? (
                  <div className={forwarding.pool.waiting > 0 ? 'metric metric-warning' : 'metric'}>
                    <span>{t('poolReuseLabel')}</span>
                    <strong>{formatPct(forwarding.pool.reused, forwarding.pool.reused + forwarding.pool.opened, t('na'))}</strong>
                    <span className="metricSub">{t('poolSub', {
                      active: String(forwarding.pool.active),
                      idle: String(forwarding.pool.idle),
                      waiting: String(forwarding.pool.waiting),
                    })}</span>
                  </div>
                ) : (
                  <div className="metric">
                    <span>{t('readySessionLabel')}</span>
                    <strong>{formatPct(combinedReadyHits, combinedReadyTotal, t('na'))}</strong>
                    <span className="metricSub">{t('readySessionSub', {
                      hits: String(combinedReadyHits),
                      total: String(combinedReadyTotal),
                    })}</span>
                  </div>
                )}

                {assets !== null ? (
                  <div className="metric">
                    <span>{t('assetCacheLabel')}</span>
                    <strong>{formatPct(assets.remoteCacheHits, assets.remoteCacheHits + assets.remoteCacheMisses, t('na'))}</strong>
                    <span className="metricSub">{t('assetCacheSub', {
                      entries: String(assets.remoteCacheEntries),
                      mb: formatMiB(assets.remoteCacheBytes),
                    })}</span>
                  </div>
                ) : (
                  <div className={(db?.waiting ?? 0) > 0 ? 'metric metric-warning' : 'metric'}>
                    <span>{t('dbPoolLabel')}</span>
                    <strong>{db === null ? t('na') : `${String(db.active ?? 0)} / ${String(db.maxConnections ?? 0)}`}</strong>
                    <span className="metricSub">{db === null ? t('na') : t('dbPoolSub', {
                      active: String(db.active ?? 0),
                      idle: String(db.idle ?? 0),
                      waiting: String(db.waiting ?? 0),
                    })}</span>
                  </div>
                )}
              </div>

              <div className="tableWrap" role="region" aria-label={t('tableAria')} tabIndex={0}>
                <table className="dataTable">
                  <thead>
                    <tr>
                      <th>{t('colCategory')}</th>
                      <th>{t('colThroughput')}</th>
                      <th>{t('colLive')}</th>
                      <th>{t('colLatency')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {([
                      ['rowHttp', snapshot.operationClasses.http],
                      ['rowWebsocket', snapshot.operationClasses.websocket],
                      ['rowInternal', snapshot.operationClasses.internal],
                    ] as const).map(([labelKey, metrics]) => (
                      <tr key={labelKey}>
                        <td>{t(labelKey)}</td>
                        <td>{t('throughputCounts', { completed: String(metrics.completed), errors: String(metrics.errors) })}</td>
                        <td>{t('liveInflight', { inflight: String(metrics.inflight), peak: String(metrics.peakInflight) })}</td>
                        <td>{t('latencyTriplet', {
                          p50: formatMs(metrics.durationMs.p50Ms),
                          p95: formatMs(metrics.durationMs.p95Ms),
                          p99: formatMs(metrics.durationMs.p99Ms),
                        })}</td>
                      </tr>
                    ))}
                    {forwardedReady === null ? null : (
                      <tr>
                        <td>{t('rowReadyForwarded')}</td>
                        <td>{t('readyCounts', {
                          hits: String(forwardedReady.hits),
                          fallbacks: String(forwardedReady.fallbacks),
                          refused: String(forwardedReady.refused),
                        })}</td>
                        <td>{formatPct(forwardedReady.hits, forwardedReady.total, t('na'))}</td>
                        <td>{t('na')}</td>
                      </tr>
                    )}
                    {ordinaryReady === null ? null : (
                      <tr>
                        <td>{t('rowReadyOrdinary')}</td>
                        <td>{t('readyCounts', {
                          hits: String(ordinaryReady.hits),
                          fallbacks: String(ordinaryReady.fallbacks),
                          refused: String(ordinaryReady.refused),
                        })}</td>
                        <td>{formatPct(ordinaryReady.hits, ordinaryReady.total, t('na'))}</td>
                        <td>{t('na')}</td>
                      </tr>
                    )}
                    {forwarding === null ? null : (
                      <tr>
                        <td>{t('rowForwarding')}</td>
                        <td>{t('forwardingCounts', {
                          http: String(forwarding.httpTotal),
                          ws: String(forwarding.upgradeTotal),
                          reused: String(forwarding.pool.reused),
                          opened: String(forwarding.pool.opened),
                        })}</td>
                        <td>{t('forwardingLive', {
                          active: String(forwarding.pool.active),
                          idle: String(forwarding.pool.idle),
                          waiting: String(forwarding.pool.waiting),
                        })}</td>
                        <td>{t('forwardingDetail', {
                          prepHit: String(forwarding.preparedReadHit),
                          prepTotal: String(forwarding.preparedReadEligible),
                          syncSkip: String(forwarding.accessSyncSkipped),
                        })}</td>
                      </tr>
                    )}
                    {db === null ? null : (
                      <tr>
                        <td>{t('rowDatabase')}</td>
                        <td>{t('dbCounts', {
                          max: String(db.maxConnections ?? 0),
                          errors: String(db.checkoutErrors ?? 0),
                        })}</td>
                        <td>{t('dbLive', {
                          active: String(db.active ?? 0),
                          idle: String(db.idle ?? 0),
                          waiting: String(db.waiting ?? 0),
                          maxWait: String(db.maxWaiting ?? 0),
                        })}</td>
                        <td>{t('dbLatency', {
                          p95: formatMs(db.checkoutWaitMs?.p95Ms),
                          max: formatMs(db.checkoutWaitMs?.maxMs),
                        })}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <span className="sectionMeta"><Activity className="diagnosticsNoteIcon" aria-hidden="true" />{t('sectionMeta')}</span>
            </>
          )}
        </div>
      )}
    </Section>
  )
}
