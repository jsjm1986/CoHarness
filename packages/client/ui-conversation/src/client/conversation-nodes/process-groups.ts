/** Chat-owned partitioning, ordering, and incremental activity summaries over materialized Node inputs. */
import type {
  ChatConversationViewNode, ChatFlowEntry, ChatGroupMember, ChatGroupSnapshot,
  ChatLocationNodeIndex, ChatNodeStore, ChatGroupStore, ConversationTimelineSnapshot, ToolCallBlock,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { isRunningTool } from '../contract/chat-nodes.ts'
import type { ProcessActivity, ProcessActivitySummary, ProcessGroupData } from '../contract/process-groups.ts'
import { hasAssistantReplyContent } from '../contract/assistant-content.ts'
import { isAtOrOutside } from '../contract/group-tree.ts'

function turnOf(node: ChatNode | ChatConversationViewNode | undefined): number | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined
}

function reasoning(node: ChatNode): boolean {
  return node.kind === 'assistant-step'
    && node.data.blocks.some(block => block.kind === 'reasoning' && block.text.trim() !== '')
}

function reply(node: ChatNode): boolean {
  return node.kind === 'assistant-step' && hasAssistantReplyContent(node.data.blocks)
}

function activity(name: string): ProcessActivity {
  if (name === 'read') return 'read'
  if (name === 'read_image') return 'readImage'
  if (name === 'grep' || name === 'glob' || name.endsWith('_inspect')) return 'search'
  if (name === 'write') return 'write'
  if (name === 'edit' || name === 'apply_patch') return 'edit'
  if (['bash', 'pwsh', 'exec_command', 'write_stdin'].includes(name) || name.startsWith('terminal_')) return 'commands'
  if (name === 'run_code') return 'code'
  if (name === 'web_search') return 'webSearch'
  if (name === 'web_fetch') return 'webFetch'
  if (name === 'subagent' || name.startsWith('subagent_')) return 'subagents'
  if (['todo_write', 'create_goal', 'update_goal', 'get_goal'].includes(name)) return 'plan'
  if (name === 'ask_user_question' || name === 'request_user_input') return 'questions'
  return 'tools'
}

const LIVE_TOOL_DETAIL_MAX_CHARS = 160
const LIVE_TOOL_DETAIL_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const LIVE_TOOL_DETAIL_KEYS = [
  'title', 'description', 'objective', 'task', 'task_name', 'name', 'question', 'questions', 'prompt', 'message',
  'command', 'cmd', 'queries', 'query', 'pattern', 'url', 'uri', 'file_path', 'path', 'target', 'action', 'status',
] as const

function normalizeLiveToolText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= LIVE_TOOL_DETAIL_MAX_CHARS) return normalized
  const chars: string[] = []
  for (const { segment } of LIVE_TOOL_DETAIL_SEGMENTER.segment(normalized)) {
    if (chars.length === LIVE_TOOL_DETAIL_MAX_CHARS) {
      return `${chars.slice(0, LIVE_TOOL_DETAIL_MAX_CHARS - 1).join('').trimEnd()}…`
    }
    chars.push(segment)
  }
  return normalized
}

function normalizeLiveToolDetail(value: unknown): string {
  const text = typeof value === 'string'
    ? value
    : Array.isArray(value) && value.every(item => typeof item === 'string')
      ? value.join(', ')
      : ''
  return normalizeLiveToolText(text)
}

function questionDetail(value: unknown): string {
  if (!Array.isArray(value)) return ''
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const detail = normalizeLiveToolDetail(Reflect.get(item, 'question'))
    if (detail !== '') return detail
  }
  return ''
}

/** Read the argument object of a dispatched call; malformed JSON degrades to no detail keys. */
function parseArguments(argsRaw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/**
 * One-line task detail from dispatched call arguments: the first detail key
 * holding text, else the tool name once the complete arguments gave no key.
 * @param name - resolved tool name.
 * @param argsRaw - verbatim argument JSON; undefined while the call is still preparing.
 * @returns bounded display text for the group title.
 */
function liveToolDetail(name: string, argsRaw: string | undefined): string {
  const args = argsRaw === undefined ? null : parseArguments(argsRaw)
  if (args !== null) {
    for (const key of LIVE_TOOL_DETAIL_KEYS) {
      if (!Object.hasOwn(args, key)) continue
      const detail = key === 'questions' ? questionDetail(args[key]) : normalizeLiveToolDetail(args[key])
      if (detail !== '') return detail
    }
  }
  return argsRaw === undefined ? '' : normalizeLiveToolDetail(name)
}

function liveReasoningDetail(nodes: readonly ChatNode[]): string {
  for (let nodeIndex = nodes.length - 1; nodeIndex >= 0; nodeIndex--) {
    const node = nodes[nodeIndex]
    if (node?.kind !== 'assistant-step' || node.data.status !== 'running') continue
    for (let blockIndex = node.data.blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = node.data.blocks[blockIndex]
      if (block?.kind !== 'reasoning') continue
      const paragraphs = block.text.split(/\r?\n[\t ]*\r?\n/)
      for (let paragraphIndex = paragraphs.length - 1; paragraphIndex >= 0; paragraphIndex--) {
        const detail = normalizeLiveToolDetail(paragraphs[paragraphIndex]?.replaceAll('**', ''))
        if (detail !== '') return detail
      }
    }
  }
  return ''
}

/**
 * Rank categories by distinct call count, breaking ties by first appearance.
 * @param nodes - process members, including recursive tools.
 * @returns all ranked categories and the latest running tool category and bounded task detail.
 */
export function processActivity(nodes: readonly ChatNode[]): ProcessActivitySummary {
  const counts = new Map<ProcessActivity, number>()
  const seen = new Set<string>()
  let running: ProcessActivity | undefined
  let runningDetail = ''
  let runningTime = -Infinity
  let preparing: boolean | undefined
  const visit = (tool: ToolCallBlock): void => {
    if (seen.has(tool.callId)) return
    seen.add(tool.callId)
    const call = isRunningTool(tool) ? tool : tool.call
    if (call !== null) {
      const kind = activity(call.name)
      if (isRunningTool(tool) && tool.time >= runningTime) {
        running = kind
        preparing = tool.phase === 'preparing'
        runningDetail = liveToolDetail(tool.name, tool.phase === 'start' ? tool.argsRaw : undefined)
        runningTime = tool.time
      }
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
    for (const child of tool.subCalls) visit(child)
  }
  for (const node of nodes) {
    if (node.kind === 'tool-call') visit(node.data.root)
  }
  if (running === undefined) runningDetail = liveReasoningDetail(nodes)
  return {
    counts: [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    running,
    runningDetail,
    ...preparing ? { preparing: true } : {},
  }
}

interface TurnProcessPresentation {
  readonly control?: ChatConversationViewNode
  readonly openingInputAnchor?: number
  readonly earliestProcessAnchor?: number
}

/** Locate each loaded Turn's process control plus its opening-input and earliest-process anchors. */
function turnProcessPresentations(
  nodes: readonly ChatConversationViewNode[],
): ReadonlyMap<number, TurnProcessPresentation> {
  const presentations = new Map<number, TurnProcessPresentation>()
  for (const raw of nodes) {
    const node = raw as ChatNode
    if (node.kind === 'turn-process') {
      presentations.set(node.data.turn, { ...presentations.get(node.data.turn), control: node })
    }
  }
  for (const raw of nodes) {
    const node = raw as ChatNode
    const location = node.location
    if (location.kind !== 'turn' && location.kind !== 'step') continue
    const current: TurnProcessPresentation = presentations.get(location.turn.turn) ?? {}
    const controlAnchor = current.control === undefined
      ? undefined
      : (current.control as ChatNode<'turn-process'>).data.controlAnchorSeq
    if (isAtOrOutside(node, 'input')
      && controlAnchor !== undefined
      && (controlAnchor === location.turn.start?.seq || node.anchorSeq < controlAnchor)) {
      presentations.set(location.turn.turn, {
        ...current,
        openingInputAnchor: Math.max(current.openingInputAnchor ?? node.anchorSeq, node.anchorSeq),
      })
      continue
    }
    if (isAtOrOutside(node, 'turn')) continue
    presentations.set(location.turn.turn, {
      ...current,
      earliestProcessAnchor: Math.min(current.earliestProcessAnchor ?? node.anchorSeq, node.anchorSeq),
    })
  }
  return presentations
}

interface PresentationPosition {
  readonly anchor: number
  readonly rank: number
  readonly originalAnchor: number
}

/**
 * Presentation rank of one Node: process candidates logged before the opening
 * human input reposition after it (rank 2), and the synthetic process control
 * sits between input and process (rank 1; rank -1 before process when no
 * opening input exists).
 */
function presentationPosition(
  raw: ChatConversationViewNode,
  presentations: ReadonlyMap<number, TurnProcessPresentation>,
): PresentationPosition {
  const node = raw as ChatNode
  const location = node.location
  if (location.kind !== 'turn' && location.kind !== 'step') {
    return { anchor: node.anchorSeq, rank: 0, originalAnchor: node.anchorSeq }
  }
  const presentation = presentations.get(location.turn.turn)
  if (presentation === undefined) {
    return { anchor: node.anchorSeq, rank: 0, originalAnchor: node.anchorSeq }
  }
  const openingInputAnchor = presentation.openingInputAnchor
  if (openingInputAnchor !== undefined
    && node.anchorSeq < openingInputAnchor
    && !isAtOrOutside(node, 'turn')) {
    return { anchor: openingInputAnchor, rank: 2, originalAnchor: node.anchorSeq }
  }
  if (presentation.control !== undefined && node.key === presentation.control.key) {
    return openingInputAnchor === undefined
      ? {
        anchor: presentation.earliestProcessAnchor ?? node.anchorSeq,
        rank: -1,
        originalAnchor: node.anchorSeq,
      }
      : { anchor: openingInputAnchor, rank: 1, originalAnchor: node.anchorSeq }
  }
  return { anchor: node.anchorSeq, rank: 0, originalAnchor: node.anchorSeq }
}

/**
 * Order visible Chat Nodes without changing existing relative order as process
 * eligibility changes. Opening input precedes process candidates, while
 * each synthetic process control sits between them.
 * @param nodes - currently materialized Chat Nodes.
 * @returns visible Nodes in presentation order.
 */
export function orderedVisibleChatNodes(
  nodes: readonly ChatConversationViewNode[],
): ChatConversationViewNode[] {
  const visible = nodes.filter(node => node.visibility === 'visible')
  const presentations = turnProcessPresentations(visible)
  return visible.sort((left, right) => {
    const leftPosition = presentationPosition(left, presentations)
    const rightPosition = presentationPosition(right, presentations)
    return leftPosition.anchor - rightPosition.anchor
      || leftPosition.rank - rightPosition.rank
      || leftPosition.originalAnchor - rightPosition.originalAnchor
      || left.key.localeCompare(right.key)
  })
}

function sameSummary(left: ProcessActivitySummary, right: ProcessActivitySummary): boolean {
  return left.running === right.running && left.runningDetail === right.runningDetail
    && left.preparing === right.preparing
    && left.counts.length === right.counts.length && left.counts.every((value, index) =>
    value.kind === right.counts[index]?.kind && value.count === right.counts[index].count)
}

function sameMembers(left: readonly ChatGroupMember[], right: readonly ChatGroupMember[]): boolean {
  return left.length === right.length && left.every((value, index) =>
    value.key === right[index]?.key && value.groupPart === right[index].groupPart)
}

function sameEntries(left: readonly ChatFlowEntry[], right: readonly ChatFlowEntry[]): boolean {
  return left.length === right.length && left.every((value, index) => {
    const other = right[index]
    if (other === undefined || value.kind !== other.kind || value.key !== other.key) return false
    return value.kind === 'node' && other.kind === 'node' ? value.groupPart === other.groupPart : true
  })
}

/**
 * Whether a Node change can move it between process runs or the root flow:
 * kind, Turn, visibility, anchor, or the reasoning/reply boundary of an Assistant.
 */
function structureChanged(previous: ChatNode | undefined, current: ChatNode): boolean {
  if (previous === undefined) return true
  if (previous.visibility !== 'visible' && current.visibility !== 'visible') return false
  return previous.kind !== current.kind
    || previous.anchorSeq !== current.anchorSeq
    || turnOf(previous) !== turnOf(current)
    || previous.visibility !== current.visibility
    || reasoning(previous) !== reasoning(current) || reply(previous) !== reply(current)
}

interface NodeSource {
  get(key: string): ChatConversationViewNode | undefined
}

function readChatNode(source: NodeSource, key: string): ChatNode {
  const node = source.get(key) as ChatNode | undefined
  if (node === undefined) throw new Error(`Chat grouping input is missing Node ${key}`)
  return node
}

/** One group's members and cached summary, refreshed together when its content changes. */
class ProcessGroup {
  private nodes: readonly ChatNode[] = []
  snapshot: ChatGroupSnapshot

  constructor(
    readonly key: string,
    readonly turn: number,
    readonly members: readonly ChatGroupMember[],
  ) {
    this.snapshot = {
      key,
      members,
      data: { turn, closed: false, summary: { counts: [], running: undefined, runningDetail: '' } },
    }
  }

  refresh(source: NodeSource, closed: boolean): void {
    const nodes = this.members.map(member => readChatNode(source, member.key))
    const unchanged = nodes.length === this.nodes.length && nodes.every((node, index) => node === this.nodes[index])
    const previous = this.snapshot.data as ProcessGroupData
    const activity = unchanged && previous.closed === closed ? previous.summary : processActivity(nodes)
    const summary = closed ? { counts: activity.counts, running: undefined, runningDetail: '' } : activity
    this.nodes = nodes
    if (previous.closed !== closed || !sameSummary(previous.summary, summary)) {
      this.snapshot = {
        key: this.key, members: this.members,
        data: { turn: this.turn, closed, summary },
      }
    }
  }
}

/** One Turn's grouping result and member lookup; summaries stay with their groups. */
class TurnProcessGroups {
  private groups = new Map<string, ProcessGroup>()
  private membership = new Map<string, string>()
  private roots = new Map<string, readonly ChatFlowEntry[]>()

  constructor(readonly turn: number) {}

  /** Root flow entries anchored at one member/root key. */
  references(key: string): readonly ChatFlowEntry[] {
    return this.roots.get(key) ?? []
  }

  snapshots(): ChatGroupSnapshot[] {
    return [...this.groups.values()].map(group => group.snapshot)
  }

  /** Refresh summaries for groups containing changed members; every open group refreshes when the Turn closed. */
  refresh(source: NodeSource, changed: ReadonlySet<string>, turnClosed: boolean): ChatGroupSnapshot[] {
    const dirty = new Set<string>()
    for (const node of changed) {
      const group = this.membership.get(node)
      if (group !== undefined) dirty.add(group)
    }
    if (turnClosed) {
      for (const group of this.groups.values()) {
        if (!(group.snapshot.data as ProcessGroupData).closed) dirty.add(group.key)
      }
    }
    const upserts: ChatGroupSnapshot[] = []
    for (const key of dirty) {
      const group = this.groups.get(key) as ProcessGroup
      const previous = group.snapshot
      group.refresh(source, (previous.data as ProcessGroupData).closed || turnClosed)
      if (group.snapshot !== previous) upserts.push(group.snapshot)
    }
    return upserts
  }

  /**
   * Repartition the Turn's visible members into process runs.
   * @param source - resident Node reader.
   * @param turnKeys - the Turn's visible keys in presentation order.
   * @param turnClosed - whether the Turn's location reports status closed.
   * @param followed - whether another visible Node follows this Turn's last key in the flow.
   * @param added - keys first visible in this batch; lets a group keep its identity while new members append.
   */
  rebuild(
    source: NodeSource,
    turnKeys: readonly string[],
    turnClosed: boolean,
    followed: boolean,
    added: ReadonlySet<string>,
  ): { upserts: ChatGroupSnapshot[]; removes: string[] } {
    const roots = new Map<string, readonly ChatFlowEntry[]>()
    const groups = new Map<string, ProcessGroup>()
    const membership = new Map<string, string>()
    let pending: ChatGroupMember[] = []
    const upserts: ChatGroupSnapshot[] = []
    const emit = (key: string, entry: ChatFlowEntry): void => {
      roots.set(key, [...roots.get(key) ?? [], entry])
    }
    const flush = (closed: boolean): void => {
      const first = pending[0]
      if (first === undefined) return
      const retained = this.extendedGroup(pending, added)
      const key = retained?.key ?? `process:${first.key}:${first.groupPart ?? ''}`
      const previous = this.groups.get(key)
      const before = previous?.snapshot
      const group = previous !== undefined && sameMembers(previous.members, pending)
        ? previous : new ProcessGroup(key, this.turn, pending)
      group.refresh(source, closed || turnClosed)
      groups.set(group.key, group)
      emit(first.key, { kind: 'group', key: group.key })
      for (const member of pending) membership.set(member.key, group.key)
      if (group.snapshot !== before) upserts.push(group.snapshot)
      pending = []
    }
    for (const key of turnKeys) {
      const node = readChatNode(source, key)
      if (isAtOrOutside(node, 'process')) {
        flush(true)
        emit(key, { kind: 'node', key })
      } else if (node.kind === 'assistant-step') {
        // One Node, two rows: reasoning joins the process run, a reply stands outside it.
        if (reasoning(node)) pending.push({ key, groupPart: 'reasoning' })
        if (reply(node)) {
          flush(true)
          emit(key, { kind: 'node', key, groupPart: 'response' })
        }
      } else pending.push({ key })
    }
    flush(followed)
    const removes = [...this.groups.keys()].filter(key => !groups.has(key))
    this.groups = groups
    this.membership = membership
    this.roots = roots
    return { upserts, removes }
  }

  /** Reuse identity only while the complete old group remains between newly visible members. */
  private extendedGroup(members: readonly ChatGroupMember[], added: ReadonlySet<string>): ProcessGroup | undefined {
    const offset = members.findIndex(member => !added.has(member.key))
    const first = members[offset]
    if (first === undefined) return undefined
    const key = this.membership.get(first.key)
    const previous = key === undefined ? undefined : this.groups.get(key)
    if (previous === undefined || offset + previous.members.length > members.length) return undefined
    for (let index = 0; index < previous.members.length; index++) {
      const before = previous.members[index] as ChatGroupMember
      const after = members[offset + index] as ChatGroupMember
      if (before.key !== after.key || before.groupPart !== after.groupPart) return undefined
    }
    for (let index = offset + previous.members.length; index < members.length; index++) {
      if (!added.has((members[index] as ChatGroupMember).key)) return undefined
    }
    return previous
  }
}

/** Stable live store over the projected process groups. */
export class MutableChatGroupStore implements ChatGroupStore {
  private readonly byKey = new Map<string, ChatGroupSnapshot>()

  get(key: string): ChatGroupSnapshot | undefined {
    return this.byKey.get(key)
  }

  /**
   * Install the complete group set, dropping every unlisted key.
   * @param snapshots - the complete projected groups after a rebuild.
   */
  replace(snapshots: readonly ChatGroupSnapshot[]): void {
    this.byKey.clear()
    for (const snapshot of snapshots) this.byKey.set(snapshot.key, snapshot)
  }

  /**
   * Apply one incremental projection result in place.
   * @param upserts - groups created or extended since the last result.
   * @param removes - group keys no longer present.
   */
  apply(upserts: readonly ChatGroupSnapshot[], removes: readonly string[]): void {
    for (const key of removes) this.byKey.delete(key)
    for (const snapshot of upserts) this.byKey.set(snapshot.key, snapshot)
  }
}

/** Last index in `order` each visible Turn owns; a Turn is followed when its last key is not the flow's last key. */
function lastTurnIndexes(order: readonly string[], store: NodeSource): Map<number, number> {
  const indexes = new Map<number, number>()
  order.forEach((key, index) => {
    const turn = turnOf(store.get(key))
    if (turn !== undefined) indexes.set(turn, index)
  })
  return indexes
}

/** Session-local Turn results; ordinary updates never read other Turns' Node contents. */
export class ProcessFlowProjector {
  private turns = new Map<number, TurnProcessGroups>()
  private order: readonly string[] = []
  private closedTurns = new Set<number>()
  private entries: readonly ChatFlowEntry[] = []
  /** Stable live store published on every Chat snapshot. */
  readonly groupStore = new MutableChatGroupStore()

  /** Root flow entries in presentation order; stable reference between changes. */
  get flowEntries(): readonly ChatFlowEntry[] {
    return this.entries
  }

  /**
   * Rebuild every loaded Turn's groups and the root flow entries.
   * @param order - visible Chat Node keys in presentation order.
   * @param locations - Chat Location index.
   * @param store - resident Node reader.
   * @param timeline - current Turn lifecycle projection.
   */
  replace(
    order: readonly string[],
    locations: ChatLocationNodeIndex,
    store: ChatNodeStore,
    timeline: ConversationTimelineSnapshot,
  ): void {
    const visible = new Set(order)
    const previousOrder = new Set(this.order)
    const added = new Set(order.filter(key => !previousOrder.has(key)))
    const lastIndexes = lastTurnIndexes(order, store)
    const turns = new Map<number, TurnProcessGroups>()
    const snapshots: ChatGroupSnapshot[] = []
    for (const key of order) {
      const turn = turnOf(store.get(key))
      if (turn === undefined || turns.has(turn)) continue
      const groups = new TurnProcessGroups(turn)
      const last = lastIndexes.get(turn) ?? -1
      const update = groups.rebuild(
        store,
        locations.getTurn(turn).filter(member => visible.has(member)),
        timeline.turns.get(turn)?.status === 'closed',
        last >= 0 && last < order.length - 1,
        added,
      )
      snapshots.push(...update.upserts)
      turns.set(turn, groups)
    }
    this.turns = turns
    this.order = order
    this.closedTurns = new Set(
      [...turns.keys()].filter(turn => timeline.turns.get(turn)?.status === 'closed'),
    )
    this.groupStore.replace(snapshots)
    this.entries = this.rootEntries(store)
  }

  /**
   * Fold one incremental batch: repartition Turns whose membership structure
   * changed, refresh summaries elsewhere, republish entries only when the
   * root flow moved.
   * @param changes - Node upserts with their previous versions.
   * @param order - visible Chat Node keys in presentation order.
   * @param orderChanged - whether `order` moved since the last input.
   * @param locations - Chat Location index.
   * @param store - resident Node reader.
   * @param timeline - current Turn lifecycle projection.
   */
  apply(
    changes: readonly { readonly previous: ChatConversationViewNode | undefined; readonly current: ChatConversationViewNode }[],
    order: readonly string[],
    orderChanged: boolean,
    locations: ChatLocationNodeIndex,
    store: ChatNodeStore,
    timeline: ConversationTimelineSnapshot,
  ): void {
    const visible = new Set(order)
    const regroup = new Set<number>()
    const added = new Set<string>()
    const changed = new Map<number, Set<string>>()
    const touch = (turn: number): Set<string> => {
      let keys = changed.get(turn)
      if (keys === undefined) {
        keys = new Set()
        changed.set(turn, keys)
      }
      return keys
    }
    for (const { previous, current } of changes) {
      const before = previous as ChatNode | undefined
      const after = current as ChatNode
      const turn = turnOf(after)
      if (before === undefined || before.visibility !== 'visible') added.add(after.key)
      if (structureChanged(before, after)) {
        const previousTurn = turnOf(before)
        if (previousTurn !== undefined) regroup.add(previousTurn)
        if (turn !== undefined) regroup.add(turn)
      }
      if (turn !== undefined) touch(turn).add(after.key)
    }
    const closedNow = new Set<number>()
    for (const turn of this.turns.keys()) {
      if (timeline.turns.get(turn)?.status === 'closed') closedNow.add(turn)
    }
    for (const turn of closedNow) {
      if (!this.closedTurns.has(turn)) touch(turn)
    }

    const lastIndexes = lastTurnIndexes(order, store)
    const upserts: ChatGroupSnapshot[] = []
    const removes: string[] = []
    for (const turn of regroup) {
      const turnKeys = locations.getTurn(turn).filter(member => visible.has(member))
      const groups = this.turns.get(turn) ?? new TurnProcessGroups(turn)
      const last = lastIndexes.get(turn) ?? -1
      const update = groups.rebuild(
        store,
        turnKeys,
        timeline.turns.get(turn)?.status === 'closed',
        last >= 0 && last < order.length - 1,
        added,
      )
      upserts.push(...update.upserts)
      removes.push(...update.removes)
      if (turnKeys.length === 0) this.turns.delete(turn)
      else this.turns.set(turn, groups)
    }
    for (const [turn, keys] of changed) {
      if (regroup.has(turn)) continue
      upserts.push(...this.turns.get(turn)?.refresh(store, keys, closedNow.has(turn)) ?? [])
    }
    this.closedTurns = closedNow
    const reordered = orderChanged || regroup.size > 0
    this.order = order
    const installed = new Set(upserts.map(group => group.key))
    this.groupStore.apply(upserts, removes.filter(key => !installed.has(key)))
    if (reordered) this.entries = this.rootEntries(store)
  }

  private rootEntries(store: ChatNodeStore): readonly ChatFlowEntry[] {
    const next = this.order.flatMap<ChatFlowEntry>((key) => {
      const turn = turnOf(store.get(key))
      if (turn === undefined) return [{ kind: 'node', key }]
      const references = this.turns.get(turn)?.references(key)
      return references === undefined || references.length === 0 ? [] : [...references]
    })
    return sameEntries(this.entries, next) ? this.entries : next
  }
}
