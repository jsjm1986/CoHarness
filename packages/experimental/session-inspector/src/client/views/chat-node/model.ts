/** Chat table order follows root flow entries and group membership, independently of row data. */

import type {
  ChatConversationViewNode, ChatFlowEntry, ChatGroupMember, ChatGroupSnapshot, ChatSnapshot,
  ConversationSnapshot, ObservableSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { InspectorRecordSource, type InspectorRecord, type InspectorRow } from '../table-model.ts'
import { inspectorPreview } from '../format.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InspectorChatTarget, InspectorObjects, InspectorObjectReference } from '../objects.ts'
import { ChatObjectIndex } from './objects.ts'
import { matchChatNodeRow, type InspectorPickTarget } from './pick-match.ts'

const EMPTY: readonly InspectorRow[] = []
const COLUMN_FIELDS = ['key', 'kind']

function nodeRecord(node: ChatConversationViewNode): InspectorRecord {
  const location = node.location
  return { type: node.kind, identity: node.key,
    location: location.kind === 'step' ? `${location.turn.turn}/${location.step.step}`
      : location.kind === 'turn' ? String(location.turn.turn) : location.kind,
    value: node, summary: inspectorPreview(node, COLUMN_FIELDS) }
}

/** Observes structural Chat changes while visible rows observe their own Node or Group. */
export class ChatNodeModel implements ObservableSnapshot<readonly InspectorRow[]> {
  private readonly rows = createSnapshotStore<readonly InspectorRow[]>(EMPTY)
  private readonly sources = new Map<string, ObservableSnapshot<InspectorRecord | undefined>>()
  private entries: readonly ChatFlowEntry[] | undefined
  private order: readonly string[] | undefined
  private keys: readonly string[] | undefined
  private anchors: readonly number[] | undefined
  private nodeStore: ChatSnapshot['nodes'] | undefined
  private groupStore: ChatSnapshot['groups'] | undefined
  private readonly memberVersions = new Map<string, readonly ChatGroupMember[]>()
  private subscribers = 0
  private disconnect: (() => void) | undefined
  private readonly targets = new Map<string, InspectorChatTarget>()
  private readonly objectIndex: ChatObjectIndex

  /** @param session - Existing Session-owned Conversation snapshot source for the inspected Session. */
  constructor(private readonly session: ObservableSnapshot<ConversationSnapshot>) {
    this.objectIndex = new ChatObjectIndex(session)
    this.refresh()
  }

  /**
   * Bind object references and publication updates to the inspected Session.
   * @param sessionId - Session displayed by this model.
   * @returns Weak object lookup and row navigation for its details.
   */
  objects(sessionId: SessionId): InspectorObjects {
    const reference = (value: object): InspectorObjectReference | undefined => {
      const found = this.objectIndex.reference(value)
      if (found === undefined) return undefined
      const row = [...this.targets].find(([, target]) => found.target.nodeKey !== undefined
        ? target.nodeKey === found.target.nodeKey && (found.target.groupPart === undefined || target.groupPart === found.target.groupPart)
        : found.target.groupKey !== undefined && target.groupKey === found.target.groupKey)
      return { ...found, ...(row === undefined ? {} : { rowKey: row[0] }) }
    }
    return { sessionId, updates: this.session, reference, row: (key) => {
      const value = this.row(key)?.getSnapshot()?.value
      if (value === null || typeof value !== 'object') return undefined
      const found = reference(value)
      const target = this.targets.get(key)
      return found === undefined || target === undefined ? undefined : { ...found, rowKey: key, target }
    } }
  }

  /** @returns Stable flattened group/node order. */
  getSnapshot = (): readonly InspectorRow[] => this.rows.getSnapshot()

  /**
   * Match a picked Chat object against the current table, including folded children.
   * @param target - Picked Chat identities.
   * @returns Closest current Node or Group row, or undefined without a match.
   */
  pick(target: InspectorPickTarget): string | undefined {
    this.refresh(true)
    return matchChatNodeRow(target, this.targets)
  }

  /** @param listener - Structural invalidation callback. @returns Its disposer. */
  subscribe = (listener: () => void): (() => void) => {
    const stop = this.rows.subscribe(listener)
    if (this.subscribers++ === 0) {
      this.disconnect = this.session.subscribe(() => { this.refresh() })
      this.refresh(true)
    }
    return () => {
      stop()
      if (--this.subscribers === 0) {
        this.disconnect?.()
        this.disconnect = undefined
        this.memberVersions.clear()
      }
    }
  }

  /**
   * Read a loaded row without adding a subscription.
   * @param key - Stable table position.
   * @returns Cached Node or Group metadata source, or undefined outside the loaded rows.
   */
  row = (key: string): ObservableSnapshot<InspectorRecord | undefined> | undefined => this.sources.get(key)

  /** Resolve the live keyed reader for one Chat Node inside the row's own Node store. */
  private nodeSource(store: ChatSnapshot['nodes'], key: string): ObservableSnapshot<ChatConversationViewNode | undefined> {
    return { getSnapshot: () => store.get(key),
      subscribe: (listener: () => void) => this.session.subscribe(listener) }
  }

  /** Whether any known group's member list changed inside the stable group store. */
  private groupMembersChanged(chat: ChatSnapshot): boolean {
    let changed = false
    for (const entry of chat.entries) {
      if (entry.kind !== 'group') continue
      const members = chat.groups.get(entry.key)?.members ?? []
      if (this.memberVersions.get(entry.key) !== members) { changed = true; this.memberVersions.set(entry.key, members) }
    }
    return changed
  }

  /** Resolve the live keyed reader for one process Group inside the row's own Group store. */
  private groupSource(store: ChatSnapshot['groups'], key: string): ObservableSnapshot<ChatGroupSnapshot | undefined> {
    return { getSnapshot: () => store.get(key),
      subscribe: (listener: () => void) => this.session.subscribe(listener) }
  }

  private refresh(force = false): void {
    const chat = this.session.getSnapshot().chat
    const nodes = chat.nodes.values()
    const sameKeys = nodes.length === this.keys?.length
      && nodes.every((node, index) => node.key === this.keys?.[index] && node.anchorSeq === this.anchors?.[index])
    if (!force && chat.order === this.order && chat.nodes === this.nodeStore
      && sameKeys && chat.groups === this.groupStore && chat.entries === this.entries && !this.groupMembersChanged(chat)) return
    this.order = chat.order
    this.entries = chat.entries
    this.keys = nodes.map(node => node.key)
    this.anchors = nodes.map(node => node.anchorSeq)
    if (chat.groups !== this.groupStore) this.sources.clear()
    this.groupStore = chat.groups
    if (chat.nodes !== this.nodeStore) this.sources.clear()
    this.nodeStore = chat.nodes
    const activeGroups = new Set<string>()
    this.targets.clear()
    const rows: InspectorRow[] = []
    const addNode = (entry: { readonly key: string; readonly groupPart?: ChatGroupMember['groupPart'] }, parent?: string): void => {
      const key = `node:${entry.key}:${entry.groupPart ?? ''}`
      const location = chat.nodes.get(entry.key)?.location
      const turn = location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined
      const step = location?.kind === 'step' ? location.step.step : undefined
      this.targets.set(key, { nodeKey: entry.key, ...entry.groupPart === undefined ? {} : { groupPart: entry.groupPart },
        ...turn === undefined ? {} : { turn }, ...step === undefined ? {} : { step } })
      rows.push({ key, depth: parent === undefined ? 0 : 1, ...(parent === undefined ? {} : { parent }) })
      if (!this.sources.has(key)) {
        this.sources.set(key, new InspectorRecordSource(this.nodeSource(chat.nodes, entry.key), (node) => {
          const record = nodeRecord(node)
          return entry.groupPart === undefined ? record : { ...record, identity: `${node.key}#${entry.groupPart}` }
        }))
      }
    }
    const entries = chat.entries.length > 0 ? chat.entries : chat.order.map(key => ({ kind: 'node' as const, key }))
    const included = new Set<string>()
    const entryAnchors = entries.map((entry) => {
      const members = entry.kind === 'node' ? [entry] : chat.groups.get(entry.key)?.members ?? []
      let anchor: number | undefined
      for (const member of members) {
        included.add(member.key)
        const seq = chat.nodes.get(member.key)?.anchorSeq
        if (seq !== undefined) anchor = anchor === undefined ? seq : Math.min(anchor, seq)
      }
      return anchor
    })
    const unlisted = nodes.filter(node => !included.has(node.key))
      .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
    let nextUnlisted = 0
    const addUnlistedBefore = (anchor: number): void => {
      let node = unlisted[nextUnlisted]
      while (node !== undefined && node.anchorSeq <= anchor) {
        addNode({ key: node.key })
        node = unlisted[++nextUnlisted]
      }
    }
    for (const [index, entry] of entries.entries()) {
      const anchor = entryAnchors[index]
      if (anchor !== undefined) addUnlistedBefore(anchor)
      if (entry.kind === 'node') { addNode(entry); continue }
      activeGroups.add(entry.key)
      const key = `group:${entry.key}`
      this.targets.set(key, { groupKey: entry.key })
      const group = chat.groups.get(entry.key)
      rows.push({ key, depth: 0 })
      if (!this.sources.has(key)) this.sources.set(key, new InspectorRecordSource(this.groupSource(chat.groups, entry.key), value => ({
        type: 'group', identity: value.key, location: '', value, summary: inspectorPreview(value, COLUMN_FIELDS),
      })))
      const members = group?.members
      this.memberVersions.set(entry.key, members ?? [])
      for (const member of members ?? []) addNode(member, key)
    }
    addUnlistedBefore(Infinity)
    for (const key of this.memberVersions.keys()) {
      if (!activeGroups.has(key)) this.memberVersions.delete(key)
    }
    const rowKeys = new Set(rows.map(row => row.key))
    for (const key of this.sources.keys()) if (!rowKeys.has(key)) this.sources.delete(key)
    this.rows.set(rows)
  }
}
