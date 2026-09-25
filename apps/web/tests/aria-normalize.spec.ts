/** Negative controls for prose-safe browser snapshot comparison. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { normalizeAria } from './aria-normalize.ts'

describe('ARIA runtime measurements', () => {
  const cwd = '/tmp/owned-workspace'
  it('preserves body UUIDs, quoted commands, deadlines, clocks and rates', () => {
    const snapshot = '- paragraph: \'123e4567-e89b-12d3-a456-426614174000 "echo ok" 2026-09-25T12:34:56Z 12:34 45s 20 tok/s\''
    expect(normalizeAria(snapshot, cwd)).toBe(snapshot)
    expect(normalizeAria(snapshot.replace('45s', '46s'), cwd)).not.toBe(normalizeAria(snapshot, cwd))
  })

  it('normalizes timing in its group while retaining identical prose outside it', () => {
    const snapshot = '- group "Message timing": 12:34 Ran for 45s\n- paragraph: 12:34 Ran for 45s\n- group "Session statistics":\n  - button "2 turns · 3 steps · 20 tok/s": 2 turns 3 steps 20 tok/s'
    const result = normalizeAria(snapshot, cwd)
    expect(result).toContain('group "Message timing": "{{clock}} Ran for {{duration}}"')
    expect(result).toContain('- paragraph: 12:34 Ran for 45s')
    expect(result).toContain('2 turns · 3 steps · {{throughput}} tok/s')
    expect(result).toContain('2 turns 3 steps {{throughput}} tok/s')
    expect(normalizeAria(snapshot.replaceAll('45s', '46s'), cwd)).not.toBe(result)
  })

  it('preserves counts, names, disabled state, order and business text that imitates YAML', () => {
    const snapshot = '- paragraph: |\n    - group "Message timing": 12:34 45s\n- group "Session statistics":\n  - button "2 turns · 3 steps · 20 tok/s" [disabled]\n  - button "Details"'
    const normalized = normalizeAria(snapshot, cwd)
    expect(normalized).toContain('- group "Message timing": 12:34 45s')
    expect(normalized).toContain('[disabled]')
    for (const [before, after] of [['2 turns', '3 turns'], ['[disabled]', '[pressed]'], ['Details', 'Other']]) {
      expect(normalizeAria(snapshot.replace(before!, after!), cwd)).not.toBe(normalized)
    }
  })

  it('normalizes declared paths without matching longer unrelated names', () => {
    const snapshot = '- text: /tmp/owned-workspace/file.txt\n- button "owned-workspace"\n- paragraph: /tmp/owned-workspace-backup owned-workspace-example'
    const normalized = normalizeAria(snapshot, cwd)
    expect(normalized).toContain('{{cwd}}/file.txt')
    expect(normalized).toContain('{{workspace}}')
    expect(normalized).toContain('/tmp/owned-workspace-backup owned-workspace-example')
  })

  it('rejects malformed snapshots instead of partially normalizing them', () => {
    expect(() => normalizeAria('- group: [', cwd)).toThrow('invalid ARIA snapshot')
  })

  it('normalizes localized statistics without touching localized prose', () => {
    const snapshot = '- group "本轮用时和速度":\n  - button "用时 2分42秒"\n- paragraph: 用时 2分42秒\n- group "消息时间与速度": 9月25日 12:34'
    const result = normalizeAria(snapshot, cwd)
    expect(result).toContain('{{duration}}')
    expect(result).toContain('{{clock}}')
    expect(result).toContain('- paragraph: 用时 2分42秒')
  })

  const cases = JSON.parse(readFileSync(new URL('../../../packages/test-support/session-snapshot/tests/fixtures/comparison-cases.json', import.meta.url), 'utf8')) as {
    name: string
    left: unknown
    right: unknown
    equal: boolean
  }[]
  it.each(cases.filter(item => !item.equal))('preserves shared negative control: $name', ({ left, right }) => {
    const aria = (value: unknown) => `- paragraph: ${JSON.stringify(JSON.stringify(value))}`
    expect(normalizeAria(aria(left), cwd)).not.toBe(normalizeAria(aria(right), cwd))
  })
})
