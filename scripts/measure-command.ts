/**
 * Measure a repeatable external command without adding instrumentation to the
 * product hot path. The command is spawned directly (never through a shell),
 * so callers can benchmark a built CLI or a focused compatibility fixture.
 *
 * Usage:
 *   pnpm run perf:command -- --label web-help -- node apps/cli/lib/bin.js --help
 */

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const DEFAULT_RUNS = 15
const DEFAULT_WARMUP = 3
const DEFAULT_TIMEOUT_MS = 120_000

/** Parsed command-measurement options. */
export interface CommandMeasureOptions {
  /** Human-readable scenario label. */
  readonly label: string
  /** Command executable. */
  readonly command: string
  /** Executable arguments. */
  readonly args: readonly string[]
  /** Number of recorded samples. */
  readonly runs: number
  /** Number of discarded warm-up runs. */
  readonly warmup: number
  /** Maximum duration of one invocation. */
  readonly timeoutMs: number
}

/** Summary statistics emitted by one scenario. */
export interface CommandMeasureSummary {
  /** Scenario label. */
  readonly label: string
  /** Command and arguments, kept as data rather than a shell string. */
  readonly argv: readonly string[]
  /** Node version used for the measurements. */
  readonly node: string
  /** Host platform and architecture. */
  readonly platform: string
  readonly arch: string
  /** Number of recorded samples. */
  readonly samples: number
  /** Wall-clock samples in milliseconds, ascending. */
  readonly durationsMs: readonly number[]
  /** Minimum sample. */
  readonly minMs: number
  /** Median sample. */
  readonly medianMs: number
  /** Nearest-rank P95 sample. */
  readonly p95Ms: number
  /** Maximum sample. */
  readonly maxMs: number
}

/** Parse a positive integer option. */
function positiveInteger(name: string, raw: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`measure-command: ${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

/** Parse CLI arguments; everything after `--` belongs to the child command. */
export function parseCommandMeasureArgs(argv: readonly string[]): CommandMeasureOptions {
  // `pnpm run script -- ...` forwards one wrapper separator; direct tsx
  // invocations do not. Normalize that launcher detail before parsing the
  // child-command separator owned by this script.
  const normalized = argv[0] === '--' ? argv.slice(1) : argv
  const separator = normalized.indexOf('--')
  if (separator < 0 || separator === normalized.length - 1) {
    throw new Error('measure-command: use --label <name> [--runs N] [--warmup N] -- <command> [args...]')
  }
  let label = 'command'
  let runs = DEFAULT_RUNS
  let warmup = DEFAULT_WARMUP
  let timeoutMs = DEFAULT_TIMEOUT_MS
  for (let index = 0; index < separator; index += 1) {
    const value = normalized[index]
    if (value === '--label') {
      label = normalized[++index] ?? ''
      if (label.trim() === '') throw new Error('measure-command: --label requires a non-empty value')
    } else if (value === '--runs') {
      runs = positiveInteger('--runs', normalized[++index] ?? '')
    } else if (value === '--warmup') {
      warmup = positiveInteger('--warmup', normalized[++index] ?? '')
    } else if (value === '--timeout-ms') {
      timeoutMs = positiveInteger('--timeout-ms', normalized[++index] ?? '')
    } else {
      throw new Error(`measure-command: unknown option ${JSON.stringify(value)}`)
    }
  }
  return {
    label,
    command: normalized[separator + 1] as string,
    args: normalized.slice(separator + 2),
    runs,
    warmup,
    timeoutMs,
  }
}

/** Return a nearest-rank percentile from sorted samples. */
function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index] as number
}

/** Summarize measured durations without smoothing or dropping slow samples. */
export function summarizeCommandDurations(
  options: Pick<CommandMeasureOptions, 'label' | 'command' | 'args'>,
  durations: readonly number[],
): CommandMeasureSummary {
  if (durations.length === 0) throw new Error('measure-command: at least one duration is required')
  const sorted = [...durations].sort((left, right) => left - right)
  return {
    label: options.label,
    argv: [options.command, ...options.args],
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    samples: sorted.length,
    durationsMs: sorted,
    minMs: sorted[0] as number,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1] as number,
  }
}

/** Run one child and return its wall-clock duration. */
async function measureOnce(options: CommandMeasureOptions): Promise<number> {
  const started = performance.now()
  const child = spawn(options.command, [...options.args], { stdio: 'ignore' })
  return await new Promise<number>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`measure-command: ${options.label} exceeded ${String(options.timeoutMs)}ms`))
    }, options.timeoutMs)
    const finish = (error: Error | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error !== undefined) reject(error)
      else resolve(performance.now() - started)
    }
    child.once('error', (error) => { finish(error) })
    child.once('close', (code, signal) => {
      if (code !== 0 || signal !== null) {
        finish(new Error(
          `measure-command: ${options.label} exited unsuccessfully (code=${String(code)}, signal=${String(signal)})`,
        ))
        return
      }
      finish(undefined)
    })
  })
}

/** Run warmups and recorded samples, then return the stable summary. */
export async function measureCommand(options: CommandMeasureOptions): Promise<CommandMeasureSummary> {
  for (let index = 0; index < options.warmup; index += 1) await measureOnce(options)
  const durations: number[] = []
  for (let index = 0; index < options.runs; index += 1) durations.push(await measureOnce(options))
  return summarizeCommandDurations(options, durations)
}

if (import.meta.main) {
  try {
    const options = parseCommandMeasureArgs(process.argv.slice(2))
    const summary = await measureCommand(options)
    console.log(JSON.stringify(summary, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
