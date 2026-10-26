/** Scalar summary ownership, byte bounds, recency eviction and closed-owner behavior. */
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { expect, it } from 'vitest'
import { ColdSummaryCache } from '../src/cold-summary-cache.ts'
import type { ColdSessionSummary, ColdSummarySource } from '../src/cold-summary-cache.ts'

function row(name: string): { source: ColdSummarySource; summary: ColdSessionSummary } {
  const id = SessionId(name)
  return {
    source: { header: { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false },
      revision: SessionPersistenceRevision('stable-' + name) },
    summary: { sessionId: id, updatedAt: 1, running: false, blank: true },
  }
}

it('counts multibyte metadata against the byte bound', () => {
  const cache = new ColdSummaryCache(10, 1024)
  const a = row('a')
  const b = row('b')
  a.summary.agentPreset = '字'.repeat(180)
  b.summary.agentPreset = '字'.repeat(180)
  cache.set(a.source, a.summary)
  expect(cache.get(a.source)).toEqual(a.summary)
  cache.set(b.source, b.summary)
  expect(cache.get(a.source)).toBeUndefined()
  expect(cache.get(b.source)).toEqual(b.summary)
})

it('drops an oversized replacement without retaining its previous revision', () => {
  const cache = new ColdSummaryCache(10, 1024)
  const a = row('a')
  cache.set(a.source, a.summary)
  cache.set(a.source, { ...a.summary, agentPreset: '字'.repeat(1024) })
  expect(cache.get(a.source)).toBeUndefined()
})

it('refreshes recency only for a matching source and removes stale revisions', () => {
  const cache = new ColdSummaryCache(2, 8192)
  const a = row('a')
  const b = row('b')
  const c = row('c')
  cache.set(a.source, a.summary)
  cache.set(b.source, b.summary)
  expect(cache.get(a.source)).toEqual(a.summary)
  cache.set(c.source, c.summary)
  expect(cache.get(b.source)).toBeUndefined()
  expect(cache.get({ ...a.source, revision: SessionPersistenceRevision('changed') })).toBeUndefined()
  expect(cache.get(a.source)).toBeUndefined()
})

it('releases rows on close and ignores late completed writes', () => {
  const cache = new ColdSummaryCache(2, 8192)
  const a = row('a')
  cache.set(a.source, a.summary)
  cache.close()
  cache.set(a.source, a.summary)
  cache.close()
  expect(cache.enabled).toBe(false)
  expect(cache.get(a.source)).toBeUndefined()
})

it('does not admit snapshots without a provider revision', () => {
  const cache = new ColdSummaryCache(2, 8192)
  const a = row('a')
  const source = { header: a.source.header }
  cache.set(source, a.summary)
  expect(cache.get(source)).toBeUndefined()
})
