/** Compare at most three recorded CI experiments without executing commands or changing gate policy. */
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'

/** Summaries include every supplied pair; failed or incompatible evidence is never discarded. */
export interface CiCostComparison {
  readonly version: 1
  readonly decision: 'retain' | 'reject' | 'incomparable'
  readonly reasons: readonly string[]
  readonly samples: number
  readonly metrics?: {
    readonly baseline: CostTotals
    readonly candidate: CostTotals
    readonly runnerReductionPercent: number
  }
}

interface CostTotals {
  readonly runnerMs: number
  readonly wallMedianMs: number
  readonly wallMaxMs: number
}

interface Measurement {
  context: Record<string, unknown>
  runnerMs: number
  wallMs: number
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be recorded`)
  return value
}

function duration(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative measured duration`)
  return value
}

function measurement(raw: unknown, label: string): Measurement {
  const value = record(raw, label)
  if (value.outcome !== 'passed') throw new Error(`${label} did not pass its complete selected verification`)
  if (!Array.isArray(value.evidence) || value.evidence.length === 0
    || value.evidence.some((reference: unknown) => typeof reference !== 'string' || reference.trim() === '')) {
    throw new Error(`${label} has no original measurement evidence`)
  }
  const context = record(value.context, `${label}.context`)
  if (!/^[a-f0-9]{40}$/.test(text(context.commit, `${label}.commit`))) throw new Error(`${label} needs a full commit identity`)
  if (!/^[a-f0-9]{64}$/.test(text(context.scopeSha256, `${label}.scopeSha256`))) throw new Error(`${label} needs a validation-scope digest`)
  const toolchain = record(context.toolchain, `${label}.toolchain`)
  for (const name of ['node', 'pnpm']) {
    if (!/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(text(toolchain[name], `${label}.toolchain.${name}`))) {
      throw new Error(`${label}.toolchain.${name} must name an exact version`)
    }
  }
  if (!/^[a-f0-9]{64}$/.test(text(toolchain.lockSha256, `${label}.toolchain.lockSha256`))) {
    throw new Error(`${label} needs a dependency-lock digest`)
  }
  const runner = record(context.runner, `${label}.runner`)
  for (const name of ['os', 'architecture', 'label']) text(runner[name], `${label}.runner.${name}`)
  for (const name of ['cpus', 'memoryMiB']) {
    if (!Number.isSafeInteger(runner[name]) || Number(runner[name]) < 1) throw new Error(`${label}.runner.${name} must be recorded`)
  }
  text(context.cacheProfile, `${label}.cacheProfile`)
  const stages = record(value.runnerMs, `${label}.runnerMs`)
  const runnerMs = ['install', 'build', 'transfer'].reduce((sum, name) => sum + duration(stages[name], `${label}.runnerMs.${name}`), 0)
  if (!Number.isFinite(runnerMs) || runnerMs <= 0) throw new Error(`${label} has no positive measured runner cost`)
  const wallMs = duration(value.wallMs, `${label}.wallMs`)
  if (wallMs <= 0) throw new Error(`${label} has no positive wall-clock observation`)
  return { context, runnerMs, wallMs }
}

function totals(samples: readonly Measurement[]): CostTotals {
  const walls = samples.map(sample => sample.wallMs).sort((left, right) => left - right)
  const lower = walls[Math.floor((walls.length - 1) / 2)]
  const upper = walls[Math.floor(walls.length / 2)]
  const runnerMs = samples.reduce((sum, sample) => sum + sample.runnerMs, 0)
  if (lower === undefined || upper === undefined || !Number.isFinite(runnerMs)) throw new Error('invalid aggregate measurements')
  return {
    runnerMs,
    wallMedianMs: lower / 2 + upper / 2,
    wallMaxMs: Math.max(...walls),
  }
}

/** Evaluate paired measurements supplied by an evidence collector; this does not authenticate its references.
 * @param input - version 1 document containing one to three baseline/candidate pairs.
 * @returns retain only with at least 10% total runner savings, no median slowdown and at most 5% worst-case slowdown.
 */
export function compareCiCost(input: unknown): CiCostComparison {
  let samples = 0
  try {
    const document = record(input, 'cost samples')
    if (document.version !== 1) throw new Error('unsupported cost-sample version')
    if (!Array.isArray(document.pairs) || document.pairs.length < 1 || document.pairs.length > 3) {
      throw new Error('one to three paired experiments are required')
    }
    samples = document.pairs.length
    const baseline: Measurement[] = []
    const candidate: Measurement[] = []
    const ids = new Set<string>()
    for (const [index, raw] of document.pairs.entries()) {
      const pair = record(raw, `pair ${index + 1}`)
      const id = text(pair.id, `pair ${index + 1} id`)
      if (ids.has(id)) throw new Error(`duplicate sample identity ${id}`)
      ids.add(id)
      const before = measurement(pair.baseline, `${id}.baseline`)
      const after = measurement(pair.candidate, `${id}.candidate`)
      if (!isDeepStrictEqual(before.context, after.context)) throw new Error(`${id} has different source, scope, toolchain, runner or cache profiles`)
      // Different warm/cold groups are paired within their own profile, but all
      // groups must still use the same source, verification scope and hardware/toolchain.
      const first = baseline[0]
      if (first !== undefined
        && ['commit', 'scopeSha256', 'toolchain', 'runner'].some(field => !isDeepStrictEqual(first.context[field], before.context[field]))) {
        throw new Error('experiment groups have different commits, validation scopes, toolchains or runners')
      }
      baseline.push(before)
      candidate.push(after)
    }
    const before = totals(baseline)
    const after = totals(candidate)
    const reasons: string[] = []
    if (after.runnerMs > before.runnerMs * 0.9) reasons.push('total install/build/transfer runner savings are below 10%')
    if (after.wallMedianMs > before.wallMedianMs) reasons.push('median end-to-end wall time increased')
    if (after.wallMaxMs > before.wallMaxMs * 1.05) reasons.push('worst end-to-end wall time increased by more than 5%')
    return { version: 1, decision: reasons.length === 0 ? 'retain' : 'reject', reasons, samples,
      metrics: { baseline: before, candidate: after, runnerReductionPercent: (1 - after.runnerMs / before.runnerMs) * 100 } }
  } catch (error) {
    return { version: 1, decision: 'incomparable', reasons: [error instanceof Error ? error.message : String(error)], samples }
  }
}

if (import.meta.main) {
  let result: CiCostComparison
  try {
    if (process.argv.length !== 3) throw new Error('usage: compare-ci-cost.ts SAMPLES.json')
    result = compareCiCost(JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as unknown)
  } catch (error) {
    result = { version: 1, decision: 'incomparable', reasons: [error instanceof Error ? error.message : String(error)], samples: 0 }
  }
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.decision === 'retain' ? 0 : result.decision === 'reject' ? 1 : 2
}
