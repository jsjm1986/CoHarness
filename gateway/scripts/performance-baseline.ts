/** Offline source/built HTTP diagnostic; it accepts no target URL and cannot address an existing deployment. */
import { writePerformanceReport } from '../tests/performance-report.ts'
import { availableParallelism, totalmem } from 'node:os'
import { createPerformanceFixture, runPerformanceLoad } from '../tests/performance-baseline-fixture.ts'

const plane = process.argv[2] ?? 'source'
if (plane !== 'source' && plane !== 'built') throw new Error('usage: performance-baseline.ts [source|built]')
const workload = { requests: 50_000, concurrency: 20, timeoutMs: 10_000 }
const warmupRequests = 20_000
const samples = []
let runtimeReplyBytes = 0
for (let ordinal = 0; ordinal < 3; ordinal++) {
  const order = ordinal % 2 === 0 ? [false, true] : [true, false]
  for (const enabled of order) {
    const fixture = await createPerformanceFixture(enabled, plane)
    runtimeReplyBytes = fixture.responseBytes
    try {
      await runPerformanceLoad(fixture.base, { ...workload, requests: warmupRequests })
      const before = fixture.observer.snapshot(null)
      const result = await runPerformanceLoad(fixture.base, workload)
      const after = fixture.observer.snapshot(null)
      if (result.completed !== workload.requests || result.failed !== 0) throw new Error('baseline workload did not complete with identical successful responses')
      samples.push({ ordinal: ordinal + 1, enabled, workload: result, observationBefore: before, observationAfter: after })
    } finally { await fixture.close() }
  }
}
writePerformanceReport({
  schemaVersion: 1, diagnostic: 'gateway-http-observer-baseline', execution: plane,
  environment: { node: process.version, platform: process.platform, arch: process.arch, availableParallelism: availableParallelism(), totalMemoryBytes: totalmem() },
  workload: { ...workload, samplesPerMode: 3, warmupRequests, healthEvery: 10, runtimeReplyBytes },
  limitations: [
    'closed-loop client and server share one process; not a 300-user or 100-task capacity result',
    'fixed in-memory authentication; no PostgreSQL, runtime child, model, browser, WebSocket, tunnel or external network',
    'built selects compiled Gateway modules and fails if missing; CLI and fixture remain source orchestration',
    'counter and bucket differences measure the sampled interval; cumulative maxima and percentiles cannot be subtracted',
  ],
  samples,
})
