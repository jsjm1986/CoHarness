/** Production HTTP entry and listener cleanup for the offline baseline fixture. */
import { afterEach, expect, it, vi } from 'vitest'
import { createPerformanceFixture, runPerformanceLoad } from './performance-baseline-fixture.ts'
import { writePerformanceReport } from './performance-report.ts'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.restoreAllMocks() })

it('emits a complete JSON report whose entire stdout parses without trimming literal escape text', () => {
  const chunks: string[] = []
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { chunks.push(String(chunk)); return true })
  const report = { schemaVersion: 1, samples: [{ enabled: false }, { enabled: true }] }
  try { writePerformanceReport(report) } finally { stdout.mockRestore() }
  expect(JSON.parse(chunks.join(''))).toEqual(report)
  expect(chunks.join('').endsWith('\n')).toBe(true)
  expect(chunks.join('').endsWith('\\n')).toBe(false)
})

it('consumes the same fixed authenticated and health responses with observation disabled and enabled', async () => {
  const outputs = []
  for (const enabled of [false, true]) {
    const fixture = await createPerformanceFixture(enabled)
    cleanup = fixture.close
    const result = await runPerformanceLoad(fixture.base, { requests: 20, concurrency: 4, timeoutMs: 10_000 })
    expect(result).toMatchObject({ offered: 20, completed: 20, failed: 0, statuses: { '200': 20 } })
    expect(result.latencyMs.samples).toHaveLength(20)
    const snapshot = fixture.observer.snapshot(null)
    expect(snapshot.requests).toMatchObject({ started: enabled ? 20 : 0, completed: enabled ? 20 : 0, inflight: 0, errors: 0 })
    outputs.push(result.responseBytes)
    await fixture.close()
    cleanup = undefined
    expect(fixture.observer.snapshot(null).disposed).toBe(true)
    await expect(fetch(`${fixture.base}/healthz/live`)).rejects.toThrow()
  }
  expect(outputs[0]).toBe(outputs[1])
})

it('rejects invalid workload settings before acquiring client connections', async () => {
  await expect(runPerformanceLoad('http://127.0.0.1:1', { requests: 0, concurrency: 1, timeoutMs: 1000 })).rejects.toThrow('requests')
  await expect(runPerformanceLoad('http://127.0.0.1:1', { requests: 1, concurrency: 0, timeoutMs: 1000 })).rejects.toThrow('concurrency')
})
