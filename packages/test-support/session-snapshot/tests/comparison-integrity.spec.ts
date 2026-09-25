/** Negative controls for the comparison used by actual ACP replay suites. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeSessionLog, normalizeSessionSnapshots, normalizeStdout, scrubSystemPrompts } from '../src/normalize.ts'

const parent = '11111111-1111-4111-8111-111111111111'
const child = '22222222-2222-4222-8222-222222222222'
const unrelated = '33333333-3333-4333-8333-333333333333'
const context = { sessionIds: [parent, child], cwd: '/tmp/comparison-work' }

describe('replay comparison integrity', () => {
  it('rejects a notification delivered to the wrong Session', () => {
    const frame = (sessionId: string) => JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, text: 'same output' } })
    expect(normalizeStdout(frame(parent), context)).not.toBe(normalizeStdout(frame(child), context))
  })

  it('preserves unrelated UUIDs, command quotes, business clocks and expiry values', () => {
    for (const [left, right] of [
      [`ticket ${unrelated}`, `ticket ${child}`],
      ['echo “hello”', 'echo "hello"'],
      ['deadline 2026-09-25T13:00:00Z', 'deadline 2026-09-25T14:00:00Z'],
      ['expires in 30s', 'expires in 60s'],
    ] as const) {
      const frame = (text: string) => JSON.stringify({ jsonrpc: '2.0', result: { text } })
      expect(normalizeStdout(frame(left), context)).not.toBe(normalizeStdout(frame(right), context))
    }
  })

  it('normalizes ACP occupancy only on its protocol update, preserving nested lookalikes', () => {
    const output = normalizeStdout(JSON.stringify({ jsonrpc: '2.0', result: {
      sessionUpdate: 'usage_update', used: 42, details: { used: 64 },
    } }), context)
    expect(JSON.parse(output).result).toEqual({ sessionUpdate: 'usage_update', used: 42, details: { used: 64 } })
  })

  it('compares parent and child references with one shared identity map', () => {
    const logs = (target: string) => [
      [{ type: 'session', id: parent }, { type: 'example', data: { sessionId: target } }],
      [{ type: 'session', id: child, parentSession: parent }],
    ].map(rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    expect(normalizeSessionSnapshots(logs(parent), context))
      .not.toEqual(normalizeSessionSnapshots(logs(child), context))
  })

  it('distinguishes empty system messages from nonempty prompts and preserves additional blocks', () => {
    const event = (content: unknown[]) => JSON.stringify({ type: 'system/message', data: { message: { content } } })
    const populated = scrubSystemPrompts(event([{ type: 'text', text: 'prompt' }]))
    expect(scrubSystemPrompts(event([]))).not.toBe(populated)
    expect(scrubSystemPrompts(event([{ type: 'text', text: '' }]))).not.toBe(populated)
    expect(scrubSystemPrompts(event([{ type: 'text', text: 'prompt' }, { type: 'text', text: 'extra rule' }])))
      .toContain('extra rule')
  })
})

const commonCases = JSON.parse(readFileSync(new URL('./fixtures/comparison-cases.json', import.meta.url), 'utf8')) as {
  name: string; left: Record<string, unknown>[]; right: Record<string, unknown>[]; equal: boolean
}[]

it.each(commonCases)('shares Python comparison rule: $name', ({ left, right, equal }) => {
  const normalize = (rows: Record<string, unknown>[]) => normalizeSessionLog(
    rows.map(row => JSON.stringify(row)).join('\n'), { sessionIds: [], cwd: '/comparison-work' },
  )
  expect(normalize(left) === normalize(right)).toBe(equal)
})
