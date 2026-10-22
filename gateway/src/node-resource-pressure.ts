/** Host pressure sampling and paced admission; running work has no numeric ceiling. */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { availableParallelism, cpus } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { promisify } from 'node:util'

/** One completed host observation; missing or stale observations never admit new work. */
export interface NodePressureSample {
  cpu: number
  memory: 'normal' | 'warning' | 'critical'
  eventLoopMs: number
  parallelism: number
}

/** Deployment thresholds and observation timing, independent of task counts. */
export interface NodePressureConfig {
  sampleMs: number
  staleMs: number
  cpuTarget: number
  eventLoopTargetMs: number
  linuxMemoryReserveRatio: number
}

const execute = promisify(execFile)

/**
 * Translate macOS's exported dispatch pressure flags, not the kernel's internal enum.
 * @param output - kern.memorystatus_vm_pressure_level decimal output.
 * @returns validated operating-system pressure.
 */
export function darwinMemoryPressure(output: string): NodePressureSample['memory'] {
  switch (output.trim()) {
    case '1': return 'normal'
    case '2': return 'warning'
    case '4': return 'critical'
    default: throw new Error('unsupported macOS memory pressure value')
  }
}

/**
 * Pace starts using idle CPU capacity; credits expire each sample instead of accumulating.
 * @param sample - completed host observation.
 * @param config - deployment pressure thresholds.
 * @returns starts allowed during this observation, with no cap on running work.
 */
export function pressureCredits(sample: NodePressureSample, config: NodePressureConfig): number {
  if (sample.memory !== 'normal' || sample.cpu >= config.cpuTarget || sample.eventLoopMs >= config.eventLoopTargetMs) return 0
  return Math.max(1, Math.floor(sample.parallelism * (1 - sample.cpu)))
}

/** Single-owner sampler; disposal joins its pending measurement and publication. */
export class NodeResourcePressure {
  private previous = cpus().map(cpu => ({ ...cpu.times }))
  private readonly histogram = monitorEventLoopDelay({ resolution: 20 })
  private timer: NodeJS.Timeout | undefined
  private pending: Promise<void> = Promise.resolve()
  private closed = false
  /** @param config - validated thresholds. @param publish - durable node observation writer. @param failed - bounded diagnostic callback. */
  constructor(private readonly config: NodePressureConfig, private readonly publish: (sample: NodePressureSample) => Promise<void>, private readonly failed: (error: unknown) => void) {}

  /** Begin observations; the first publication follows one full CPU interval. */
  start(): void {
    if (this.timer !== undefined || this.closed) throw new Error('pressure sampler already started or closed')
    if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('node pressure admission requires macOS or Linux')
    this.histogram.enable()
    const tick = (): void => {
      this.pending = this.sample().then(this.publish).catch(this.failed).finally(() => {
        if (!this.closed) { this.timer = setTimeout(tick, this.config.sampleMs); this.timer.unref() }
      })
    }
    this.timer = setTimeout(tick, this.config.sampleMs)
    this.timer.unref()
  }

  /** Join the owned sensor and publication without releasing any execution reservations. */
  async dispose(): Promise<void> {
    this.closed = true
    clearTimeout(this.timer)
    await this.pending
    this.histogram.disable()
  }

  private async sample(): Promise<NodePressureSample> {
    const current = cpus().map(cpu => ({ ...cpu.times }))
    let idle = 0, total = 0
    for (let i = 0; i < current.length; i++) {
      const before = this.previous[i], after = current[i]!
      if (before === undefined) continue
      idle += after.idle - before.idle
      for (const key of ['user', 'nice', 'sys', 'idle', 'irq'] as const) total += after[key] - before[key]
    }
    this.previous = current
    if (total <= 0) throw new Error('host CPU observation did not advance')
    const eventLoopMs = this.histogram.percentile(99) / 1e6
    this.histogram.reset()
    let memory: NodePressureSample['memory']
    if (process.platform === 'darwin') {
      const { stdout } = await execute('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: this.config.sampleMs, maxBuffer: 1024 })
      memory = darwinMemoryPressure(stdout)
    } else {
      const info = await readFile('/proc/meminfo', 'utf8')
      const available = Number(/^MemAvailable:\s+(\d+)/m.exec(info)?.[1])
      const size = Number(/^MemTotal:\s+(\d+)/m.exec(info)?.[1])
      if (!Number.isFinite(available) || !Number.isFinite(size) || size <= 0) throw new Error('host available memory observation is missing')
      memory = available / size <= this.config.linuxMemoryReserveRatio ? 'warning' : 'normal'
    }
    return { cpu: Math.max(0, Math.min(1, 1 - idle / total)), memory, eventLoopMs, parallelism: availableParallelism() }
  }
}
