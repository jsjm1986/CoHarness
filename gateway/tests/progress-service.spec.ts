/** Project progress digest: gates, lease, material folding, output validation. */
import { Client, Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PostgresProgressService,
  DEFAULT_PROGRESS_CONFIG,
  periodKeyOf,
  resolveDigestOutput,
} from '../src/postgres/progress-service.ts'
import { CollaborationDeniedError } from '../src/collaboration.ts'
import type { GatewayModelBudget } from '../src/gateway-model-budget.ts'
import type { ResourceOperationId } from '@deepseek-ai/dsh-resource-budget/types'
import type { PostgresProgressUsage, ProgressRequestId } from '../src/postgres/progress-usage.ts'

const context = {
  organizationId: 'org-1', organizationSlug: 'org', nodeId: 'node-1', nodeName: 'node',
}
const SOURCE_RUNTIME = '22222222-2222-4222-8222-222222222222'
const pools = new Set<Pool>()

interface Handler { readonly match: RegExp; readonly result: (values?: readonly unknown[]) => { rows: unknown[]; rowCount?: number } }

/** A pool whose `query` resolves through the first matching SQL handler. */
function scriptedPool(handlers: Handler[]): Pool & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 }
    const handler = handlers.find(entry => entry.match.test(sql))
    if (handler === undefined) {
      if (/digest_model FROM harness\.organizations/.test(sql)) return { rows: [{ digest_model: null }], rowCount: 1 }
      if (/SELECT source\.id FROM/.test(sql)) {
        const ids = values?.[3]
        if (!Array.isArray(ids)) throw new Error('Expected material Session ids')
        return { rows: ids.map(id => ({ id })), rowCount: ids.length }
      }
      if (/SELECT 1 FROM harness\.(organizations|projects)/.test(sql)) return { rows: [{}], rowCount: 1 }
      if (/generation_id=\$3 RETURNING project_id/.test(sql)) return { rows: [{}], rowCount: 1 }
      if (/INSERT INTO harness\.project_journal_materials/.test(sql)) return { rows: [], rowCount: 1 }

      throw new Error(`unhandled query: ${sql.slice(0, 140)}`)
    }
    const result = handler.result(values)
    if (!sql.includes('cursor_ts')) return result
    return { ...result, rows: result.rows.map(row => {
      if (row === null || typeof row !== 'object' || !('ts' in row) || !(row.ts instanceof Date)) return row
      const item = row as Record<string, unknown>
      return { ...item, runtime_id: item.runtime_id ?? SOURCE_RUNTIME, runtime_namespace: item.runtime_namespace ?? SOURCE_RUNTIME, cursor_ts: row.ts.toISOString().replace('Z', '000Z'), ts_us: String(BigInt(row.ts.getTime()) * 1000n),
        entry_id: item.entry_id ?? `${item.kind === 'decision' ? 'question:fixture' : 'message'}:${String(item.seq)}` }
    }) }
  })
  const pool = new Pool()
  pools.add(pool)
  return Object.assign(pool, {
    query,
    connect: async () => Object.assign(new Client(), { query, release: vi.fn() }),
  })
}

const rows = (list: unknown[], rowCount?: number): { rows: unknown[]; rowCount: number } =>
  ({ rows: list, rowCount: rowCount ?? list.length })

const authority = (mode: 'rw' | 'ro', administrator = false) => ({
  projectId: 9, name: 'P', path: '/p', mode, administrator, canManage: administrator, uiThemePolicy: 'follow-user' as const,
})

const POLICY = {
  version: 1,
  defaultAllowed: false as const,
  models: [{ provider: 'deepseek', model: 'deepseek-chat', allowed: true }],
  providers: [{
    provider: 'deepseek', displayName: 'DeepSeek', driver: 'pi-ai' as const,
    protocol: 'openai-completions' as const, baseURL: 'https://api.test/v1',
    credentialRef: 'ref-1', models: [{ id: 'deepseek-chat' }],
  }],
}

function serviceFor(
  pool: Pool,
  options?: { mode?: 'rw' | 'ro'; denied?: boolean; policy?: unknown; config?: Partial<typeof DEFAULT_PROGRESS_CONFIG>;
    budget?: Pick<GatewayModelBudget, 'run'>; usage?: Pick<PostgresProgressUsage, 'prepare' | 'complete' | 'flush'> },
): PostgresProgressService {
  const collaboration = {
    projectForUser: vi.fn(async () => options?.denied === true ? null : authority(options?.mode ?? 'rw')),
  }
  const governance = options?.policy === null ? undefined : {
    policyForProject: vi.fn(async () => options?.policy ?? POLICY),
    resolveManagedCredential: vi.fn(async () => 'sk-test'),
  }
  const budget: Pick<GatewayModelBudget, 'run'> = options?.budget ?? { run: async (request, execute) => execute(request.signal, randomUUID() as ResourceOperationId) }
  const usage: Pick<PostgresProgressUsage, 'prepare' | 'complete' | 'flush'> = options?.usage ?? {
    prepare: async () => randomUUID() as ProgressRequestId, complete: async () => {}, flush: async () => {},
  }
  const deps = { collaboration, governance: governance as never, budget, usage }
  return new PostgresProgressService({ ...context, pool }, deps, {
    ...DEFAULT_PROGRESS_CONFIG, ...options?.config,
  })
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all([...pools].map(pool => pool.end()))
  pools.clear()
})

describe('periodKeyOf', () => {
  it('maps instants to their ISO week key', () => {
    expect(periodKeyOf(new Date('2026-10-21T12:00:00Z'))).toBe('2026-W43')
    expect(periodKeyOf(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01')
    expect(periodKeyOf(new Date('2025-12-29T12:00:00Z'))).toBe('2026-W01')
    expect(periodKeyOf(new Date('2026-12-31T12:00:00Z'))).toBe('2026-W53')
  })
})

describe('resolveDigestOutput', () => {
  const material = [
    { kind: 'decision', sessionId: 's1', sessionTitle: 'Alpha', actor: 'Lin', occurredAt: new Date(), seq: 4, text: 'q → a' },
    { kind: 'agent', sessionId: 's2', sessionTitle: null, actor: null, occurredAt: new Date(), seq: 9, text: 'did x' },
  ] as const

  it('resolves refs into source attribution and keeps the summary', () => {
    const out = resolveDigestOutput(JSON.stringify({
      summary: 'Login rework is converging.',
      decided: [{ text: 'Keep the old API for a week', refs: [1] }],
      done: [{ text: 'Switched login page', refs: [2] }],
      doing: [], blocked: [{ text: 'staging outage', refs: [] }],
    }), material as never, 8)
    expect(out.summary).toBe('Login rework is converging.')
    expect(out.sections.decided[0]).toEqual({
      text: 'Keep the old API for a week', actor: 'Lin', sessionId: 's1', sessionTitle: 'Alpha', seq: 4,
    })
    expect(out.sections.done[0]).toEqual({ text: 'Switched login page', sessionId: 's2', seq: 9 })
    expect(out.sections.blocked[0]).toEqual({ text: 'staging outage' })
  })

  it('extracts the object from fenced or padded responses', () => {
    const out = resolveDigestOutput(
      '```json\n{"summary":"s","decided":[],"done":[],"doing":[],"blocked":[]}\n```',
      material as never, 8)
    expect(out.summary).toBe('s')
  })

  it('drops malformed items and items without text', () => {
    const out = resolveDigestOutput(JSON.stringify({
      decided: [{ text: 'kept', refs: [1] }, { refs: [1] }, 'junk', { text: '  ' }],
    }), material as never, 8)
    expect(out.sections.decided).toEqual([{ text: 'kept', actor: 'Lin', sessionId: 's1', sessionTitle: 'Alpha', seq: 4 }])
  })

  it('drops items whose refs never resolve; blocked may stand alone', () => {
    const out = resolveDigestOutput(JSON.stringify({
      summary: 's',
      decided: [{ text: 'phantom', refs: [99] }, { text: 'no ref at all' }, { text: 'real', refs: [1] }],
      blocked: [{ text: 'unattributed blocker' }],
    }), material as never, 8)
    expect(out.sections.decided).toEqual([{ text: 'real', actor: 'Lin', sessionId: 's1', sessionTitle: 'Alpha', seq: 4 }])
    expect(out.sections.blocked).toEqual([{ text: 'unattributed blocker' }])
  })

  it('caps each section at the configured item count', () => {
    const decided = Array.from({ length: 12 }, (_, i) => ({ text: `d${String(i)}`, refs: [1] }))
    const out = resolveDigestOutput(JSON.stringify({ decided }), material as never, 3)
    expect(out.sections.decided).toHaveLength(3)
  })

  it('rejects output with no JSON object and output with no usable content', () => {
    expect(() => resolveDigestOutput('plain text', material as never, 8)).toThrow()
    expect(() => resolveDigestOutput('{"decided":[]}', material as never, 8)).toThrow()
    expect(() => resolveDigestOutput('[1,2]', material as never, 8)).toThrow()
  })
})

describe('PostgresProgressService.progressForUser', () => {
  it('serves entries and status to a project member', async () => {
    const pool = scriptedPool([
      { match: /SELECT id FROM harness\.projects/, result: () => rows([{ id: 'p-internal' }]) },
      { match: /FROM harness\.project_journal_state/, result: () => rows([]) },
      { match: /count\(\*\)::int pending/, result: () => rows([{ pending: 3, latest: null, decided: false }]) },
      { match: /FROM harness\.project_journal/, result: () => rows([{
        id: 'j1', kind: 'current', period_key: null,
        content: { summary: 'Login rework converging.', sections: { decided: [], done: [], doing: [], blocked: [] } },
        activity_count: 12, period_start: null, period_end: null, model: 'deepseek/deepseek-chat',
        generated_at: new Date('2026-10-21T10:00:00Z'),
      }]) },
    ])
    const service = serviceFor(pool)
    const page = await service.progressForUser(9, 7)
    expect(page.enabled).toBe(true)
    expect(page.current?.content.summary).toBe('Login rework converging.')
    expect(page.status).toEqual({ enabled: true, pending: 3, generating: false, canGenerate: true })
    expect(page.periods).toEqual([])
  })

  it('denies non-members and reports read-only members without generate authority', async () => {
    const pool = scriptedPool([
      { match: /SELECT id FROM harness\.projects/, result: () => rows([{ id: 'p-internal' }]) },
      { match: /FROM harness\.project_journal_state/, result: () => rows([]) },
      { match: /count\(\*\)::int pending/, result: () => rows([{ pending: 0, latest: null, decided: false }]) },
      { match: /FROM harness\.project_journal/, result: () => rows([]) },
    ])
    const ro = serviceFor(pool, { mode: 'ro' })
    expect((await ro.progressForUser(9, 7)).status.canGenerate).toBe(false)
    const denied = serviceFor(pool, { denied: true })
    await expect(denied.progressForUser(9, 7)).rejects.toBeInstanceOf(CollaborationDeniedError)
  })
})

describe('PostgresProgressService.generateNow', () => {
  it('refuses read-only members and unavailable routes', async () => {
    const pool = scriptedPool([
      { match: /SELECT id FROM harness\.projects/, result: () => rows([{ id: 'p-internal' }]) },
    ])
    const ro = serviceFor(pool, { mode: 'ro' })
    await expect(ro.generateNow(9, 7)).rejects.toBeInstanceOf(CollaborationDeniedError)
    const noRoute = serviceFor(pool, { policy: { ...POLICY, models: [], providers: [] } })
    expect(await noRoute.generateNow(9, 7)).toEqual({ started: false, reason: 'unavailable' })
  })

  it('admits a pass when the lease is free', async () => {
    const pool = scriptedPool([
      { match: /SELECT id FROM harness\.projects/, result: () => rows([{ id: 'p-internal' }]) },
      { match: /INSERT INTO harness\.project_journal_state/, result: () => rows([], 1) },
      { match: /FROM harness\.project_journal_state/, result: () => rows([{
        watermark_ts: null, watermark_session: null, watermark_seq: null,
        last_run_at: null, generating_since: new Date(), last_error: null,
      }]) },
      { match: /conversation_interaction_responses/, result: () => rows([]) },
      { match: /role='assistant'/, result: () => rows([]) },
      { match: /SET generating_since=NULL,last_error=NULL,updated_at/, result: () => rows([], 1) },
    ])
    const service = serviceFor(pool)
    expect(await service.generateNow(9, 7)).toEqual({ started: true })
    // The background pass found no material and released the lease.
    await vi.waitFor(() => {
      expect(pool.query).toHaveBeenCalledWith(expect.stringMatching(/SET generating_since=NULL,last_error=NULL,updated_at/), expect.anything())
    })
  })

  it('reports generating while a lease is in flight', async () => {
    const pool = scriptedPool([
      { match: /SELECT id FROM harness\.projects/, result: () => rows([{ id: 'p-internal' }]) },
      { match: /INSERT INTO harness\.project_journal_state/, result: () => rows([], 0) },
    ])
    const service = serviceFor(pool)
    expect(await service.generateNow(9, 7)).toEqual({ started: false, reason: 'generating' })
  })
})

describe('PostgresProgressService.sweep', () => {
  it('runs one pass for an eligible project and commits entries with the watermark', async () => {
    const writes: string[] = []
    const digest = JSON.stringify({
      summary: 'Login rework is converging.',
      decided: [{ text: '旧接口先保留一周', refs: [2] }],
      done: [], doing: [{ text: '登录页切新接口', refs: [1] }], blocked: [],
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: digest } }] }), { status: 200 })))
    const pool = scriptedPool([
      { match: /GROUP BY pid/, result: () => rows([{ pid: 'p-internal', mx: new Date('2026-10-20T09:10:00Z') }]) },
      { match: /FROM harness\.project_journal_state/, result: () => rows([]) },
      { match: /count\(\*\)::int pending/, result: () => rows([{ pending: 2, latest: new Date('2026-10-20T09:10:00Z'), decided: true }]) },
      { match: /SELECT public_id/, result: () => rows([{ public_id: '9' }]) },
      { match: /INSERT INTO harness\.project_journal_state/, result: () => rows([], 1) },
      { match: /conversation_interaction_responses/, result: () => rows([
        { kind: 'member', session_id: '11111111-1111-1111-1111-111111111111', seq: 3, ts: new Date('2026-10-20T09:00:00Z'),
          text: 'switch the login page to the new API', actor_label: 'Lin', outcome: null, question_args: null, title: 'Alpha' },
        { kind: 'decision', session_id: '11111111-1111-1111-1111-111111111111', seq: 4, ts: new Date('2026-10-20T09:10:00Z'),
          text: null, actor_label: 'Zhou', outcome: { answers: [{ selected: ['先保留一周'] }] },
          question_args: '{"questions":[{"question":"旧接口保留多久"}]}', title: 'Alpha' },
      ]) },
      { match: /role='assistant'/, result: () => rows([]) },
      { match: /SELECT id,kind[\s\S]*kind='period' AND period_key/, result: () => rows([]) },
      { match: /AND kind='current'\s*$/, result: () => rows([]) },
      { match: /SELECT name FROM harness\.projects/, result: () => rows([{ name: 'Payments' }]) },
      { match: /INSERT INTO harness\.project_journal\(/, result: () => { writes.push('journal-insert'); return rows([], 1) } },
      { match: /SET \(watermark_ts/, result: () => { writes.push('watermark'); return rows([], 1) } },
    ])
    const service = serviceFor(pool, {
      config: { idleMs: 0, intervalMs: 0, minActivity: 8 },
    })
    await service.sweep()
    // A decision row bypasses the minActivity threshold; entries + watermark committed.
    expect(writes).toEqual(['journal-insert', 'journal-insert', 'watermark'])
    const model = pool.query.mock.calls.find(([sql]) => String(sql).includes('SET (watermark_ts'))
    expect(model?.[1]).toEqual(['org-1', 'p-internal', '2026-10-20T09:10:00.000000Z', '11111111-1111-1111-1111-111111111111', 4, expect.any(String), SOURCE_RUNTIME])
  })

  it('stays idle when gates fail: below threshold, not quiet, or too soon', async () => {
    const recent = new Date(Date.now() - 60_000)
    const pool = scriptedPool([
      { match: /GROUP BY pid/, result: () => rows([{ pid: 'p-internal', mx: recent }]) },
      { match: /FROM harness\.project_journal_state/, result: () => rows([]) },
      { match: /count\(\*\)::int pending/, result: () => rows([{ pending: 3, latest: recent, decided: false }]) },
    ])
    const service = serviceFor(pool)
    await service.sweep()
    // No lease, no material, no model — only the three reads happened.
    expect(pool.query).toHaveBeenCalledTimes(3)
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    const pool2 = scriptedPool([
      { match: /GROUP BY pid/, result: () => rows([{ pid: 'p-internal', mx: old }]) },
      { match: /FROM harness\.project_journal_state/, result: () => rows([{
        watermark_ts: new Date('2020-01-01T00:00:00Z'), watermark_session: 's', watermark_seq: '1',
        last_run_at: new Date(), generating_since: null, last_error: null,
      }]) },
      { match: /count\(\*\)::int pending/, result: () => rows([{ pending: 20, latest: old, decided: false }]) },
    ])
    // intervalMs default (4h) blocks because last_run_at is now.
    const service2 = serviceFor(pool2)
    await service2.sweep()
    expect(pool2.query).toHaveBeenCalledTimes(3)
  })

  it('records last_error and leaves the watermark behind when the model fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream down', { status: 502 })))
    const errors: string[] = []
    const pool = scriptedPool([
      { match: /GROUP BY pid/, result: () => rows([{ pid: 'p-internal', mx: new Date('2026-10-20T09:10:00Z') }]) },
      { match: /FROM harness\.project_journal_state/, result: () => rows([]) },
      { match: /count\(\*\)::int pending/, result: () => rows([{ pending: 9, latest: new Date('2026-10-20T09:10:00Z'), decided: false }]) },
      { match: /SELECT public_id/, result: () => rows([{ public_id: '9' }]) },
      { match: /INSERT INTO harness\.project_journal_state/, result: () => rows([], 1) },
      { match: /conversation_interaction_responses/, result: () => rows([
        { kind: 'member', session_id: 'sess-1', seq: 3, ts: new Date('2026-10-20T09:00:00Z'),
          text: 'hello', actor_label: 'Lin', outcome: null, question_args: null, title: 'Alpha' },
      ]) },
      { match: /role='assistant'/, result: () => rows([]) },
      { match: /SELECT id,kind[\s\S]*kind='period' AND period_key/, result: () => rows([]) },
      { match: /AND kind='current'\s*$/, result: () => rows([]) },
      { match: /SELECT name FROM harness\.projects/, result: () => rows([{ name: 'P' }]) },
      { match: /SET generating_since=NULL,last_error/, result: () => { errors.push('recorded'); return rows([], 1) } },
      { match: /SET \(watermark_ts/, result: () => { throw new Error('watermark must not move') } },
    ])
    const service = serviceFor(pool, { config: { idleMs: 0 } })
    await service.sweep()
    expect(errors).toEqual(['recorded'])
    expect(pool.query.mock.calls.some(([sql]) => String(sql).includes('SET (watermark_ts'))).toBe(false)
  })
})

describe('PostgresProgressService material folding', () => {
  it('folds a decision row into question → answer text with the responder', async () => {
    const captured: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body: string }) => {
      captured.push(JSON.parse(init.body).messages[0].content)
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"s","decided":[],"done":[],"doing":[],"blocked":[]}' } }] }), { status: 200 })
    }))
    const pool = scriptedPool([
      { match: /GROUP BY pid/, result: () => rows([{ pid: 'p-internal', mx: new Date('2026-10-20T09:10:00Z') }]) },
      { match: /FROM harness\.project_journal_state/, result: () => rows([]) },
      { match: /count\(\*\)::int pending/, result: () => rows([{ pending: 9, latest: new Date(), decided: true }]) },
      { match: /SELECT public_id/, result: () => rows([{ public_id: '9' }]) },
      { match: /INSERT INTO harness\.project_journal_state/, result: () => rows([], 1) },
      { match: /conversation_interaction_responses/, result: () => rows([
        { kind: 'decision', session_id: 'sess-1', seq: -1, ts: new Date('2026-10-20T09:10:00Z'),
          text: null, actor_label: 'Zhou',
          outcome: { answers: [{ selected: ['stage first'], custom: 'canary 5%' }] },
          question_args: '{"questions":[{"question":"Roll out now or stage?"}]}', title: 'Alpha' },
      ]) },
      { match: /role='assistant'/, result: () => rows([]) },
      { match: /SELECT id,kind[\s\S]*kind='period' AND period_key/, result: () => rows([]) },
      { match: /AND kind='current'\s*$/, result: () => rows([]) },
      { match: /SELECT name FROM harness\.projects/, result: () => rows([{ name: 'P' }]) },
      { match: /INSERT INTO harness\.project_journal\(/, result: () => rows([], 1) },
      { match: /SET \(watermark_ts/, result: () => rows([], 1) },
    ])
    const service = serviceFor(pool, { config: { idleMs: 0 } })
    await service.sweep()
    expect(captured).toHaveLength(1)
    expect(captured[0]).toContain('Zhou')
    expect(captured[0]).toContain('decided')
    expect(captured[0]).toContain('Roll out now or stage? → stage first：canary 5%')
    expect(captured[0]).toContain('Alpha')
  })

  it('watermarks only the complete prefix when a capped stream trails the other', async () => {
    const captured: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body: string }) => {
      captured.push(JSON.parse(init.body).messages[0].content)
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"s","decided":[],"done":[],"doing":[],"blocked":[]}' } }] }), { status: 200 })
    }))
    const pool = scriptedPool([
      { match: /GROUP BY pid/, result: () => rows([{ pid: 'p-internal', mx: new Date('2026-10-20T10:00:00Z') }]) },
      { match: /FROM harness\.project_journal_state/, result: () => rows([]) },
      { match: /count\(\*\)::int pending/, result: () => rows([{ pending: 9, latest: new Date('2026-10-20T10:00:00Z'), decided: true }]) },
      { match: /SELECT public_id/, result: () => rows([{ public_id: '9' }]) },
      { match: /INSERT INTO harness\.project_journal_state/, result: () => rows([], 1) },
      { match: /conversation_interaction_responses/, result: () => rows([
        // Member stream at its cap: rows past this key may still be unfetched.
        { kind: 'member', session_id: 'sess-1', seq: 1, ts: new Date('2026-10-20T09:00:00Z'),
          text: 'first', actor_label: 'Lin', outcome: null, question_args: null, title: 'Alpha' },
        { kind: 'member', session_id: 'sess-1', seq: 2, ts: new Date('2026-10-20T09:30:00Z'),
          text: 'second', actor_label: 'Lin', outcome: null, question_args: null, title: 'Alpha' },
      ]) },
      { match: /role='assistant'/, result: () => rows([
        // Agent row later than the member cap tail: it is inside the fetched
        // set, but a member row between 09:30 and 10:00 may be missing.
        { session_id: 'sess-1', seq: 9, ts: new Date('2026-10-20T10:00:00Z'),
          text: 'agent tail', title: 'Alpha' },
      ]) },
      { match: /SELECT id,kind[\s\S]*kind='period' AND period_key/, result: () => rows([]) },
      { match: /AND kind='current'\s*$/, result: () => rows([]) },
      { match: /SELECT name FROM harness\.projects/, result: () => rows([{ name: 'P' }]) },
      { match: /INSERT INTO harness\.project_journal\(/, result: () => rows([], 1) },
      { match: /SET \(watermark_ts/, result: () => rows([], 1) },
    ])
    const service = serviceFor(pool, { config: { idleMs: 0, maxMaterialRows: 2 } })
    await service.sweep()
    expect(captured).toHaveLength(1)
    expect(captured[0]).toContain('first')
    expect(captured[0]).toContain('second')
    expect(captured[0]).not.toContain('agent tail')
    const watermark = pool.query.mock.calls.find(([sql]) => String(sql).includes('SET (watermark_ts'))
    expect(watermark?.[1]).toEqual(['org-1', 'p-internal', '2026-10-20T09:30:00.000000Z', 'sess-1', 2, expect.any(String), SOURCE_RUNTIME])
  })
})

/** Ordinary eligible project exercising the public sweep and its actual prompt assembly. */
function eligiblePool(outcome: unknown = null, text = 'Prepare the release.'): ReturnType<typeof scriptedPool> {
  const instant = new Date('2026-10-20T09:10:00Z')
  return scriptedPool([
    { match: /SELECT id FROM harness\.projects/, result: () => rows([{ id: 'p-internal' }]) },
    { match: /GROUP BY pid/, result: () => rows([{ pid: 'p-internal', mx: instant }]) },
    { match: /FROM harness\.project_journal_state/, result: () => rows([]) },
    { match: /count\(\*\)::int pending/, result: () => rows([{ pending: 9, latest: instant, decided: true }]) },
    { match: /SELECT public_id/, result: () => rows([{ public_id: '9' }]) },
    { match: /INSERT INTO harness\.project_journal_state/, result: () => rows([], 1) },
    { match: /conversation_interaction_responses/, result: () => rows([{
      kind: outcome === null ? 'member' : 'decision', session_id: 'session-one', seq: 3, ts: instant,
      text, actor_label: 'Lin', outcome, question_args: null, title: 'Release',
    }]) },
    { match: /role='assistant'/, result: () => rows([]) },
    { match: /SELECT id,kind/, result: () => rows([]) },
    { match: /SELECT name FROM harness\.projects/, result: () => rows([{ name: 'Release' }]) },
    { match: /INSERT INTO harness\.project_journal\(/, result: () => rows([], 1) },
    { match: /SET \(watermark_ts|SET generating_since=NULL/, result: () => rows([], 1) },
  ])
}

describe('project digest extension admission', () => {
  it('rejects invalid durable headers without exposing their sensitive values in an error cause', async () => {
    const policy = { ...POLICY, providers: [{ ...POLICY.providers[0], profile: { headers: { 'x-api-key': 'synthetic-secret\ninvalid' } } }] }
    const service = serviceFor(eligiblePool(), { policy })
    await expect(service.progressForUser(9, 7)).rejects.toMatchObject({ message: 'Digest provider headers are not valid for HTTP' })
    try { await service.progressForUser(9, 7) } catch (error) {
      if (!(error instanceof Error)) throw error
      expect(error.cause).toBeUndefined()
      expect(String(error)).not.toContain('synthetic-secret')
    }
  })
  it('respects the served model output limit when the digest cap is higher', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"Ready"}' } }] })))
    vi.stubGlobal('fetch', fetch)
    const policy = { ...POLICY, providers: [{ ...POLICY.providers[0], models: [{ id: 'deepseek-chat', maxTokens: 128 }] }] }
    await serviceFor(eligiblePool(), { policy, config: { idleMs: 0, maxOutputTokens: 4096 } }).sweep()
    const body = fetch.mock.calls[0]?.[1]?.body
    if (typeof body !== 'string') throw new Error('Expected a serialized model request')
    expect(JSON.parse(body).max_tokens).toBe(128)
  })
  it('preserves replacement metacharacters and template-like text in member input', async () => {
    const literal = "literal $& $` $' {maxItems}"
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"Ready"}' } }] })))
    vi.stubGlobal('fetch', fetch)
    await serviceFor(eligiblePool(null, literal), { config: { idleMs: 0 } }).sweep()
    const body = fetch.mock.calls[0]?.[1]?.body
    if (typeof body !== 'string') throw new Error('Expected a serialized model request')
    expect(JSON.parse(body).messages[0].content).toContain(literal)
  })
  it('waits for node admission before starting the model request', async () => {
    let grant: () => void = () => { throw new Error('admission has not been requested') }
    const admission = new Promise<void>(resolve => { grant = resolve })
    const budget: Pick<GatewayModelBudget, 'run'> = { run: vi.fn(async (request, execute) => {
      await admission
      return execute(request.signal, randomUUID() as ResourceOperationId)
    }) }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"Ready"}' } }] })))
    vi.stubGlobal('fetch', fetch)
    const service = serviceFor(eligiblePool(), { budget, config: { idleMs: 0 } })
    const sweep = service.sweep()
    try {
      await vi.waitFor(() => { expect(budget.run).toHaveBeenCalledOnce() })
      expect(fetch).not.toHaveBeenCalled()
    } finally { grant(); await sweep }
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('keeps distinct provider/model tuples when their concatenated strings coincide', async () => {
    const pool = eligiblePool()
    const policy = {
      ...POLICY,
      models: [{ provider: 'org-ab', model: 'c', allowed: true }, { provider: 'org-a', model: 'bc', allowed: true }],
      providers: [
        { ...POLICY.providers[0], provider: 'org-ab', models: [{ id: 'c' }] },
        { ...POLICY.providers[0], provider: 'org-a', models: [{ id: 'bc' }] },
      ],
    }
    const page = await serviceFor(pool, { policy, config: { model: 'org-a/bc' } }).progressForUser(9, 7)
    expect(page.enabled).toBe(true)
  })

  it('ignores non-object historical answer elements while keeping usable selections', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"Ready"}' } }] })))
    vi.stubGlobal('fetch', fetch)
    await serviceFor(eligiblePool({ answers: [null, 7, [], { selected: ['Release on Friday'] }] }), {
      config: { idleMs: 0 },
    }).sweep()
    expect(fetch).toHaveBeenCalledOnce()
    const body = fetch.mock.calls[0]![1]!.body
    if (typeof body !== 'string') throw new Error('Expected a serialized model request')
    expect(JSON.parse(body).messages[0].content).toContain('Release on Friday')
  })
})
