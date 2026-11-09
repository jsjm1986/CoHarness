/** Host pressure sampling and paced admission; running work has no numeric ceiling. */
import { readFile } from 'node:fs/promises'
import { availableParallelism, cpus, freemem, totalmem } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { runGatewayChildCommand } from './child-command.ts'

/** Host pressure metrics used to calculate admission credits. */
export interface NodePressureSample {
  cpu: number
  memory: 'normal' | 'warning' | 'critical'
  /** Linux MemAvailable / MemTotal; the coordinator applies its committed reserve. */
  memoryAvailableRatio?: number
  eventLoopMs: number
  parallelism: number
}

/** Local capture time follows its metrics through sensor and database waits. */
export interface NodePressureObservation extends NodePressureSample {
  /** Process-monotonic milliseconds captured before reading host metrics. */
  readonly capturedAt: number
}

/** Deployment thresholds and observation timing, independent of task counts. */
export interface NodePressureConfig {
  sampleMs: number
  staleMs: number
  cpuTarget: number
  eventLoopTargetMs: number
  linuxMemoryReserveRatio: number
}

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
  if (sample.memory !== 'normal'
    || (sample.memoryAvailableRatio !== undefined && sample.memoryAvailableRatio <= config.linuxMemoryReserveRatio)
    || sample.cpu >= config.cpuTarget || sample.eventLoopMs >= config.eventLoopTargetMs) return 0
  return Math.max(1, Math.floor(sample.parallelism * (1 - sample.cpu)))
}

/** Single-owner sampler; disposal joins its pending measurement and publication. */
export class NodeResourcePressure {
  private previous = cpus().map(cpu => ({ ...cpu.times }))
  private readonly histogram = monitorEventLoopDelay({ resolution: 20 })
  private timer: NodeJS.Timeout | undefined
  private pending: Promise<void> = Promise.resolve()
  private closed = false
  /** @param config - validated thresholds. @param publish - durable node observation writer. @param failed - bounded diagnostic callback. @param enabled - current lifecycle permission to capture another observation. */
  constructor(private readonly config: NodePressureConfig, private readonly publish: (sample: NodePressureObservation) => Promise<void>, private readonly failed: (error: unknown) => void, private readonly enabled: () => boolean) {}

  /** Begin observations; the first publication follows one full CPU interval. */
  start(): void {
    if (this.timer !== undefined || this.closed) throw new Error('pressure sampler already started or closed')
    if (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32') throw new Error('node pressure admission requires macOS, Linux or Windows')
    this.histogram.enable()
    const tick = (): void => {
      this.pending = Promise.resolve().then(async () => {
        if (this.enabled()) await this.publish(await this.sample())
      }).catch(this.failed).finally(() => {
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

  private async sample(): Promise<NodePressureObservation> {
    const capturedAt = performance.now()
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
    let memoryAvailableRatio: number | undefined
    if (process.platform === 'darwin') {
      const { stdout } = await runGatewayChildCommand('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], this.config.sampleMs, undefined, 1024)
      memory = darwinMemoryPressure(stdout)
    } else if (process.platform === 'win32') {
      // Windows exposes no pressure flag; GlobalMemoryStatus free/total gives
      // the same availability ratio the coordinator's reserve applies to.
      const size = totalmem()
      if (size <= 0) throw new Error('host available memory observation is missing')
      memoryAvailableRatio = freemem() / size
      memory = 'normal'
    } else {
      const info = await readFile('/proc/meminfo', 'utf8')
      const available = Number(/^MemAvailable:\s+(\d+)/m.exec(info)?.[1])
      const size = Number(/^MemTotal:\s+(\d+)/m.exec(info)?.[1])
      if (!Number.isFinite(available) || !Number.isFinite(size) || size <= 0) throw new Error('host available memory observation is missing')
      memoryAvailableRatio = available / size
      memory = 'normal'
    }
    return { capturedAt, cpu: Math.max(0, Math.min(1, 1 - idle / total)), memory,
      ...(memoryAvailableRatio === undefined ? {} : { memoryAvailableRatio }), eventLoopMs, parallelism: availableParallelism() }
  }
}
