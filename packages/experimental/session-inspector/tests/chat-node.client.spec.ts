/** Chat inspection follows grouping while content updates stay on keyed row sources. */

import type { ChatConversationViewNode, ChatFlowEntry, ChatGroupSnapshot, ChatSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { ChatSnapshotBuilder } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { MutableChatGroupStore } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/process-groups.ts'
import { conversationSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ChatNodeModel } from '../src/client/views/chat-node/model.ts'

const timeline = { turnOrder: [], turns: new Map() }
const SESSION = 'session' as SessionId
function node(key: string, text = key, anchorSeq = 1): ChatConversationViewNode {
  return { key, id: key, target: 'chat', kind: 'test', anchorSeq,
    location: { kind: 'session' }, visibility: 'visible', data: { text } }
}

/** Wrap one Chat snapshot in a minimal live Conversation snapshot source. */
function source(chat: () => ChatSnapshot) {
  return createSnapshotStore({ ...conversationSnapshot(SESSION), get chat() { return chat() } })
}

it('nests group members, includes hidden Nodes, and leaves row order unchanged on content updates', async () => {
  const builder = new ChatSnapshotBuilder()
  const first = node('first')
  const second = node('second')
  const hidden = { ...node('hidden', 'hidden', 3), visibility: 'hidden' as const }
  let chat = builder.replace({ nodes: [first, second, hidden], timeline })
  const groups = new MutableChatGroupStore()
  const groupKey = 'group'
  const group = (keys: string[]): ChatGroupSnapshot => ({ key: groupKey, data: { count: keys.length },
    members: keys.map(key => ({ key })) })
  const entries = (flow: readonly ChatFlowEntry[]): ChatSnapshot => ({ ...chat, entries: flow, groups })
  chat = entries([{ kind: 'group', key: groupKey }, { kind: 'node', key: second.key }])
  groups.replace([group([first.key])])
  const snapshot = source(() => chat)
  const model = new ChatNodeModel(snapshot)
  const changed = vi.fn()
  onTestFinished(model.subscribe(changed))
  expect(model.getSnapshot()).toEqual([
    { key: 'group:group', depth: 0 }, { key: 'node:first:', parent: 'group:group', depth: 1 },
    { key: 'node:second:', depth: 0 }, { key: 'node:hidden:', depth: 0 },
  ])
  const order = model.getSnapshot()
  const source$ = model.row('node:first:')!
  const notify = vi.fn()
  onTestFinished(source$.subscribe(notify))
  const before = source$.getSnapshot()
  expect(before?.summary).not.toContain('key: first')
  expect(before?.summary).not.toContain('kind: test')
  expect(before?.value).toBe(first)
  expect(model.row('group:group')!.getSnapshot()?.summary).not.toContain('key: group')
  changed.mockClear()
  chat = { ...builder.apply({ upserts: [node('first', 'updated')], timeline }), entries: chat.entries, groups }
  snapshot.set({ ...conversationSnapshot(SESSION), chat })
  expect(notify).toHaveBeenCalledOnce()
  expect(source$.getSnapshot()).not.toBe(before)
  expect(source$.getSnapshot()?.value).toMatchObject({ data: { text: 'updated' } })
  expect(model.getSnapshot()).toBe(order)
  expect(changed).not.toHaveBeenCalled()
  groups.apply([group([first.key, second.key])], [])
  snapshot.set({ ...conversationSnapshot(SESSION), chat })
  await Promise.resolve()
  expect(model.getSnapshot().find(row => row.key === 'node:second:')).toMatchObject({ depth: 1, parent: 'group:group' })
  expect(model.row('node:first:')).toBe(source$)
})

it('places unlisted assistant steps by event anchor without inventing group membership or appending after Turn tails', () => {
  const builder = new ChatSnapshotBuilder()
  const first = node('first-member', 'first', 3)
  const second = node('second-member', 'second', 7)
  const hidden = { ...node('assistant-step:1:1', 'hidden', 5), kind: 'assistant-step', visibility: 'hidden' as const }
  const otherHidden = { ...node('assistant-step:2:1', 'hidden', 15), kind: 'assistant-step', visibility: 'hidden' as const }
  let chat = builder.replace({ nodes: [
    node('turn-start:1', 'start', 1), first, second, node('turn-tail:1', 'tail', 10),
    node('turn-start:2', 'start', 11), node('turn-tail:2', 'tail', 20), otherHidden, hidden,
  ], timeline })
  const groupKey = 'process'
  const members = [first, second].map(value => ({ key: value.key }))
  const groups = new MutableChatGroupStore()
  groups.replace([{ key: groupKey, members, data: {} }])
  chat = { ...chat, entries: [
    { kind: 'node', key: 'turn-start:1' }, { kind: 'group', key: groupKey },
    ...['turn-tail:1', 'turn-start:2', 'turn-tail:2'].map(key => ({ kind: 'node' as const, key })),
  ], groups }
  const snapshot = source(() => chat)
  const model = new ChatNodeModel(snapshot)
  onTestFinished(model.subscribe(vi.fn()))
  expect(model.getSnapshot().map(row => row.key)).toEqual([
    'node:turn-start:1:', 'group:process', 'node:first-member:', 'node:second-member:',
    'node:assistant-step:1:1:', 'node:turn-tail:1:', 'node:turn-start:2:', 'node:assistant-step:2:1:', 'node:turn-tail:2:',
  ])
  expect(groups.get(groupKey)?.members).toBe(members)
  expect(model.getSnapshot().find(row => row.key === 'node:assistant-step:1:1:')?.depth).toBe(0)
  const source$ = model.row('node:assistant-step:1:1:')
  chat = { ...builder.apply({ upserts: [{ ...hidden, anchorSeq: 17 }], timeline }), entries: chat.entries, groups }
  snapshot.set({ ...conversationSnapshot(SESSION), chat })
  expect(model.getSnapshot().slice(-3).map(row => row.key))
    .toEqual(['node:assistant-step:2:1:', 'node:assistant-step:1:1:', 'node:turn-tail:2:'])
  expect(model.row('node:assistant-step:1:1:')).toBe(source$)
})

it('retires groups and queued updates when the table is not observed', async () => {
  const builder = new ChatSnapshotBuilder()
  const first = node('first')
  const second = node('second', 'second', 2)
  let chat: ChatSnapshot = builder.empty
  const groups = new MutableChatGroupStore()
  const snapshot = source(() => chat)
  const model = new ChatNodeModel(snapshot)
  expect(model.getSnapshot()).toEqual([])
  expect(model.pick({ nodeKey: 'missing' })).toBeUndefined()
  const releases: Array<() => void> = []
  onTestFinished(() => { for (const release of releases.splice(0)) release() })
  releases.push(model.subscribe(vi.fn()), model.subscribe(vi.fn()))
  chat = builder.replace({ nodes: [first, second], timeline })
  snapshot.set({ ...conversationSnapshot(SESSION), chat })
  expect(model.getSnapshot()).toHaveLength(2)
  const original = model.row('node:first:')
  const key = 'live-group'
  const update = (keys: string[]): void => {
    groups.replace([{ key, members: keys.map(value => ({ key: value })), data: {} }])
    chat = { ...chat, entries: [{ kind: 'group', key }], groups }
  }
  update(['first'])
  snapshot.set({ ...conversationSnapshot(SESSION), chat })
  expect(original).toBeDefined()
  expect(model.getSnapshot().find(row => row.key === 'node:first:')?.parent).toBe('group:live-group')
  update(['first', 'second'])
  update(['second'])
  update(['second'])
  snapshot.set({ ...conversationSnapshot(SESSION), chat })
  await Promise.resolve()
  expect(model.getSnapshot().find(row => row.key === 'node:second:')?.parent).toBe('group:live-group')
  expect(model.getSnapshot().find(row => row.key === 'node:first:')?.parent).toBeUndefined()
  const previousGroups = groups
  const nextGroups = new MutableChatGroupStore()
  nextGroups.replace([{ key, members: [{ key: 'second' }], data: {} }])
  chat = { ...chat, entries: [{ kind: 'group', key }], groups: nextGroups }
  snapshot.set({ ...conversationSnapshot(SESSION), chat })
  const currentRows = model.getSnapshot()
  previousGroups.replace([])
  snapshot.set({ ...conversationSnapshot(SESSION), chat })
  await Promise.resolve()
  expect(model.getSnapshot().map(row => row.key)).toEqual(currentRows.map(row => row.key))
  chat = { ...chat, entries: [], groups: nextGroups }
  nextGroups.replace([])
  snapshot.set({ ...conversationSnapshot(SESSION), chat })
  await Promise.resolve()
  expect(model.row('group:live-group')).toBeUndefined()
  update(['first'])
  snapshot.set({ ...conversationSnapshot(SESSION), chat })
  update(['second'])
  for (const release of releases.splice(0)) release()
  const hidden = model.getSnapshot()
  await Promise.resolve()
  expect(model.getSnapshot()).toBe(hidden)
  chat = new ChatSnapshotBuilder().replace({ nodes: [], timeline })
  snapshot.set({ ...conversationSnapshot(SESSION), chat })
  expect(model.getSnapshot()).toBe(hidden)
})

it('keeps an unavailable group source empty and orders unlisted nodes with equal anchors deterministically', () => {
  const builder = new ChatSnapshotBuilder()
  const nodes = ['b', 'a'].map(key => ({ ...node(key), visibility: 'hidden' as const }))
  const built = builder.replace({ nodes, timeline })
  const key = 'loading-group'
  const groups = new MutableChatGroupStore()
  const chat: ChatSnapshot = { ...built, entries: [{ kind: 'group', key }], groups }
  const snapshot = source(() => chat)
  const model = new ChatNodeModel(snapshot)
  onTestFinished(model.subscribe(vi.fn()))
  expect(model.getSnapshot().map(row => row.key)).toEqual(['group:loading-group', 'node:a:', 'node:b:'])
  expect(model.row('group:loading-group')?.getSnapshot()).toBeUndefined()
})
