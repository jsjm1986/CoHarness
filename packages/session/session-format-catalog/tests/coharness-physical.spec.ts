/** Released CoHarness headers and streams retain identity through immutable-generation restoration. */
import { expect, it } from 'vitest'
import { coharnessJsonlFormatCatalog, sessionFormatCatalog } from '../src/index.ts'
import type { SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'

function header(version: number, fields: Record<string, unknown> = {}) {
  return { type: 'session', version, id: 'old-coharness', createdAt: 1, delegationDepth: 0, ...fields }
}

function restore(version: number, rows: unknown[], fields: Record<string, unknown> = {}) {
  const reader = coharnessJsonlFormatCatalog.createRestore(header(version, fields), { recovery: 'strict', validation: 'current' })
  for (const row of rows) reader.decodeRow(row)
  return reader.finish()
}

function row(type: string, seq: number, data: Record<string, SessionFormatJsonValue>, extra: Record<string, unknown> = {}) {
  return { type, seq, time: seq + 1, data, ...extra }
}

const user = { id: 'question', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] }
const assistant = { id: 'answer', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'hello' }] }
const system = { id: 'system', role: 'system', source: { kind: 'system-prompt' }, content: [] }

it.each([0, 1, 2, 3])('retains the declared seedLength and draft metadata from v%s', (version) => {
  const value = header(version, { seedLength: 0, draft: true })
  expect(coharnessJsonlFormatCatalog.readHeader(value)).toMatchObject({
    status: 'migration-required', storedVersion: version,
    header: { version: 7, isSeeded: true, draft: true },
  })
  expect(restore(version, [row('session/end-seed', 0, {})], { seedLength: 0, draft: true }))
    .toMatchObject({ header: { version: 7, draft: true, isSeeded: true }, inheritedEventCount: 0 })
  expect(value).not.toHaveProperty('isSeeded')
})

it.each([2, 3])('folds physical packed streams and preserves usage attribution from v%s', (version) => {
  const prefix = [row('turn/start', 0, { turn: 1 }), row('step/start', 1, { turn: 1, step: 1 })]
  if (version === 3) prefix.push(row('system/message', prefix.length, { turn: 1, step: 1, message: system }, { surfaceOp: 'append' }))
  prefix.push(row('user/message', prefix.length, user, { surfaceOp: 'append' }))
  const seq = prefix.length
  const result = restore(version, [
    ...prefix,
    row('assistant/chunk', seq, { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }),
    { type: 'text-chunks', seq0: seq + 1, time0: seq + 2, data: { turn: 1, step: 1, index: 0, texts: ['hel', 'lo'], dt: [1] } },
    row('assistant/chunk', seq + 3, { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 }, credentialSource: 'organization' } }),
    row('assistant/chunk', seq + 4, { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } }),
    row('assistant/message', seq + 5, { turn: 1, step: 1, message: assistant }, { surfaceOp: 'append', sourceEventSeqs: [[seq, seq + 4]] }),
    row('permission/preset', seq + 6, { preset: 'workspace-write', origin: 'selection' }),
    row('step/end', seq + 7, { turn: 1, step: 1 }),
    row('turn/end', seq + 8, { turn: 1, reason: { kind: 'completed' } }),
  ])
  expect(result.events.some(event => event.type === 'assistant/chunk')).toBe(false)
  const settled = result.events.find(event => event.type === 'assistant/message')!
  expect(settled.data).toMatchObject({ message: assistant })
  expect(JSON.stringify(settled.data)).toContain('credentialSource')
  expect(JSON.stringify(settled.data)).toContain('organization')
  expect(settled).not.toHaveProperty('sourceEventSeqs')
  expect(result.events.find(event => event.type === 'permission/preset')?.data).toMatchObject({ origin: 'selection' })
})

it('retains permission origin after an earlier v1 chunk group is consumed', () => {
  const result = restore(1, [
    row('turn/start', 0, { turn: 1 }), row('step/start', 1, { turn: 1, step: 1 }),
    row('user/message', 2, user, { surfaceOp: 'append' }),
    row('assistant/chunk', 3, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' } }),
    row('assistant/message', 4, { turn: 1, step: 1, message: assistant }, { surfaceOp: 'append', sourceEventSeqs: [3] }),
    row('permission/preset', 5, { preset: 'workspace-write', origin: 'selection' }),
    row('step/end', 6, { turn: 1, step: 1 }), row('turn/end', 7, { turn: 1, reason: { kind: 'completed' } }),
  ])
  expect(result.events.find(event => event.type === 'permission/preset')?.data).toEqual({ preset: 'workspace-write', origin: 'selection' })
})

it('keeps current, future and released-header admission independent of the legacy reader', () => {
  expect(coharnessJsonlFormatCatalog.readHeader(header(6))).toMatchObject({ status: 'malformed' })
  expect(coharnessJsonlFormatCatalog.readHeader(header(8))).toMatchObject({ status: 'unsupported' })
  expect(sessionFormatCatalog.readHeader(header(3))).toMatchObject({ status: 'malformed' })
  expect(coharnessJsonlFormatCatalog.readHeader(header(3, { draft: 'yes' }))).toMatchObject({ status: 'malformed' })
  expect(coharnessJsonlFormatCatalog.readHeader(header(3, { isSeeded: false, seedLength: 1 }))).toMatchObject({ status: 'malformed' })
  expect(() => restore(3, [], { seedLength: 4 })).toThrow()
  expect(() => restore(3, [row('user/message', 0, { id: 'missing-source', role: 'user', content: [] }, { surfaceOp: 'append' })])).toThrow()
})

it('verifies stored generations without silently advancing their version', () => {
  const historical = coharnessJsonlFormatCatalog.createStoredRestore(header(3, { draft: false }), { recovery: 'strict', validation: 'current' })
  historical.decodeRow(row('permission/preset', 0, { preset: 'workspace-write', origin: 'selection' }))
  expect(historical.header).toMatchObject({ version: 3, draft: false })
  expect(historical.finish()).toMatchObject({ header: { version: 3, draft: false }, events: [{ type: 'permission/preset' }] })
  for (const version of [5, 6, 7]) {
    const native = coharnessJsonlFormatCatalog.createStoredRestore(header(version, { isSeeded: false }), { recovery: 'strict', validation: 'current' })
    expect(native.finish()).toMatchObject({ header: { version }, events: [] })
  }
  const current = coharnessJsonlFormatCatalog.createRestore(header(7, { isSeeded: false }), { recovery: 'strict', validation: 'current' })
  expect(current.finish()).toMatchObject({ header: { version: 7 }, events: [] })
})

it.each([null, { inherited: false }])('refuses a contradictory inherited cut payload (%j)', (data) => {
  expect(() => restore(3, [{ type: 'session/end-seed', seq: 0, time: 1, data }], { seedLength: 0 }))
    .toThrow('seed marker contradicts')
})

it('preserves an explicit inherited marker and refuses undeclared legacy header members', () => {
  expect(restore(3, [row('session/end-seed', 0, { inherited: true })], { seedLength: 0 }))
    .toMatchObject({ inheritedEventCount: 0 })
  expect(coharnessJsonlFormatCatalog.readHeader(header(3, { extra: true }))).toMatchObject({ status: 'malformed' })
  expect(coharnessJsonlFormatCatalog.readHeader(null)).toMatchObject({ status: 'malformed' })
})

it('rejects non-string credential attribution instead of hiding malformed legacy metadata', () => {
  expect(() => restore(2, [
    row('turn/start', 0, { turn: 1 }), row('step/start', 1, { turn: 1, step: 1 }),
    row('assistant/chunk', 2, { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 }, credentialSource: 9 } }),
  ])).toThrow('credentialSource must be a string')
})
