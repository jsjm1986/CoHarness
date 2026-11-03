/** Conditional cursor commits preserve concurrent entry and maintenance changes. */
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { memoryConsolidationCursorKey } from '../src/index.ts'
import { agentFor, memoryHarness } from './harness.ts'

const contexts: Context[] = []
const scope = { kind: 'personal' as const }
const key = memoryConsolidationCursorKey(scope)
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

it('creates an absent cursor once and refuses another absent-record expectation', async () => {
  const test = await memoryHarness(); contexts.push(test.ctx)
  expect(await test.service.writeCursorIfUnchanged(key, undefined, { changedSince: 1 })).toBe(true)
  expect(await test.service.writeCursorIfUnchanged(key, undefined, { changedSince: 0 })).toBe(false)
  expect(await test.service.getCursor(key)).toEqual({ changedSince: 1 })
})

it('replaces a matching cursor with the completed review metadata', async () => {
  const test = await memoryHarness(); contexts.push(test.ctx)
  await test.service.writeCursor(key, { changedSince: 3 })
  const observed = await test.service.getCursor(key)
  const completed = { changedSince: 0, lastRunAt: '2026-10-23T00:00:00.000Z', lastDigest: 'reviewed' }
  expect(await test.service.writeCursorIfUnchanged(key, observed, completed)).toBe(true)
  expect(await test.service.getCursor(key)).toEqual(completed)
})

it('retains a member mutation that arrived after the reviewed cursor', async () => {
  const test = await memoryHarness(); contexts.push(test.ctx)
  await test.service.writeCursor(key, { changedSince: 3 })
  const observed = await test.service.getCursor(key)
  await test.service.memberSave({ scope, key: 'new-member-fact', kind: 'guidance', summary: 'new', content: 'not reviewed' })
  expect(await test.service.writeCursorIfUnchanged(key, observed, { changedSince: 0, lastDigest: 'stale' })).toBe(false)
  expect(await test.service.getCursor(key)).toEqual({ changedSince: 4 })
})

it('retains newer review metadata even when the change count matches', async () => {
  const test = await memoryHarness(); contexts.push(test.ctx)
  const observed = { changedSince: 1, lastDigest: 'old', lastRunAt: '2026-10-22T00:00:00.000Z' }
  await test.service.writeCursor(key, observed)
  const newer = { ...observed, lastDigest: 'new', lastRunAt: '2026-10-23T00:00:00.000Z' }
  await test.service.writeCursor(key, newer)
  expect(await test.service.writeCursorIfUnchanged(key, observed, { changedSince: 0 })).toBe(false)
  expect(await test.service.getCursor(key)).toEqual(newer)
})

it.each(['write', 'conditional'] as const)('refuses a cancelled queued %s cursor without changing progress', async (operation) => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const test = await memoryHarness({
    config: { space: 'project' },
    beforeService: (ctx) => { ctx.provide('executionAuthority', {
      authorize: async () => { entered.resolve(undefined); await release.promise; return {} },
    }) },
  })
  contexts.push(test.ctx)
  const initial = { changedSince: 3 }
  await test.service.writeCursor(key, initial)
  const holding = test.service.save({
    scope: { kind: 'project' }, key: 'holding', kind: 'guidance', summary: 'holding write', content: 'another operation',
  }, { kind: 'agent', agent: agentFor(test.ctx) })
  let outcome: Promise<unknown> | undefined
  try {
    await entered.promise
    const lifetime = new AbortController()
    const cancellation = new Error('curation cancelled before cursor admission')
    const queued = operation === 'write'
      ? test.service.writeCursor(key, { changedSince: 0 }, lifetime.signal)
      : test.service.writeCursorIfUnchanged(key, initial, { changedSince: 0 }, lifetime.signal)
    outcome = queued.then(value => ({ value }), (error: unknown) => ({ error }))
    lifetime.abort(cancellation)
    release.resolve(undefined)
    expect((await holding).ok).toBe(true)
    expect(await outcome).toEqual({ error: cancellation })
    expect(await test.service.getCursor(key)).toEqual(initial)
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([holding, ...(outcome === undefined ? [] : [outcome])])
  }
})

it.each(['write', 'conditional'] as const)('rechecks cancellation after asynchronous %s cursor authorization', async (operation) => {
  const test = await memoryHarness(); contexts.push(test.ctx)
  const lifetime = new AbortController(), cancelled = new Error('authorization cancelled')
  const beforeCommit = async (): Promise<() => void> => { lifetime.abort(cancelled); return () => {} }
  const queued = operation === 'write'
    ? test.service.writeCursor(key, { changedSince: 0 }, lifetime.signal, beforeCommit)
    : test.service.writeCursorIfUnchanged(key, undefined, { changedSince: 0 }, lifetime.signal, beforeCommit)
  await expect(queued).rejects.toBe(cancelled)
  expect(await test.service.getCursor(key)).toBeUndefined()
  await test.service.writeCursor(key, { changedSince: 2 })
  expect(await test.service.getCursor(key)).toEqual({ changedSince: 2 })
})

it.each(['write', 'conditional'] as const)('runs the final synchronous %s cursor authorization before persistence', async (operation) => {
  const test = await memoryHarness(); contexts.push(test.ctx)
  const changed = new Error('cursor issuer changed')
  const authorize = async (): Promise<() => void> => () => { throw changed }
  const queued = operation === 'write'
    ? test.service.writeCursor(key, { changedSince: 0 }, undefined, authorize)
    : test.service.writeCursorIfUnchanged(key, undefined, { changedSince: 0 }, undefined, authorize)
  await expect(queued).rejects.toBe(changed)
  expect(await test.service.getCursor(key)).toBeUndefined()
  await test.service.writeCursor(key, { changedSince: 2 })
  expect(await test.service.getCursor(key)).toEqual({ changedSince: 2 })
})
