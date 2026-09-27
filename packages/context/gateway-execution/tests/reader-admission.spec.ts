/** Released reader vocabulary, independent of structural Session migrations. */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { restoreReleasedV5Artifact } from '@deepseek-ai/dsh-session-format-v4-to-v5'
import { restoreReleasedV6Artifact } from '@deepseek-ai/dsh-session-format-v5-to-v6'
import { expect, it } from 'vitest'

it.each([5, 6])('makes the PR 232 format %s reader reject narrowed scopes before any automatic continuation', async (version) => {
  const restore = version === 5 ? restoreReleasedV5Artifact : restoreReleasedV6Artifact
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pr232-event-vocabulary.json', import.meta.url), 'utf8')) as {
    events: string[]
  }
  expect(createHash('sha256').update(JSON.stringify(fixture.events)).digest('hex'))
    .toBe('a4933832b4e12dd5f3e8dcd140bc87bee1f823d304039bf9bf886f07ee710b54')
  const previous = new Set(fixture.events)
  expect(previous.has('gateway/execution')).toBe(true)
  expect(previous.has('gateway/scoped-execution')).toBe(false)
  expect(previous.has('gateway/continuation')).toBe(false)
  const state = { revision: '1', inputs: ['00000000-0000-4000-8000-000000000001'],
    actors: [{ userId: 7 }], primaryActorUserId: 7, unverifiedHistory: false }
  const artifact: Parameters<typeof restoreReleasedV5Artifact>[0] = {
    header: { version, id: 'same-format', createdAt: 1, isSeeded: false, delegationDepth: 0 }, inheritedEventCount: 0,
    events: [{ seq: 0, time: 0, type: 'gateway/execution', data: { kind: 'accepted', state } }],
  }
  expect(restore(artifact, previous).events).toEqual(artifact.events)
  const scoped = { ...artifact, events: [{ ...artifact.events[0]!, data: { kind: 'accepted', state: {
    ...state, scopeId: '10000000-0000-4000-8000-000000000001',
  } } }] }
  expect(restore(scoped, previous).events).toEqual(scoped.events)
  const marked = { ...artifact, events: [
    { seq: 0, time: 0, type: 'gateway/scoped-execution', data: { version: 1 } },
    { ...scoped.events[0]!, seq: 1 },
  ] }
  expect(() => restore(marked, previous)).toThrow(/unknown event type.*gateway\/scoped-execution/)
  expect(restore(marked, KNOWN_SESSION_EVENT_TYPES).events).toEqual(marked.events)
  const continuation = { ...artifact, events: [{ seq: 0, time: 0, type: 'gateway/continuation',
    data: { key: 'goal:example:1', scope: { parentSessionId: 'same-format', inputs: [], unverifiedHistory: true } } }] }
  expect(() => restore(continuation, previous)).toThrow(/unknown event type.*gateway\/continuation/)
  expect(restore(continuation, KNOWN_SESSION_EVENT_TYPES).events).toEqual(continuation.events)
})
