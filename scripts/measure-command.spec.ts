import { describe, expect, it } from 'vitest'
import { parseCommandMeasureArgs, summarizeCommandDurations } from './measure-command.ts'

describe('measure-command', () => {
  it('keeps the child argv separate from measurement options', () => {
    expect(parseCommandMeasureArgs([
      '--', '--label', 'boot', '--runs', '5', '--warmup', '2', '--timeout-ms', '1000', '--',
      'node', '--version', '--flag',
    ])).toEqual({
      label: 'boot',
      command: 'node',
      args: ['--version', '--flag'],
      runs: 5,
      warmup: 2,
      timeoutMs: 1000,
    })
  })

  it('reports nearest-rank statistics without smoothing samples', () => {
    const summary = summarizeCommandDurations(
      { label: 'test', command: 'node', args: ['--version'] },
      [30, 10, 20, 40],
    )
    expect(summary.durationsMs).toEqual([10, 20, 30, 40])
    expect(summary.minMs).toBe(10)
    expect(summary.medianMs).toBe(20)
    expect(summary.p95Ms).toBe(40)
    expect(summary.maxMs).toBe(40)
  })

  it('rejects an absent child command', () => {
    expect(() => parseCommandMeasureArgs(['--label', 'missing'])).toThrow('use --label')
  })
})
