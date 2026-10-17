/** Search ranking, ties, CJK bigrams, excerpts, and empty-query behavior. */
import { expect, it } from 'vitest'
import type { MemoryScope } from '../src/index.ts'
import { memoryHarness, agentFor } from './harness.ts'
import { searchTerms } from '../src/search.ts'

const PERSONAL: MemoryScope = { kind: 'personal' }

async function bootWith(entries: { key: string; summary: string; content: string; kind?: 'profile' | 'guidance' | 'background' | 'resource' }[]) {
  const test = await memoryHarness()
  const agent = agentFor(test.ctx, 's1', { cwd: '/tmp/w' })
  for (const entry of entries) {
    const result = await test.service.save(
      { scope: PERSONAL, kind: entry.kind ?? 'guidance', summary: entry.summary, content: entry.content, key: entry.key },
      { kind: 'agent', agent },
    )
    if (!result.ok) throw new Error(`setup save ${entry.key} failed`)
  }
  return test
}

it('ranks by weighted fields: key hits outrank summary hits outrank content hits', async () => {
  const test = await bootWith([
    { key: 'release-freeze', summary: 'unrelated', content: 'unrelated' },
    { key: 'abc', summary: 'the release-freeze policy', content: 'unrelated' },
    { key: 'def', summary: 'unrelated', content: 'notes about release-freeze' },
  ])
  const hits = await test.service.search([PERSONAL], 'release-freeze')
  expect(Array.isArray(hits)).toBe(true)
  if (Array.isArray(hits)) {
    expect(hits.map(h => h.entry.key)).toEqual(['release-freeze', 'abc', 'def'])
  }
})

it('breaks score ties by updated.at desc then key asc', async () => {
  const test = await bootWith([
    { key: 'zeta', summary: 'term', content: 'x' },
    { key: 'alpha', summary: 'term', content: 'x' },
  ])
  const hits = await test.service.search([PERSONAL], 'term')
  if (Array.isArray(hits)) {
    // Same score; later updated.at first — alpha saved second.
    expect(hits[0]!.entry.key).toBe('alpha')
    expect(hits[1]!.entry.key).toBe('zeta')
  }
})

it('matches CJK runs and bigrams', async () => {
  const test = await bootWith([
    { key: 'cn', summary: '发布流程', content: '中文内容' },
    { key: 'latin', summary: 'english only', content: 'nothing relevant' },
  ])
  const hits = await test.service.search([PERSONAL], '发布')
  if (Array.isArray(hits)) {
    expect(hits.map(h => h.entry.key)).toEqual(['cn'])
  }
})

it('produces a bounded excerpt around the matching term, falling back to the summary', async () => {
  const body = 'A '.repeat(100) + 'needle' + ' B'.repeat(200)
  const test = await bootWith([
    { key: 'ex', summary: 'no term here', content: body },
  ])
  const hits = await test.service.search([PERSONAL], 'needle')
  if (Array.isArray(hits)) {
    expect(hits.length).toBe(1)
    const excerpt = hits[0]!.excerpt
    expect(Array.from(excerpt).length).toBeLessThanOrEqual(161) // 160 + ellipsis edges
    expect(excerpt).toContain('needle')
  }
})

it('returns a memory_invalid refusal on empty queries and drops zero-score entries', async () => {
  const test = await bootWith([{ key: 'a', summary: 'apple pie', content: 'tasty' }])
  expect(await test.service.search([PERSONAL], '   ')).toEqual({ ok: false, code: 'memory_invalid', reason: 'query' })
  const hits = await test.service.search([PERSONAL], 'zebra')
  if (Array.isArray(hits)) expect(hits).toEqual([])
})

it('caps results at searchMaxResults', async () => {
  const test = await memoryHarness({ config: { searchMaxResults: 2 } })
  const agent = agentFor(test.ctx, 's2', { cwd: '/tmp/w' })
  for (const key of ['a', 'b', 'c']) {
    await test.service.save(
      { scope: PERSONAL, kind: 'guidance', summary: 'term', content: 'x', key },
      { kind: 'agent', agent },
    )
  }
  const hits = await test.service.search([PERSONAL], 'term')
  if (Array.isArray(hits)) expect(hits.length).toBe(2)
})

it('skips entries outside the searched scopes', async () => {
  const test = await memoryHarness()
  const agent = agentFor(test.ctx, 's1', { cwd: '/tmp/w' })
  await test.service.save(
    { scope: PERSONAL, kind: 'guidance', summary: 'shared term', content: 'x', key: 'p1' },
    { kind: 'agent', agent },
  )
  await test.service.save(
    { scope: { kind: 'workspace', directory: '/tmp/w' }, kind: 'guidance', summary: 'shared term', content: 'x', key: 'w1' },
    { kind: 'agent', agent },
  )
  const hits = await test.service.search([PERSONAL], 'shared term')
  if (Array.isArray(hits)) expect(hits.map(h => h.entry.key)).toEqual(['p1'])
})

it('drops sub-2-character, duplicate, and lone-CJK terms', () => {
  expect(searchTerms('fix fix a 中')).toEqual(['fix'])
})

it('emits bigrams alongside the whole run for 3+ character CJK runs', () => {
  expect(searchTerms('发布会')).toEqual(['发布会', '发布', '布会'])
})
