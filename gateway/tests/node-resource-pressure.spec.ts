/** Pressure pacing and completion of owned native observations. @module */
import { describe, expect, it, vi } from 'vitest'
import {
  darwinMemoryPressure, NodeResourcePressure, pressureCredits, type NodePressureConfig, type NodePressureSample, type NodePressureObservation,
} from '../src/node-resource-pressure.ts'

const config: NodePressureConfig = {
  sampleMs: 80, staleMs: 500, cpuTarget: 0.85, eventLoopTargetMs: 100, linuxMemoryReserveRatio: 0.1,
}
const healthy: NodePressureSample = { cpu: 0.25, memory: 'normal', eventLoopMs: 10, parallelism: 8 }

it.each([['1', 'normal'], ['2', 'warning'], ['4', 'critical']] as const)(
  'reads the operating system dispatch-pressure flag %s as %s', (input, expected) => {
    expect(darwinMemoryPressure(` ${input}\n`)).toBe(expected)
  },
)

it('refuses unsupported memory pressure observations', () => {
  expect(() => darwinMemoryPressure('0')).toThrow('unsupported macOS memory pressure value')
  expect(() => darwinMemoryPressure('3')).toThrow('unsupported macOS memory pressure value')
})

it('paces starts by current CPU headroom without accumulating credits', () => {
  expect(pressureCredits(healthy, config)).toBe(6)
  expect(pressureCredits({ ...healthy, parallelism: 1 }, config)).toBe(1)
  for (const pressure of [{ cpu: 0.85 }, { memory: 'warning' as const }, { memory: 'critical' as const },
    { eventLoopMs: 100 }, { memoryAvailableRatio: 0.1 }]) {
    expect(pressureCredits({ ...healthy, ...pressure }, config)).toBe(0)
  }
  expect(pressureCredits({ ...healthy, memoryAvailableRatio: 0.15 }, config)).toBe(6)
  expect(pressureCredits({ ...healthy, memoryAvailableRatio: 0.15 }, { ...config, linuxMemoryReserveRatio: 0.2 })).toBe(0)
})

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('native node pressure observations', () => {
  it('pauses captures while maintenance is closed and resumes after reopening', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let enabled = false
    const permission = vi.fn(() => enabled)
    let published!: () => void, failed!: (error: unknown) => void
    const publication = new Promise<void>((resolve, reject) => { published = resolve; failed = reject })
    const publish = vi.fn(async () => { published() })
    const sampler = new NodeResourcePressure(config, publish, failed, permission)
    try {
      sampler.start()
      await vi.advanceTimersByTimeAsync(config.sampleMs * 3)
      expect(permission).toHaveBeenCalledTimes(3)
      expect(publish).not.toHaveBeenCalled()
      enabled = true
      await vi.advanceTimersByTimeAsync(config.sampleMs)
      await publication
      expect(publish).toHaveBeenCalledTimes(1)
    } finally {
      await sampler.dispose()
      vi.useRealTimers()
    }
  })

  it('joins an in-flight sensor publication before disposal completes', async () => {
    let started!: (sample: NodePressureObservation) => void, failed!: (error: unknown) => void, finish!: () => void
    const observing = new Promise<NodePressureObservation>((resolve, reject) => { started = resolve; failed = reject })
    const publication = new Promise<void>(resolve => { finish = resolve })
    let publications = 0
    const sampler = new NodeResourcePressure(config, async sample => {
      publications += 1
      started(sample)
      await publication
    }, failed, () => true)
    const startedAt = performance.now()
    sampler.start()
    try {
      const sample = await observing
      expect(sample.capturedAt).toBeGreaterThanOrEqual(startedAt)
      expect(sample.capturedAt).toBeLessThanOrEqual(performance.now())
      expect(Number.isFinite(sample.cpu)).toBe(true)
      expect(sample.cpu).toBeGreaterThanOrEqual(0)
      expect(sample.cpu).toBeLessThanOrEqual(1)
      expect(sample.parallelism).toBeGreaterThan(0)
      if (process.platform === 'linux') expect(sample.memoryAvailableRatio).toBeGreaterThan(0)
      else expect(sample.memoryAvailableRatio).toBeUndefined()
      let closed = false
      const closing = sampler.dispose().then(() => { closed = true })
      try {
        await Promise.resolve()
        expect(closed).toBe(false)
      } finally { finish() }
      await closing
      expect(publications).toBe(1)
      expect(() => sampler.start()).toThrow('already started or closed')
    } finally { finish(); await sampler.dispose() }
  })
})
