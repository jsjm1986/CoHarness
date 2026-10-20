/** Memory service: validation bounds, write rules, scope admission, authorization, concurrency. */
import { expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  memoryConsolidationCursorKey,
  memoryExtractionCursorKey,
  MemoryKey,
  MemoryRevision,
  type MemoryScope,
  type MemorySwitches,
} from '../src/index.ts'
import { agentFor, fakeAuthority, memoryHarness, settingsStub } from './harness.ts'

const PERSONAL: MemoryScope = { kind: 'personal' }

async function boot(
  config?: { space?: 'personal' | 'project'; entryMaxBytes?: number; summaryMaxChars?: number; maxEntriesPerScope?: number; searchMaxResults?: number },
  header: { cwd?: string; sshTarget?: number } = { cwd: '/tmp/work' },
) {
  const test = await memoryHarness(config === undefined ? {} : { config })
  const agent = agentFor(test.ctx, 'a1', header)
  const writer = { kind: 'agent' as const, agent }
  const save = (request: { scope?: MemoryScope; key: string; kind?: 'profile' | 'guidance' | 'background' | 'resource'; summary?: string; content?: string; expectedRevision?: ReturnType<typeof MemoryRevision> }) =>
    test.service.save({ scope: PERSONAL, kind: 'guidance', summary: 's', content: 'c', ...request }, writer)
  return { ...test, agent, writer, save }
}

// ── validation ────────────────────────────────────────────────────────────────

it('accepts a 64-char key and refuses 65 chars and bad patterns', async () => {
  const test = await boot()
  expect((await test.save({ key: 'a'.repeat(64) })).ok).toBe(true)
  for (const key of ['a'.repeat(65), 'UPPER', 'with_underscore', '--dashes', 'a--b', 'ends-', '-starts', 'has space', 'dot.key', '']) {
    const result = await test.save({ key })
    expect(result.ok, `key "${key}"`).toBe(false)
    if (!result.ok) expect(result.reason).toBe('key')
  }
})

it('bounds summary by code points including multibyte characters', async () => {
  const test = await boot({ summaryMaxChars: 20 })
  expect((await test.save({ key: 'ok', summary: 'x'.repeat(20) })).ok).toBe(true)
  expect(await test.save({ key: 'over', summary: 'x'.repeat(21) })).toMatchObject({ ok: false, reason: 'summary' })
  // 20 multibyte code points (CJK) is fine; 21 is not.
  expect((await test.save({ key: 'cjk-ok', summary: '中'.repeat(20) })).ok).toBe(true)
  expect(await test.save({ key: 'cjk-over', summary: '中'.repeat(21) })).toMatchObject({ ok: false, reason: 'summary' })
  // Newlines and empty summaries refuse too.
  expect(await test.save({ key: 'nl', summary: 'a\nb' })).toMatchObject({ ok: false, reason: 'summary' })
  expect(await test.save({ key: 'blank', summary: '   ' })).toMatchObject({ ok: false, reason: 'summary' })
})

it('bounds content by UTF-8 bytes at the multibyte edge', async () => {
  const test = await boot({ entryMaxBytes: 256 })
  // 253 ASCII + one 3-byte CJK = exactly 256 bytes.
  const exact = 'x'.repeat(253) + '中'
  expect(Buffer.byteLength(exact, 'utf8')).toBe(256)
  expect((await test.save({ key: 'exact', content: exact })).ok).toBe(true)
  expect(await test.save({ key: 'over', content: 'x'.repeat(254) + '中' })).toMatchObject({ ok: false, reason: 'content' })
  expect(await test.save({ key: 'empty', content: '  ' })).toMatchObject({ ok: false, reason: 'content' })
})

// ── write rules ───────────────────────────────────────────────────────────────

it('serializes create / replace / stale / not-found / delete correctly', async () => {
  const test = await boot()
  const created = await test.save({ key: 'k' })
  expect(created).toMatchObject({ ok: true, operation: 'create' })
  expect(await test.save({ key: 'k' })).toMatchObject({ ok: false, code: 'memory_exists' })

  expect(await test.save({ key: 'k', expectedRevision: MemoryRevision('wrong') })).toMatchObject({ ok: false, code: 'memory_stale' })
  expect(await test.save({ key: 'nope', expectedRevision: MemoryRevision('any') })).toMatchObject({ ok: false, code: 'memory_not_found' })

  if (created.ok) {
    const updated = await test.save({ key: 'k', expectedRevision: created.entry.revision, content: 'new' })
    expect(updated).toMatchObject({ ok: true, operation: 'update' })
    if (updated.ok && updated.previous) expect(updated.previous.content).toBe('c')
    // Delete with stale revision refuses; without revision removes.
    const staleDelete = await test.service.delete({ scope: PERSONAL, key: 'k', expectedRevision: MemoryRevision('old') }, test.writer)
    expect(staleDelete).toMatchObject({ ok: false, code: 'memory_stale' })
    const removed = await test.service.delete({ scope: PERSONAL, key: 'k' }, test.writer)
    expect(removed).toMatchObject({ ok: true, operation: 'delete' })
    expect(await test.service.read(PERSONAL, 'k')).toBeUndefined()
    expect(await test.service.delete({ scope: PERSONAL, key: 'k' }, test.writer)).toMatchObject({ ok: false, code: 'memory_not_found' })
  }
})

it('refuses new creates at the scope cap but still allows replace and delete', async () => {
  const test = await boot({ maxEntriesPerScope: 2 })
  await test.save({ key: 'one' })
  await test.save({ key: 'two' })
  expect(await test.save({ key: 'three' })).toMatchObject({ ok: false, code: 'memory_full' })
  const read = await test.service.read(PERSONAL, 'one')
  expect(read).toBeDefined()
  // Replace works at the cap; delete too.
  expect((await test.save({ key: 'one', expectedRevision: MemoryRevision(read!.revision), content: 'r' })).ok).toBe(true)
  expect((await test.service.delete({ scope: PERSONAL, key: 'two' }, test.writer)).ok).toBe(true)
  expect((await test.save({ key: 'three' })).ok).toBe(true)
})

// ── scopes ────────────────────────────────────────────────────────────────────

it('resolves scopesFor with workspace identity keyed by cwd plus sshTarget', async () => {
  const test = await boot()
  const scopes = test.service.scopesFor(test.agent)
  expect(scopes[0]).toEqual({ kind: 'personal' })
  expect(scopes[1]).toEqual({ kind: 'workspace', directory: '/tmp/work' })
  // No cwd → personal only.
  const noCwd = await boot(undefined, {})
  expect(noCwd.service.scopesFor(noCwd.agent)).toEqual([{ kind: 'personal' }])
})

it('enforces own-workspace writes and workspace scope availability', async () => {
  const test = await boot()
  const own: MemoryScope = { kind: 'workspace', directory: '/tmp/work' }
  expect((await test.save({ scope: own, key: 'w' })).ok).toBe(true)
  const foreign: MemoryScope = { kind: 'workspace', directory: '/tmp/other' }
  expect(await test.save({ scope: foreign, key: 'x', kind: 'guidance', summary: 's', content: 'c' })).toMatchObject({ ok: false, reason: 'workspace-mismatch' })
  // sshTarget distinguishes identity: same dir over SSH is a different scope.
  const ssh: MemoryScope = { kind: 'workspace', directory: '/tmp/work', sshTarget: 7 }
  expect(await test.save({ scope: ssh, key: 'x', kind: 'guidance', summary: 's', content: 'c' })).toMatchObject({ ok: false, reason: 'workspace-mismatch' })
  // cwd-less session: workspace is unavailable entirely.
  const noCwd = await boot(undefined, {})
  expect(await noCwd.service.save({ scope: { kind: 'workspace', directory: '/tmp/work' }, key: 'x', kind: 'guidance', summary: 's', content: 'c' }, noCwd.writer)).toMatchObject({ ok: false, reason: 'scope-unavailable' })
  // Project scope is not addressable in personal space.
  expect(await test.save({ scope: { kind: 'project' }, key: 'x', kind: 'guidance', summary: 's', content: 'c' })).toMatchObject({ ok: false, reason: 'scope-unavailable' })
})

// ── project authorization ─────────────────────────────────────────────────────

it('authorizes project writes and records the primary actor user id', async () => {
  const test = await memoryHarness({ config: { space: 'project' } })
  test.ctx.provide('executionAuthority', fakeAuthority({ primaryActorUserId: 42 }))
  const agent = agentFor(test.ctx, 'pa', {})
  const result = await test.service.save(
    { scope: { kind: 'project' }, key: 'team-fact', kind: 'guidance', summary: 's', content: 'c' },
    { kind: 'agent', agent },
  )
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.entry.updated.userId).toBe(42)
})

it('propagates an authority denial and writes nothing', async () => {
  const test = await memoryHarness({ config: { space: 'project' } })
  test.ctx.provide('executionAuthority', fakeAuthority(new RemoteError('execution/forbidden', 'denied', { capability: 'memory' })))
  const agent = agentFor(test.ctx, 'pd', {})
  await expect(test.service.save(
    { scope: { kind: 'project' }, key: 'x', kind: 'guidance', summary: 's', content: 'c' },
    { kind: 'agent', agent },
  )).rejects.toMatchObject({ code: 'execution/forbidden' })
  expect(await test.service.read({ kind: 'project' }, 'x')).toBeUndefined()
})

it('refuses when executionAuthorityRequired is set and no provider exists', async () => {
  const test = await memoryHarness({ config: { space: 'project' } })
  test.ctx.provide('executionAuthorityRequired', true)
  const agent = agentFor(test.ctx, 'pr', {})
  await expect(test.service.save(
    { scope: { kind: 'project' }, key: 'x', kind: 'guidance', summary: 's', content: 'c' },
    { kind: 'agent', agent },
  )).rejects.toMatchObject({ code: 'execution/forbidden' })
})

// ── concurrency ───────────────────────────────────────────────────────────────

it('serializes concurrent creates so exactly one wins', async () => {
  const test = await boot()
  const [a, b] = await Promise.all([test.save({ key: 'race' }), test.save({ key: 'race' })])
  const results = [a, b]
  expect(results.filter(r => r.ok).length).toBe(1)
  expect(results.filter(r => !r.ok && r.code === 'memory_exists').length).toBe(1)
})

// ── curation support ─────────────────────────────────────────────────────────

it('stamps the writer source on created attribution and keeps agent as the default', async () => {
  const test = await boot()
  const extracted = await test.service.save(
    { scope: PERSONAL, key: 'mine', kind: 'background', summary: 's', content: 'c' },
    { kind: 'agent', agent: test.agent, source: 'extraction' },
  )
  expect(extracted.ok).toBe(true)
  if (extracted.ok) {
    expect(extracted.entry.created.source).toBe('extraction')
    expect(extracted.entry.updated.source).toBe('extraction')
    expect(extracted.entry.updated.sessionId).toBe(test.agent.session.id)
  }
  const plain = await test.save({ key: 'other' })
  expect(plain.ok).toBe(true)
  if (plain.ok) expect(plain.entry.updated.source).toBe('agent')
})

it('persists cursors and bumps changedSince on each committed save and delete', async () => {
  const test = await boot()
  const cursorKey = memoryConsolidationCursorKey(PERSONAL)
  expect(await test.service.getCursor(cursorKey)).toBeUndefined()

  await test.save({ key: 'one' })
  expect((await test.service.getCursor(cursorKey))?.changedSince).toBe(1)
  await test.save({ key: 'two' })
  expect((await test.service.getCursor(cursorKey))?.changedSince).toBe(2)
  await test.service.delete({ scope: PERSONAL, key: 'two' }, test.writer)
  expect((await test.service.getCursor(cursorKey))?.changedSince).toBe(3)
  // Refused writes never bump the counter.
  await test.save({ key: 'one' })
  expect((await test.service.getCursor(cursorKey))?.changedSince).toBe(3)

  await test.service.writeCursor(cursorKey, {
    lastRunAt: '2026-10-30T00:00:00.000Z', lastDigest: 'abc', changedSince: 0,
  })
  const cursor = await test.service.getCursor(cursorKey)
  expect(cursor).toMatchObject({ lastRunAt: '2026-10-30T00:00:00.000Z', lastDigest: 'abc', changedSince: 0 })
  // Extraction cursors key off the session id and hold their own record.
  const extractionKey = memoryExtractionCursorKey('session-x')
  await test.service.writeCursor(extractionKey, { lastSeq: 9 })
  expect((await test.service.getCursor(extractionKey))?.lastSeq).toBe(9)
  // A committed mutation preserves the unrelated cursor fields.
  await test.save({ key: 'three' })
  expect((await test.service.getCursor(cursorKey))).toMatchObject({ lastDigest: 'abc', changedSince: 1 })
})

it('lists full entries in catalog order and reports composition switches', async () => {
  const test = await memoryHarness({ config: { extraction: true, recall: true } })
  const agent = agentFor(test.ctx, 'e1', { cwd: '/tmp/work' })
  const writer = { kind: 'agent' as const, agent }
  await test.service.save({ scope: PERSONAL, key: 'b-one', kind: 'background', summary: 's', content: 'body-b' }, writer)
  await test.service.save({ scope: PERSONAL, key: 'g-one', kind: 'guidance', summary: 's', content: 'body-g' }, writer)
  const entries = await test.service.entries(PERSONAL)
  expect(entries.map(entry => entry.key)).toEqual(['g-one', 'b-one'])
  expect(entries[0]!.content).toBe('body-g')
  expect(test.service.switches()).toEqual({ enabled: true, extraction: true, consolidation: false, recall: true })
})

it('validates raw keys at the branded boundary and on read/delete', async () => {
  const test = await boot()
  expect(() => MemoryKey('BAD KEY')).toThrow(TypeError)
  expect(() => MemoryKey('a'.repeat(65))).toThrow(TypeError)
  expect(MemoryKey('ok-key')).toBe('ok-key')
  expect(await test.service.read(PERSONAL, 'BAD KEY')).toBeUndefined()
  expect(await test.service.read(PERSONAL, 'a'.repeat(65))).toBeUndefined()
  expect(await test.service.delete({ scope: PERSONAL, key: 'BAD KEY' }, test.writer))
    .toMatchObject({ ok: false, code: 'memory_invalid', reason: 'key' })
  // A refused scope short-circuits before the key check.
  expect(await test.service.delete({ scope: { kind: 'workspace', directory: '/other' }, key: 'k' }, test.writer))
    .toMatchObject({ ok: false, code: 'memory_invalid' })
  // A project scope is unavailable in a personal space.
  expect(await test.service.delete({ scope: { kind: 'project' }, key: 'x' }, test.writer))
    .toMatchObject({ ok: false, code: 'memory_invalid', reason: 'scope-unavailable' })
})

it('offers only the shared project scope in project space', async () => {
  const test = await memoryHarness({ config: { space: 'project' } })
  const agent = agentFor(test.ctx, 'pc', { cwd: '/x' })
  expect(test.service.scopesFor(agent)).toEqual([{ kind: 'project' }])
})

it('offers no scopes at all when the memory section is disabled', async () => {
  const test = await memoryHarness({
    beforeService: (ctx) => {
      ctx.provide('settings', settingsStub({ enabled: false, extraction: false, consolidation: false, recall: false }) as never)
    },
  })
  const agent = agentFor(test.ctx, 'off', { cwd: '/x' })
  expect(test.service.scopesFor(agent)).toEqual([])
})

it('scopesFor covers the sshTarget arm and the empty-cwd arm', async () => {
  const test = await boot(undefined, { cwd: '/tmp/work', sshTarget: 7 })
  expect(test.service.scopesFor(test.agent)).toEqual([
    { kind: 'personal' },
    { kind: 'workspace', directory: '/tmp/work', sshTarget: 7 },
  ])
  // A legacy header may carry an empty cwd; it resolves no workspace scope.
  Object.defineProperty(test.agent.session, 'header', { value: { cwd: '' } })
  expect(test.service.scopesFor(test.agent)).toEqual([{ kind: 'personal' }])
})

it('search skips entries outside the requested scopes', async () => {
  const test = await boot()
  const own: MemoryScope = { kind: 'workspace', directory: '/tmp/work' }
  await test.service.save({ scope: own, key: 'ws-needle', kind: 'background', summary: 'needle in the workspace', content: 'c' }, test.writer)
  await test.service.save({ scope: PERSONAL, key: 'p-needle', kind: 'background', summary: 'needle in personal', content: 'c' }, test.writer)
  const hits = await test.service.search([PERSONAL], 'needle')
  expect(Array.isArray(hits)).toBe(true)
  if (Array.isArray(hits)) expect(hits.map(hit => hit.entry.key)).toEqual(['p-needle'])
})

it('resolves switches through the attached settings section', async () => {
  let resolved = { enabled: true, extraction: false, consolidation: false, recall: true }
  const settings = {
    installSection: vi.fn((_ctx: unknown, _ns: unknown, _schema: unknown, _entry: unknown, hooks: {
      setSource: (source: () => MemorySwitches) => void
      onChange: () => void
    }) => {
      hooks.setSource(() => resolved)
      hooks.onChange()
      return { watch: vi.fn() }
    }),
  }
  const test = await memoryHarness({ beforeService: (ctx) => { ctx.provide('settings', settings as never) } })
  expect(test.service.switches()).toEqual({ enabled: true, extraction: false, consolidation: false, recall: true })
  resolved = { enabled: true, extraction: true, consolidation: true, recall: true }
  expect(test.service.switches()).toEqual({ enabled: true, extraction: true, consolidation: true, recall: true })
})
