/** Remote routing uses the same explicit Session locations as Host authorization. */
import { expect, it } from 'vitest'
import { remoteSessionId } from '../src/api/remote-session-routing.ts'

it.each(['messageFeedback/list', 'messageFeedback/put', 'messageFeedback/delete', 'sessionFeedback/record'])(
  'addresses %s through its request Session', (endpoint) => {
    expect(remoteSessionId(endpoint, { request: { sessionId: 'project-session', text: 'unchanged' } })).toBe('project-session')
  },
)

it('addresses child delivery through its parent without interpreting message content', () => {
  const args = { request: { parentSessionId: 'parent', childSessionId: 'child', content: [{ type: 'text', text: 'sessionId=other' }] } }
  const before = JSON.stringify(args)
  expect(remoteSessionId('subagents/prompt', args)).toBe('parent')
  expect(JSON.stringify(args)).toBe(before)
  expect(remoteSessionId('commands/execute', { agentId: 'source', line: '/feedback text' })).toBe('source')
})

it.each(['schedule/list', 'schedule/history', 'schedule/delete', 'schedule/update'])(
  'addresses %s through its request Session', (endpoint) => {
    const args = { request: { sessionId: 'task-session', id: 'schedule-1' } }
    expect(remoteSessionId(endpoint, args)).toBe('task-session')
  },
)

it.each(['userQuestions/answer', 'userQuestions/attachWait'])(
  'addresses %s through its Agent identity', (endpoint) => {
    expect(remoteSessionId(endpoint, { agentId: 'question-session', callId: 'call-1' })).toBe('question-session')
  },
)

it('rewrites Session addresses nested inside Schedule requests', async () => {
  const { mapRemoteSessionIds } = await import('../src/api/remote-session-routing.ts')
  const map = (id: import('@deepseek-ai/dsh-session/types').SessionId) => `host:${id}` as typeof id
  const args = { request: { sessionId: 'client-session', id: 'schedule-1' } }
  expect(mapRemoteSessionIds('schedule/delete', args, map)).toEqual({ request: { sessionId: 'host:client-session', id: 'schedule-1' } })
})

it('does not infer a Session from undeclared, missing, inherited or invalid request fields', () => {
  expect(remoteSessionId('llm/discoverModels', { request: { sessionId: 'unrelated' } })).toBeUndefined()
  for (const request of [undefined, null, [], { sessionId: 1 }, { sessionId: '' }, Object.create({ sessionId: 'inherited' }) as object]) {
    expect(remoteSessionId('sessionFeedback/record', { request })).toBeUndefined()
  }
})

it('rewrites declared primary and child addresses while preserving equal strings inside content', async () => {
  const { mapRemoteSessionIds } = await import('../src/api/remote-session-routing.ts')
  const original = { request: { parentSessionId: 'runtime:parent', childSessionId: 'runtime:child',
    content: [{ type: 'text', text: 'runtime:parent' }], arbitrary: { sessionId: 'runtime:child' } } }
  const result = mapRemoteSessionIds('subagents/prompt', original, id => id.slice('runtime:'.length) as typeof id)
  expect(result).toEqual({ request: { parentSessionId: 'parent', childSessionId: 'child',
    content: original.request.content, arbitrary: original.request.arbitrary } })
  expect(result).not.toBe(original)
  expect(original.request.parentSessionId).toBe('runtime:parent')
  expect(mapRemoteSessionIds('unknown', original, () => { throw new Error('not an address') })).toBe(original)
  expect(mapRemoteSessionIds('commands/list', { agentId: 'x' }, id => id)).toEqual({ agentId: 'x' })
  expect(mapRemoteSessionIds('newPlugin/action', { scope: 'runtime:parent', text: 'runtime:parent' }, id => 'parent' as typeof id, 'scope')).toEqual({ scope: 'parent', text: 'runtime:parent' })
})

it('maps terminal and direct-child fields and keeps malformed JSON available to its owning decoder', async () => {
  const { mapRemoteSessionIds } = await import('../src/api/remote-session-routing.ts')
  const map = (id: import('@deepseek-ai/dsh-session/types').SessionId) => `wire:${id}` as typeof id
  expect(mapRemoteSessionIds('terminal/open', { sessionId: 'client', path: 'client' }, map)).toEqual({ sessionId: 'wire:client', path: 'client' })
  expect(mapRemoteSessionIds('subagents/interruptByParent', { parentSessionId: 'a', childSessionId: 'b' }, map)).toEqual({ parentSessionId: 'wire:a', childSessionId: 'wire:b' })
  for (const request of [undefined, null, [], { sessionId: 3 }, {}, Object.create({ sessionId: 'inherited' }) as object]) {
    const args = { request }
    expect(mapRemoteSessionIds('messageFeedback/list', args, map)).toBe(args)
  }
})
