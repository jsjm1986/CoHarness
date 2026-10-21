/** Named references use runtime identity and read the latest materialized values. */

import { expect, it, vi } from 'vitest'
import { createSnapshotStore, EMPTY_CHAT_SNAPSHOT } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { ChatSnapshotBuilder } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { MutableChatGroupStore } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/process-groups.ts'
import { conversationSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ChatNodeModel } from '../src/client/views/chat-node/model.ts'
import { InspectorObjectValue } from '../src/client/views/object-value.ts'
import { chatNodeWithLocation } from './chat-node-fixture.client.ts'

const SESSION = 'session' as SessionId
/** Wrap one Chat snapshot in a minimal live Conversation snapshot source. */
function source(chat: () => ChatSnapshot | undefined) {
  return createSnapshotStore({ ...conversationSnapshot(SESSION), get chat() { return chat() ?? EMPTY_CHAT_SNAPSHOT } })
}

it('indexes Node, Turn, Step, and their Data identities, including hidden and replaced nodes', () => {
  const first = chatNodeWithLocation()
  if (first.location.kind !== 'step') throw new Error('Expected a Step Location')
  const { turn, step } = first.location
  const timeline = { turnOrder: [1], turns: new Map([[1, turn]]) }
  const hidden = { ...first, key: 'hidden', data: { text: 'hidden value' }, visibility: 'hidden' as const }
  const turnNode = { ...first, key: 'turn-only', location: { kind: 'turn' as const, turn } }
  const builder = new ChatSnapshotBuilder()
  let chat = builder.replace({ nodes: [first, hidden, turnNode], timeline })
  const snapshot = source(() => chat)
  const model = new ChatNodeModel(snapshot)
  const objects = model.objects('object-session' as SessionId)
  expect(objects.reference(first)?.kind).toBe('node')
  expect(objects.reference(first.data as object)?.kind).toBe('nodeData')
  const nodeData = objects.reference(first.data as object)!
  expect(nodeData.read()).toBe(first.data)
  expect(model.row('node:turn-only:')?.getSnapshot()?.location).toBe('1')
  expect(objects.reference(turn)?.kind).toBe('turn')
  expect(objects.reference(turn.data)?.kind).toBe('turnData')
  expect(objects.reference(step)?.kind).toBe('step')
  expect(objects.reference(step.data)?.kind).toBe('stepData')
  const locationReferences = [turn, turn.data, step, step.data].map(value => objects.reference(value)!)
  expect(locationReferences.map(reference => reference.read())).toEqual([turn, turn.data, step, step.data])
  expect(objects.reference(hidden)?.rowKey).toBe('node:hidden:')
  expect(objects.row('node:hidden:')?.target.nodeKey).toBe('hidden')
  expect(objects.row('missing')).toBeUndefined()
  expect(model.pick({ nodeKey: hidden.key })).toBe('node:hidden:')
  expect(objects.reference({ ...first })).toBeUndefined()
  const reference = objects.reference(first)!
  const updated = { ...first, data: { text: 'updated' } }
  chat = builder.apply({ upserts: [updated], timeline })
  expect(objects.reference(updated)?.id).toBe(reference.id)
  expect(objects.reference(updated.data as object)?.kind).toBe('nodeData')
  expect(reference.read()).toBe(updated)
  expect(nodeData.read()).toBe(updated.data)
  chat = builder.replace({ nodes: [], timeline: { turnOrder: [], turns: new Map() } })
  expect(reference.read()).toBeUndefined()
  expect(nodeData.read()).toBeUndefined()
  expect(locationReferences.map(reference => reference.read())).toEqual([undefined, undefined, undefined, undefined])
})

it('navigates Group snapshots, Group Data, and named member parts through their latest sources', () => {
  const first = chatNodeWithLocation()
  if (first.location.kind !== 'step') throw new Error('Expected a Step Location')
  const builder = new ChatSnapshotBuilder()
  const timeline = { turnOrder: [1], turns: new Map([[1, first.location.turn]]) }
  const loose = { ...first, key: 'loose', location: { kind: 'session' as const }, data: 1 }
  const other = { ...first, key: 'other' }
  const built = builder.replace({ nodes: [first, loose, other], timeline })
  const key = 'inspect-group'
  const member = { key: first.key, groupPart: 'reasoning' as const }
  const plain = { key: other.key }
  const group = { key, data: { count: 1 }, members: [member, plain] }
  const groups = new MutableChatGroupStore()
  groups.replace([group])
  const chat: ChatSnapshot = { ...built,
    entries: [{ kind: 'group', key }, { kind: 'node', key: loose.key }], groups }
  const snapshot = source(() => chat)
  const model = new ChatNodeModel(snapshot)
  const objects = model.objects('group-object-session' as SessionId)
  const groupReference = objects.reference(group)!
  const dataReference = objects.reference(group.data)!
  const memberReference = objects.reference(member)!
  expect(groupReference.kind).toBe('group')
  expect(groupReference.read()).toBe(group)
  expect(dataReference.kind).toBe('groupData')
  expect(dataReference.read()).toBe(group.data)
  expect(memberReference.target.groupPart).toBe('reasoning')
  expect(memberReference.read()).toBe(first)
  expect(objects.reference(plain)?.target.groupPart).toBeUndefined()
  expect(objects.reference(loose)?.target.turn).toBeUndefined()
  expect(model.row(`node:${first.key}:reasoning`)?.getSnapshot()?.identity).toContain('#reasoning')
  expect(objects.row(`group:${key}`)?.kind).toBe('group')
  expect(model.pick({ groupKey: key })).toBe(`group:${key}`)
  expect(objects.reference(member)?.rowKey).toBe(`node:${first.key}:reasoning`)

  const updated = { ...group, data: { count: 2 } }
  groups.apply([updated], [])
  const published = groups.get(key)!
  expect(published).toEqual(updated)
  expect(groupReference.read()).toBe(published)
  expect(dataReference.read()).toBe(updated.data)
  expect(objects.reference(published)?.id).toBe(groupReference.id)
  groups.replace([])
  expect(groupReference.read()).toBeUndefined()
  expect(dataReference.read()).toBeUndefined()
})

it('keeps collection keys, members, typed arrays, and non-enumerable fields without evaluating getters', () => {
  const key = { name: 'object key' }
  const value = { name: 'value' }
  const map = new InspectorObjectValue(new Map([[key, value]]))
  expect(map.label).toBe('Map(1)')
  expect([...map.entries()][0]?.value).toEqual({ key, value })
  const set = new InspectorObjectValue(new Set([value]))
  expect(set.label).toBe('Set(1)')
  expect([...set.entries()][0]?.value).toBe(value)
  const getter = vi.fn(() => { throw new Error('must not execute') })
  const object = Object.defineProperties({}, { hidden: { value: 1 }, computed: { get: getter } })
  expect([...new InspectorObjectValue(object).entries()]).toEqual([
    { key: 'hidden', name: 'hidden', value: 1 },
    { key: 'computed', name: 'computed', value: undefined, accessor: true },
  ])
  expect(getter).not.toHaveBeenCalled()
  expect(new InspectorObjectValue(new Uint8Array([7])).label).toBe('Uint8Array')
  expect(new InspectorObjectValue(new WeakMap()).expandable).toBe(false)
  expect(new InspectorObjectValue(123n).label).toBe('123n')
})

it('retains Location references without rows and rejects stale unindexed values from an inactive table', () => {
  const first = chatNodeWithLocation()
  if (first.location.kind !== 'step') throw new Error('Expected a Step Location')
  const timeline = { turnOrder: [1], turns: new Map([[1, first.location.turn]]) }
  const builder = new ChatSnapshotBuilder()
  let chat: ChatSnapshot | undefined = builder.replace({ nodes: [], timeline })
  const snapshot = source(() => chat)
  const model = new ChatNodeModel(snapshot)
  const objects = model.objects('inactive-object-session' as SessionId)
  const location = objects.reference(first.location.turn)!
  expect(location.target).toEqual({ turn: 1 })
  expect(location.rowKey).toBeUndefined()
  chat = builder.replace({ nodes: [first], timeline })
  model.pick({ nodeKey: first.key })
  const replacement = { ...first, data: { text: 'replacement' } }
  chat = new ChatSnapshotBuilder().replace({ nodes: [replacement], timeline })
  expect(objects.row(`node:${first.key}:`)).toBeUndefined()
  model.pick({ nodeKey: first.key })
  expect(objects.row(`node:${first.key}:`)?.read()).toBe(replacement)
  chat = undefined
  expect(objects.reference({})).toBeUndefined()
})
