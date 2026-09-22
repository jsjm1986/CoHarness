import { describe, expect, it } from 'vitest'
import { changedGoldenPaths } from './summarize-golden-changes.ts'
import { assertRequiredCiVerdict } from './verify-github-protection.ts'

describe('gate review signals', () => {
  it('keeps Markdown goldens visible without flagging ordinary docs', () => {
    expect(changedGoldenPaths(['docs/testing.md', 'apps/web/tests/snapshots/chat/ui.expected.md', 'snapshots/acp/session.jsonl']))
      .toEqual(['apps/web/tests/snapshots/chat/ui.expected.md', 'snapshots/acp/session.jsonl'])
  })
  it('rejects absent, unbound or differently named required checks', () => {
    expect(() =>{  assertRequiredCiVerdict({ checks: [{ context: 'all checks passed', app_id: 15368 }] }) }).not.toThrow()
    for (const raw of [{ checks: [] }, { contexts: ['all checks passed'] }, { checks: [{ context: 'all checks passed', app_id: null }] }]) {
      expect(() =>{  assertRequiredCiVerdict(raw) }).toThrow('must be required')
    }
  })
})
