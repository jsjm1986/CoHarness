import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { recoverCodexThread } from '../src/rollout.ts'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const pending = { prompt: 'perform task', throughMessageId: MessageId('m1'), externalTurnId: 'turn-1' }
const event = (type: string, fields: object = {}) => ({ type: 'event_msg', payload: { type, ...fields } })
const start = event('task_started', { turn_id: 'turn-1' })
const input = event('user_message', { message: pending.prompt })
const message = (text: string, phase: string | null = 'final_answer') => ({ type: 'response_item', payload: {
  type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }],
} })
const done = event('task_complete', { turn_id: 'turn-1', last_agent_message: 'final answer' })
const user = (content: unknown) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content } })

function rollout(entries: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'codex-rollout-proof-'))
  roots.push(root)
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
  const dir = join(root, '.codex', 'sessions', '2026', '09', '27')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'rollout-test-thread-1.jsonl')
  writeFileSync(file, entries.map(row => JSON.stringify(row)).join('\n') + '\n')
  return file
}

it('recovers the exact acknowledged turn and excludes commentary and later turns', () => {
  rollout([start, input, message('progress', 'commentary'), message('final answer'), done,
    event('task_started', { turn_id: 'turn-2' }), input, message('later answer'),
    event('task_complete', { turn_id: 'turn-2', last_agent_message: 'later answer' })])
  expect(recoverCodexThread('thread-1', pending)).toEqual({ kind: 'result', text: 'final answer' })
})

it.each([
  ['commentary only', [start, input, message('progress', 'commentary')]],
  ['final text without completion', [start, input, message('final answer')]],
  ['wrong completion', [start, input, message('final answer'), event('task_complete', { turn_id: 'turn-2', last_agent_message: 'final answer' })]],
  ['wrong prompt', [start, event('user_message', { message: 'another task' }), message('final answer'), done]],
  ['failed turn', [start, input, message('final answer'), event('task_complete', { turn_id: 'turn-1', last_agent_message: 'final answer', error: {} })]],
  ['interrupted turn', [start, input, event('turn_aborted'), message('final answer'), done]],
  ['other turn only', [event('task_started', { turn_id: 'older' }), input, message('final answer'), event('task_complete', { turn_id: 'older', last_agent_message: 'final answer' })]],
  ['missing user input', [start, message('final answer'), done]],
  ['completion disagrees with final', [start, input, message('another answer'), done]],
  ['duplicate turn identity', [start, input, message('final answer'), done, start]],
  ['rolled back', [start, input, message('final answer'), done, event('thread_rolled_back', { num_turns: 1 })]],
  ['invalid entry', [null]],
  ['invalid content', [start, input, { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: null, content: 'wrong' } }]],
  ['invalid content block', [start, input, { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: null, content: [null] } }]],
  ['blank final', [start, input, message('  '), done]],
  ['missing prompt', []],
] as const)('keeps %s unknown', (_name, rows) => {
  rollout([...rows])
  expect(recoverCodexThread('thread-1', pending)).toEqual({ kind: 'unknown' })
})

it('accepts terminal aliases and a nullable-phase final only with matching completion', () => {
  rollout([event('turn_started', { turn_id: 'turn-1' }), input, message('final answer', null),
    event('turn_complete', { turn_id: 'turn-1', last_agent_message: 'final answer', error: null })])
  expect(recoverCodexThread('thread-1', pending)).toEqual({ kind: 'result', text: 'final answer' })
})

it('reads the official response-item dialect without confusing context or images with the prompt', () => {
  const answer = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'final answer' }] } }
  rollout([start, user([{ type: 'input_text', text: 'environment context' }]),
    user([{ type: 'input_image', image_url: 'fixture' }, { type: 'input_text', text: pending.prompt }]), answer, done])
  expect(recoverCodexThread('thread-1', pending)).toEqual({ kind: 'result', text: 'final answer' })
})

it.each([
  [user('invalid')],
  [user([{ type: 'input_text', text: pending.prompt }]), user([{ type: 'input_text', text: 'a different input' }])],
])('refuses invalid or interleaved user inputs in the same turn', (...inputs) => {
  rollout([start, ...inputs, message('final answer'), done])
  expect(recoverCodexThread('thread-1', pending)).toEqual({ kind: 'unknown' })
})

it('does not infer a turn id from repeated prompt text or ignore torn JSON', () => {
  const file = rollout([start, input, message('final answer'), done])
  expect(recoverCodexThread('thread-1', { prompt: pending.prompt, throughMessageId: pending.throughMessageId })).toEqual({ kind: 'unknown' })
  appendFileSync(file, '{"payload":')
  expect(recoverCodexThread('thread-1', pending)).toEqual({ kind: 'unknown' })
})

it('treats missing, ambiguous and non-file rollouts as unknown', () => {
  const file = rollout([start, input, message('final answer'), done])
  expect(recoverCodexThread('other-thread', pending)).toEqual({ kind: 'unknown' })
  writeFileSync(`${file.slice(0, -'rollout-test-thread-1.jsonl'.length)}duplicate-thread-1.jsonl`, '\n')
  expect(recoverCodexThread('thread-1', pending)).toEqual({ kind: 'unknown' })
  rmSync(join(roots.at(-1)!, '.codex'), { recursive: true })
  expect(recoverCodexThread('thread-1', pending)).toEqual({ kind: 'unknown' })
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('preserves uncertainty for unreadable evidence', () => {
  const file = rollout([start, input, message('final answer'), done])
  chmodSync(file, 0o000)
  try { expect(recoverCodexThread('thread-1', pending)).toEqual({ kind: 'unknown' }) }
  finally { chmodSync(file, 0o600) }
})
