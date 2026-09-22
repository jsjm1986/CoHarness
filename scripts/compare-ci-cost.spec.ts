/** Synthetic comparison fixtures exercise the evaluator; they are not CI performance measurements. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { compareCiCost, type CiCostComparison } from './compare-ci-cost.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function sample() {
  const measurement = () => ({
    context: {
      commit: 'a'.repeat(40), scopeSha256: 'b'.repeat(64),
      toolchain: { node: 'v24.20.0', pnpm: '11.7.0', lockSha256: 'c'.repeat(64) },
      runner: { os: 'Linux', architecture: 'x64', label: 'hosted', cpus: 4, memoryMiB: 16384 },
      cacheProfile: 'warm-dependencies-cold-build',
    },
    outcome: 'passed', evidence: ['synthetic-fixture-only'],
    runnerMs: { install: 100, build: 900, transfer: 0 }, wallMs: 1000,
  })
  const baseline = measurement()
  const candidate = measurement()
  candidate.runnerMs.build = 700
  return { id: 'pair-1', baseline, candidate }
}

function document() { return { version: 1, pairs: [sample()] } }

function cli(input: unknown, malformed = false): { exit: number | null; result: CiCostComparison } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ci-cost-'))
  roots.push(root)
  const path = join(root, 'samples.json')
  writeFileSync(path, malformed ? '{' : JSON.stringify(input))
  const result = spawnSync(process.execPath, [
    '--import', createRequire(import.meta.url).resolve('tsx/esm'),
    fileURLToPath(new URL('./compare-ci-cost.ts', import.meta.url)), path,
  ], { cwd: root, encoding: 'utf8', timeout: 15_000 })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return { exit: result.status, result: JSON.parse(result.stdout) as CiCostComparison }
}

describe('CI cost comparison', () => {
  it('retains exactly 10% runner savings with equal median and a 5% maximum increase', () => {
    const pairs = [sample(), sample(), sample()].map((pair, index) => {
      pair.id = `pair-${index}`
      pair.candidate.runnerMs = { install: 100, build: 780, transfer: 20 }
      pair.candidate.wallMs = [950, 1000, 1050][index] ?? 0
      return pair
    })
    const result = compareCiCost({ version: 1, pairs })
    expect(result.decision).toBe('retain')
    expect(result.metrics?.baseline).toEqual({ runnerMs: 3000, wallMedianMs: 1000, wallMaxMs: 1000 })
    expect(result.metrics?.candidate).toEqual({ runnerMs: 2700, wallMedianMs: 1000, wallMaxMs: 1050 })
  })

  it('counts transfer and repeated install cost instead of reporting the build saving alone', () => {
    const input = document()
    input.pairs[0]!.candidate.runnerMs = { install: 250, build: 400, transfer: 300 }
    const result = compareCiCost(input)
    expect(result.decision).toBe('reject')
    expect(result.metrics?.candidate.runnerMs).toBe(950)
  })

  it('uses both middle wall samples for a two-pair median', () => {
    const first = sample()
    const second = sample()
    second.id = 'pair-2'
    first.baseline.wallMs = first.candidate.wallMs = 800
    second.baseline.wallMs = second.candidate.wallMs = 1000
    expect(compareCiCost({ version: 1, pairs: [first, second] }).metrics?.candidate.wallMedianMs).toBe(900)
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('refuses invalid measured cost %j', (value) => {
    const pair = sample()
    pair.candidate.runnerMs.build = value
    expect(compareCiCost({ version: 1, pairs: [pair] }).decision).toBe('incomparable')
  })

  it.each(['median', 'worst'] as const)('rejects %s wall-clock regressions despite sufficient compute savings', (kind) => {
    const pairs = [sample(), sample(), sample()].map((pair, index) => {
      pair.id = String(index)
      pair.candidate.wallMs = kind === 'median' ? 1001 : index === 2 ? 1051 : 900
      return pair
    })
    expect(compareCiCost({ version: 1, pairs }).decision).toBe('reject')
  })

  it.each(['commit', 'scope', 'toolchain', 'runner', 'cache'] as const)('rejects incomparable %s inputs without reporting gains', (field) => {
    const pair = sample()
    if (field === 'commit') pair.candidate.context.commit = 'd'.repeat(40)
    if (field === 'scope') pair.candidate.context.scopeSha256 = 'd'.repeat(64)
    if (field === 'toolchain') pair.candidate.context.toolchain.node = 'v24.20.1'
    if (field === 'runner') pair.candidate.context.runner.cpus = 8
    if (field === 'cache') pair.candidate.context.cacheProfile = 'different'
    expect(compareCiCost({ version: 1, pairs: [pair] })).toMatchObject({ decision: 'incomparable' })
    expect(compareCiCost({ version: 1, pairs: [pair] }).metrics).toBeUndefined()
  })

  it.each(['failed', 'cancelled', 'skipped'])('does not drop a %s observation to improve the remaining samples', (outcome) => {
    const first = sample()
    const second = sample()
    second.id = 'pair-2'
    second.candidate.outcome = outcome
    expect(compareCiCost({ version: 1, pairs: [first, second] }).decision).toBe('incomparable')
  })

  it('requires original measurement references and complete phase timings', () => {
    const pair = sample()
    pair.candidate.evidence = []
    expect(compareCiCost({ version: 1, pairs: [pair] }).decision).toBe('incomparable')
    pair.candidate.evidence = ['synthetic-fixture-only']
    expect(compareCiCost({ version: 1, pairs: [{ ...pair, candidate: { ...pair.candidate, runnerMs: { build: 1 } } }] }).decision)
      .toBe('incomparable')
  })

  it('limits experiment count and refuses duplicated groups or mixed source revisions', () => {
    expect(compareCiCost({ version: 1, pairs: [] }).decision).toBe('incomparable')
    expect(compareCiCost({ version: 1, pairs: [sample(), sample(), sample(), sample()] }).decision).toBe('incomparable')
    expect(compareCiCost({ version: 1, pairs: [sample(), sample()] }).decision).toBe('incomparable')
    const second = sample()
    second.id = 'pair-2'
    second.baseline.context.commit = 'd'.repeat(40)
    second.candidate.context.commit = 'd'.repeat(40)
    expect(compareCiCost({ version: 1, pairs: [sample(), second] }).decision).toBe('incomparable')
  })

  it('allows paired cold/warm profiles but not different hardware across groups', () => {
    const second = sample()
    second.id = 'pair-2'
    second.baseline.context.cacheProfile = second.candidate.context.cacheProfile = 'cold'
    expect(compareCiCost({ version: 1, pairs: [sample(), second] }).decision).toBe('retain')
    second.baseline.context.runner.cpus = second.candidate.context.runner.cpus = 8
    expect(compareCiCost({ version: 1, pairs: [sample(), second] }).decision).toBe('incomparable')
  })

  it.each(['retain', 'reject', 'incomparable'] as const)('returns %s with its machine-readable exit status through the actual CLI', (decision) => {
    const input = document()
    if (decision === 'reject') input.pairs[0]!.candidate.runnerMs.build = 850
    if (decision === 'incomparable') input.pairs[0]!.candidate.evidence = []
    const result = cli(input)
    expect(result.result.decision).toBe(decision)
    expect(result.exit).toBe(decision === 'retain' ? 0 : decision === 'reject' ? 1 : 2)
  })

  it('reports unreadable JSON as incomparable through the actual CLI', () => {
    const result = cli(null, true)
    expect(result.exit).toBe(2)
    expect(result.result.decision).toBe('incomparable')
  })
})
