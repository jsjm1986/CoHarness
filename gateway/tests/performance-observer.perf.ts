/** Source-only diagnostic for request-counter overhead; it is not a built-artifact or capacity gate. */
import { writePerformanceReport } from './performance-report.ts'
import { performance } from 'node:perf_hooks'
import { GatewayPerformanceObserver } from '../src/performance-observer.ts'

const OPERATIONS = 200_000
const SAMPLES = 5
const WARMUP = 20_000

function run(enabled: boolean, operations: number) {
  const observer = new GatewayPerformanceObserver({ enabled, eventLoopResolutionMs: 20 })
  let checksum = 0
  const start = performance.now()
  try {
    for (let index = 0; index < operations; index++) {
      const finish = observer.beginRequest(index % 10 === 0 ? 'internal' : 'http')
      checksum = (checksum + index) >>> 0
      finish(index % 100 === 0 ? 503 : 200)
    }
    const elapsedMs = performance.now() - start
    return { enabled, operations, checksum, elapsedMs, nsPerOperation: elapsedMs * 1e6 / operations, snapshot: observer.snapshot(null) }
  } finally { observer.dispose() }
}

run(false, WARMUP)
run(true, WARMUP)
const samples = Array.from({ length: SAMPLES }, (_, index) => {
  const order = index % 2 === 0 ? [false, true] : [true, false]
  const pair = order.map(enabled => run(enabled, OPERATIONS))
  return { ordinal: index + 1, order, disabled: pair.find(sample => !sample.enabled)!, enabled: pair.find(sample => sample.enabled)! }
})
const median = (values: number[]): number => values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)]!
writePerformanceReport({
  schemaVersion: 1, diagnostic: 'gateway-observer-counter-overhead', execution: 'source',
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  workload: { operations: OPERATIONS, samples: SAMPLES, warmup: WARMUP, internalEvery: 10, failureEvery: 100 },
  excludes: ['HTTP response listeners', 'network', 'database', 'model', 'native sampler scheduling under asynchronous load'],
  samples,
  medians: {
    disabledMs: median(samples.map(sample => sample.disabled.elapsedMs)),
    enabledMs: median(samples.map(sample => sample.enabled.elapsedMs)),
    addedNsPerOperation: median(samples.map(sample => sample.enabled.nsPerOperation - sample.disabled.nsPerOperation)),
  },
})
