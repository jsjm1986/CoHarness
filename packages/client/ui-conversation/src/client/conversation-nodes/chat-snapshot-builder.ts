import type { Context } from '@deepseek-ai/cordis'
import type {
  ChatConversationViewNode, ChatLocationNodeIndex, ChatNodeStore, ChatSnapshot,
  ConversationLocation, ConversationNode, ConversationTimelineSnapshot, ChatTurnNavigationIndex, TurnNavigationItem,
  ConversationViewBuilder, ConversationViewDefinition, LegacyConversationSlice,
  PartialAssistant, RunningToolCall,
} from '@deepseek-ai/dsh-client-runtime/client'
import { sessionRecallLabels, skillInvocationName } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { isRunningTool } from '../contract/chat-nodes.ts'
import { orderedVisibleChatNodes, ProcessFlowProjector } from './process-groups.ts'

const EMPTY_KEYS: readonly string[] = []
const EMPTY_TURNS: readonly number[] = []
const EMPTY_LIST: readonly never[] = []
const PREVIEW_LIMIT = 160

function preview(parts: Iterable<string>): string {
  let text = ''
  for (const part of parts) {
    text += text === '' ? part : ` ${part}`
    if (text.length >= PREVIEW_LIMIT) break
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LIMIT)
}

function turnNavigationItem(
  turn: number,
  timeline: ConversationTimelineSnapshot,
  locations: ChatLocationNodeIndex,
  nodes: ChatNodeStore,
): TurnNavigationItem | undefined {
  const loaded = locations.getTurn(turn)
    .map(key => nodes.get(key))
    .filter((node): node is ChatNode => node !== undefined && node.visibility === 'visible')
  const user = loaded.find(node => node.kind === 'user' || node.kind === 'steering')
  const anchor = user ?? loaded[0]
  if (anchor === undefined) return undefined
  const prompt = user === undefined
    ? ''
    : preview(user.data.content.flatMap(block => block.type === 'text' ? [block.text] : []))
  const responseNode = loaded.findLast(node => node.kind === 'assistant-step'
    && preview(node.data.blocks.flatMap(block => block.kind === 'text' ? [block.text] : [])) !== '')
  const response = responseNode?.kind === 'assistant-step'
    ? preview(responseNode.data.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []))
    : ''
  const location = timeline.turns.get(turn)
  const startSeq = location?.start?.seq
  const endSeq = location?.end?.seq
    ?? Math.max(startSeq ?? anchor.anchorSeq, ...loaded.map(node => node.anchorSeq))
  return {
    turn,
    anchorKey: anchor.key,
    ...(startSeq === undefined ? {} : { startSeq }),
    endSeq,
    loaded: true,
    prompt,
    response,
  }
}

function sameNavigationItem(left: TurnNavigationItem | undefined, right: TurnNavigationItem | undefined): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.turn === right.turn
      && left.anchorKey === right.anchorKey
      && left.startSeq === right.startSeq
      && left.endSeq === right.endSeq
      && left.loaded === right.loaded
      && left.prompt === right.prompt
      && left.response === right.response
}

class MutableChatTurnNavigationIndex implements ChatTurnNavigationIndex {
  private current: readonly TurnNavigationItem[] = EMPTY_LIST

  items(): readonly TurnNavigationItem[] {
    return this.current
  }

  rebuild(timeline: ConversationTimelineSnapshot, locations: ChatLocationNodeIndex, nodes: ChatNodeStore): void {
    const next = timeline.turnOrder.flatMap((turn) => {
      const item = turnNavigationItem(turn, timeline, locations, nodes)
      return item === undefined ? [] : [item]
    })
    if (next.length === this.current.length && next.every((item, index) => sameNavigationItem(this.current[index], item))) return
    this.current = next
  }
}

function sameReferences<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

class MutableChatNodeStore implements ChatNodeStore {
  private readonly byKey = new Map<string, ChatConversationViewNode>()
  private valuesCache: readonly ChatConversationViewNode[] = EMPTY_LIST

  get(key: string): ChatConversationViewNode | undefined {
    return this.byKey.get(key)
  }

  values(): readonly ChatConversationViewNode[] {
    return this.valuesCache
  }

  replace(nodes: readonly ChatConversationViewNode[]): void {
    this.byKey.clear()
    for (const node of nodes) this.byKey.set(node.key, node)
    this.valuesCache = [...this.byKey.values()]
  }

  upsert(nodes: readonly ChatConversationViewNode[]): void {
    let changed = false
    for (const node of nodes) {
      if (this.byKey.get(node.key) === node) continue
      this.byKey.set(node.key, node)
      changed = true
    }
    // Eager recompute keeps values() a pure read: published snapshots are
    // deep-frozen by the dev snapshot-store path, so a lazy write would throw.
    if (changed) this.valuesCache = [...this.byKey.values()]
  }
}

class MutableChatLocationIndex implements ChatLocationNodeIndex {
  private turns = new Map<number, readonly string[]>()
  private steps = new Map<string, readonly string[]>()

  getTurn(turn: number): readonly string[] {
    return this.turns.get(turn) ?? EMPTY_KEYS
  }

  getStep(turn: number, step: number): readonly string[] {
    return this.steps.get(stepKey(turn, step)) ?? EMPTY_KEYS
  }

  rebuild(order: readonly string[], store: ChatNodeStore): void {
    const turns = new Map<number, string[]>()
    const steps = new Map<string, string[]>()
    for (const key of order) {
      const location = store.get(key)?.location
      if (location === undefined) continue
      const coordinates = locationCoordinates(location)
      if (coordinates.turn === undefined) continue
      const turnKeys = turns.get(coordinates.turn) ?? []
      turnKeys.push(key)
      turns.set(coordinates.turn, turnKeys)
      if (coordinates.step === undefined) continue
      const step = stepKey(coordinates.turn, coordinates.step)
      const stepKeys = steps.get(step) ?? []
      stepKeys.push(key)
      steps.set(step, stepKeys)
    }
    this.turns = updateIndex(this.turns, turns)
    this.steps = updateIndex(this.steps, steps)
  }

  /** Invalidate aggregate readers when member data changes without moving. */
  touch(nodes: readonly ChatConversationViewNode[]): void {
    const turns = new Set<number>()
    const steps = new Set<string>()
    for (const node of nodes) {
      const coordinates = locationCoordinates(node.location)
      if (coordinates.turn === undefined || !this.turns.get(coordinates.turn)?.includes(node.key)) continue
      turns.add(coordinates.turn)
      if (coordinates.step !== undefined) steps.add(stepKey(coordinates.turn, coordinates.step))
    }
    for (const turn of turns) {
      const keys = this.turns.get(turn)
      if (keys === undefined) continue
      this.turns.set(turn, [...keys])
    }
    for (const step of steps) {
      const keys = this.steps.get(step)
      if (keys === undefined) continue
      this.steps.set(step, [...keys])
    }
  }
}

function updateIndex<Key>(
  previous: ReadonlyMap<Key, readonly string[]>,
  nextMutable: ReadonlyMap<Key, string[]>,
): Map<Key, readonly string[]> {
  const next = new Map<Key, readonly string[]>()
  const keys = new Set([...previous.keys(), ...nextMutable.keys()])
  for (const key of keys) {
    const before = previous.get(key) ?? EMPTY_KEYS
    const candidate = nextMutable.get(key) ?? EMPTY_KEYS
    const value = sameReferences(before, candidate) ? before : candidate
    if (candidate.length > 0) next.set(key, value)
  }
  return next
}

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

function locationCoordinates(location: ConversationLocation): { turn?: number; step?: number } {
  if (location.kind === 'step') return { turn: location.turn.turn, step: location.step.step }
  if (location.kind === 'turn') return { turn: location.turn.turn }
  return {}
}

function referenceMessageSeq(node: ChatConversationViewNode): number | undefined {
  const candidate = node as ChatNode
  return candidate.kind === 'user' || candidate.kind === 'steering'
    ? candidate.data.seq
    : undefined
}

function followingRecall(node: ChatConversationViewNode): {
  readonly messageSeq: number
  readonly labels: readonly string[]
} | undefined {
  const candidate = node as ChatNode
  if (candidate.kind !== 'context') return undefined
  return {
    messageSeq: candidate.data.seq - 1,
    labels: sessionRecallLabels(candidate.data.source),
  }
}

function withReferenceLabels(
  node: ChatConversationViewNode,
  labels: readonly string[],
): ChatConversationViewNode {
  const candidate = node as ChatNode
  if (candidate.kind !== 'user' && candidate.kind !== 'steering') return node
  const current = candidate.data.referenceLabels ?? EMPTY_KEYS
  const hasLabels = Object.hasOwn(candidate.data, 'referenceLabels')
  if (sameReferences(current, labels) && hasLabels === (labels.length > 0)) return node
  const data: Record<string, unknown> = { ...candidate.data }
  if (labels.length === 0) delete data.referenceLabels
  else data.referenceLabels = labels
  return { ...candidate, data }
}

/** Associates a direct message with the sourced recall event that immediately follows it. */
class ReferenceLabelProjector {
  private readonly messagesBySeq = new Map<number, string>()
  private readonly labelsByMessageSeq = new Map<number, readonly string[]>()

  replace(nodes: readonly ChatConversationViewNode[]): readonly ChatConversationViewNode[] {
    this.messagesBySeq.clear()
    this.labelsByMessageSeq.clear()
    for (const node of nodes) {
      const messageSeq = referenceMessageSeq(node)
      if (messageSeq !== undefined) this.messagesBySeq.set(messageSeq, node.key)
      const recall = followingRecall(node)
      if (recall !== undefined && recall.labels.length > 0) {
        this.labelsByMessageSeq.set(recall.messageSeq, recall.labels)
      }
    }
    return nodes.map((node) => {
      const messageSeq = referenceMessageSeq(node)
      return messageSeq === undefined
        ? node
        : withReferenceLabels(node, this.labelsByMessageSeq.get(messageSeq) ?? EMPTY_KEYS)
    })
  }

  apply(
    upserts: readonly ChatConversationViewNode[],
    store: ChatNodeStore,
  ): readonly ChatConversationViewNode[] {
    const byKey = new Map(upserts.map(node => [node.key, node]))
    const affected = new Set<number>()
    for (const node of upserts) {
      const messageSeq = referenceMessageSeq(node)
      if (messageSeq !== undefined) {
        this.messagesBySeq.set(messageSeq, node.key)
        affected.add(messageSeq)
      }
      const recall = followingRecall(node)
      if (recall === undefined) continue
      const current = this.labelsByMessageSeq.get(recall.messageSeq)
      if (recall.labels.length === 0) this.labelsByMessageSeq.delete(recall.messageSeq)
      else {
        this.labelsByMessageSeq.set(
          recall.messageSeq,
          current !== undefined && sameReferences(current, recall.labels) ? current : recall.labels,
        )
      }
      affected.add(recall.messageSeq)
    }
    for (const messageSeq of affected) {
      const key = this.messagesBySeq.get(messageSeq)
      if (key === undefined) continue
      const node = byKey.get(key) ?? store.get(key)
      if (node === undefined) continue
      byKey.set(key, withReferenceLabels(node, this.labelsByMessageSeq.get(messageSeq) ?? EMPTY_KEYS))
    }
    return [...byKey.values()]
  }
}

function withSkillNames(
  node: ChatConversationViewNode,
  names: readonly string[],
): ChatConversationViewNode {
  const candidate = node as ChatNode
  if (candidate.kind !== 'user' && candidate.kind !== 'steering') return node
  const current = candidate.data.skillNames ?? EMPTY_KEYS
  const hasNames = Object.hasOwn(candidate.data, 'skillNames')
  if (sameReferences(current, names) && hasNames === (names.length > 0)) return node
  const data: Record<string, unknown> = { ...candidate.data }
  if (names.length === 0) delete data.skillNames
  else data.skillNames = names
  return { ...candidate, data }
}

/** What skill-name batches are made of; every other Node is transparent. */
type SlashEntryKind = 'message' | 'skill' | 'boundary'

interface SlashEntry {
  readonly key: string
  readonly seq: number
  readonly kind: SlashEntryKind
  /** The injected skill name of a `skill` entry. */
  readonly name: string | null
}

/**
 * Classify one Node for batching: a direct message, a `skill-invocation`
 * context, or a boundary of any other kind. A context that injects no skill
 * (workspace rules, the catalog, a recall) is transparent and yields null.
 */
function slashEntryOf(node: ChatConversationViewNode): SlashEntry | null {
  const candidate = node as ChatNode
  if (candidate.kind === 'user' || candidate.kind === 'steering') {
    return { key: node.key, seq: node.anchorSeq, kind: 'message', name: null }
  }
  if (candidate.kind === 'context') {
    const name = skillInvocationName(candidate.data.source)
    return name === null ? null : { key: node.key, seq: node.anchorSeq, kind: 'skill', name }
  }
  return { key: node.key, seq: node.anchorSeq, kind: 'boundary', name: null }
}

function sameSlashEntry(left: SlashEntry, right: SlashEntry): boolean {
  return left.seq === right.seq && left.kind === right.kind && left.name === right.name
}

/**
 * Attaches each direct message's step-loaded skill names to its Node.
 *
 * A step's `skill-invocation` injections follow the direct messages the host
 * scanned for `/name` gestures and precede the step's first Node of any other
 * kind, so every non-message, non-context Node closes a batch. Every ended
 * Turn publishes its `turn-tail` Node on `turn/end` whatever the reason, so a
 * batch never spans Turns, and `step/start` precedes the direct message in
 * the log, so no boundary separates a message from its injections. Names
 * attach to every direct message of the batch: the bubble decorates only the
 * tokens its own text carries.
 *
 * The index holds only messages, skill injections, and boundaries, ordered by
 * `anchorSeq`. An apply re-reads just the batches around the Nodes whose
 * classification changed and never scans the store, so an assistant
 * streaming frame costs nothing here (the append hot path never scans the
 * Chat Nodes).
 */
export class SkillNameProjector {
  private readonly entries = new Map<string, SlashEntry>()
  /** Every indexed entry in `anchorSeq` order. */
  private sorted: SlashEntry[] = []

  /**
   * Rebuild the index from a whole Node set and attach names to its messages.
   * @param nodes - every materialized Chat Node, in any order.
   * @returns the same Nodes, direct messages carrying their batch's names.
   */
  replace(nodes: readonly ChatConversationViewNode[]): readonly ChatConversationViewNode[] {
    this.entries.clear()
    this.sorted = []
    for (const node of nodes) {
      const entry = slashEntryOf(node)
      if (entry === null) continue
      this.entries.set(entry.key, entry)
      this.sorted.push(entry)
    }
    this.sorted.sort((left, right) => left.seq - right.seq)
    const names = new Map<string, readonly string[]>()
    for (let index = 0; index < this.sorted.length; index++) {
      if (this.sorted[index]?.kind === 'boundary') continue
      const end = this.runEnd(index)
      this.assignRun(index, end, names)
      index = end
    }
    return nodes.map(node => withSkillNames(node, names.get(node.key) ?? EMPTY_KEYS))
  }

  /**
   * Fold one incremental upsert set: re-read only the batches around the
   * Nodes whose classification changed.
   * @param upserts - the changed Nodes.
   * @param store - the resident Nodes, read by key for the messages of an affected batch.
   * @returns the upserts plus any resident message whose names changed.
   */
  apply(
    upserts: readonly ChatConversationViewNode[],
    store: ChatNodeStore,
  ): readonly ChatConversationViewNode[] {
    const dirty: number[] = []
    for (const node of upserts) {
      const next = slashEntryOf(node)
      const previous = this.entries.get(node.key)
      if (previous !== undefined) {
        if (next !== null && sameSlashEntry(previous, next)) {
          // A rebuilt message Node carries Definition state only, never the
          // names a previous apply attached: re-read its batch.
          if (next.kind === 'message') dirty.push(next.seq)
          continue
        }
        this.remove(previous)
        dirty.push(previous.seq)
      }
      if (next === null) continue
      this.insert(next)
      dirty.push(next.seq)
    }
    if (dirty.length === 0) return upserts
    const names = new Map<string, readonly string[]>()
    for (const seq of dirty) this.collectAround(seq, names)
    const byKey = new Map(upserts.map(node => [node.key, node]))
    for (const [key, list] of names) {
      const node = byKey.get(key) ?? store.get(key)
      if (node === undefined) continue
      const next = withSkillNames(node, list)
      if (next !== node || byKey.has(key)) byKey.set(key, next)
    }
    return [...byKey.values()]
  }

  private insert(entry: SlashEntry): void {
    this.sorted.splice(this.lowerBound(entry.seq), 0, entry)
    this.entries.set(entry.key, entry)
  }

  private remove(entry: SlashEntry): void {
    this.sorted.splice(this.sorted.indexOf(entry), 1)
    this.entries.delete(entry.key)
  }

  /** First index whose seq is at least `seq`. */
  private lowerBound(seq: number): number {
    let low = 0
    let high = this.sorted.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if ((this.sorted[middle]?.seq ?? Number.POSITIVE_INFINITY) < seq) low = middle + 1
      else high = middle
    }
    return low
  }

  /** Last index of the boundary-free run containing `index`. */
  private runEnd(index: number): number {
    let end = index
    while (end + 1 < this.sorted.length && this.sorted[end + 1]?.kind !== 'boundary') end++
    return end
  }

  /** First index of the boundary-free run containing `index`. */
  private runStart(index: number): number {
    let start = index
    while (start - 1 >= 0 && this.sorted[start - 1]?.kind !== 'boundary') start--
    return start
  }

  /** Record the names every message of the run `[start, end]` carries. */
  private assignRun(start: number, end: number, names: Map<string, readonly string[]>): void {
    const list: string[] = []
    for (let index = start; index <= end; index++) {
      const entry = this.sorted[index]
      if (entry?.kind === 'skill' && entry.name !== null && !list.includes(entry.name)) list.push(entry.name)
    }
    for (let index = start; index <= end; index++) {
      const entry = this.sorted[index]
      if (entry?.kind === 'message') names.set(entry.key, list)
    }
  }

  /**
   * Re-read the run(s) around one changed seq: the run holding a message or
   * skill entry, or — for a boundary, or a seq that left the index — the runs
   * on both sides of that position.
   */
  private collectAround(seq: number, names: Map<string, readonly string[]>): void {
    const at = this.lowerBound(seq)
    const here = this.sorted[at]
    if (here !== undefined && here.seq === seq && here.kind !== 'boundary') {
      this.assignRun(this.runStart(at), this.runEnd(at), names)
      return
    }
    if (at - 1 >= 0 && this.sorted[at - 1]?.kind !== 'boundary') {
      this.assignRun(this.runStart(at - 1), at - 1, names)
    }
    const right = here !== undefined && here.seq === seq ? at + 1 : at
    if (right < this.sorted.length && this.sorted[right]?.kind !== 'boundary') {
      this.assignRun(right, this.runEnd(right), names)
    }
  }
}

interface LegacyContribution {
  readonly anchorSeq: number
  readonly nodes: readonly ConversationNode[]
  readonly partial: PartialAssistant | null
  readonly running: RunningToolCall | null
}

const EMPTY_CONTRIBUTION: LegacyContribution = {
  anchorSeq: 0,
  nodes: EMPTY_LIST,
  partial: null,
  running: null,
}

function legacyContribution(raw: ChatConversationViewNode): LegacyContribution {
  const node = raw as ChatNode
  // Content-free settled Assistants remain in the finalized compatibility
  // stream so the session-stats pills preserve their pre-assembly step counts; hidden running
  // attempts have no final Node to contribute.
  if (raw.visibility !== 'visible' && node.kind !== 'assistant-step') return EMPTY_CONTRIBUTION
  switch (node.kind) {
    case 'user':
    case 'steering':
    case 'context':
    case 'turn-trigger':
    case 'command':
    case 'compaction':
    case 'turn-error':
    case 'turn-max-tokens':
    case 'unknown':
      return { anchorSeq: node.anchorSeq, nodes: [node.data], partial: null, running: null }
    case 'assistant-step': {
      const data = node.data
      if (data.status === 'running') {
        if (raw.visibility !== 'visible') return EMPTY_CONTRIBUTION
        return {
          anchorSeq: node.anchorSeq,
          nodes: EMPTY_LIST,
          partial: { turn: data.turn, step: data.step, blocks: data.blocks },
          running: null,
        }
      }
      return {
        anchorSeq: node.anchorSeq,
        nodes: data.finalNode === undefined ? EMPTY_LIST : [data.finalNode],
        partial: null,
        running: null,
      }
    }
    case 'tool-call': {
      const root = node.data.root
      return isRunningTool(root)
        ? { anchorSeq: node.anchorSeq, nodes: EMPTY_LIST, partial: null, running: root }
        : { anchorSeq: node.anchorSeq, nodes: [root], partial: null, running: null }
    }
    case 'manual-compaction': {
      const data = node.data
      return {
        anchorSeq: node.anchorSeq,
        nodes: data.compaction === null ? [data.command] : [data.command, data.compaction],
        partial: null,
        running: null,
      }
    }
    case 'model-retry':
      return {
        anchorSeq: node.anchorSeq,
        nodes: node.data.attempts,
        partial: null,
        running: null,
      }
    case 'turn-tail':
      return EMPTY_CONTRIBUTION
    default:
      return EMPTY_CONTRIBUTION
  }
}

function sameContribution(left: LegacyContribution | undefined, right: LegacyContribution): boolean {
  return left !== undefined
    && left.anchorSeq === right.anchorSeq
    && left.partial?.blocks === right.partial?.blocks
    && left.partial?.turn === right.partial?.turn
    && left.partial?.step === right.partial?.step
    && left.running === right.running
    && sameReferences(left.nodes, right.nodes)
}

/** Incremental compatibility projection for session-stats pills and legacy top-level snapshot fields. */
class LegacySliceBuilder {
  private readonly contributions = new Map<string, LegacyContribution>()
  private readonly finalizedContributions = new Map<string, LegacyContribution>()
  private readonly runningContributions = new Map<string, LegacyContribution>()
  private readonly partialContributions = new Map<string, LegacyContribution>()
  private finalized: readonly ConversationNode[] = EMPTY_LIST
  private runningCalls: readonly RunningToolCall[] = EMPTY_LIST
  private partial: PartialAssistant | null = null
  private timeline: ConversationTimelineSnapshot | undefined
  private turnTimings: LegacyConversationSlice['turnTimings'] = new Map()
  private turnEnds: LegacyConversationSlice['turnEnds'] = new Map()

  replace(
    nodes: readonly ChatConversationViewNode[],
    timeline: ConversationTimelineSnapshot,
  ): LegacyConversationSlice {
    this.contributions.clear()
    this.finalizedContributions.clear()
    this.runningContributions.clear()
    this.partialContributions.clear()
    for (const node of nodes) {
      const contribution = legacyContribution(node)
      this.contributions.set(node.key, contribution)
      this.indexContribution(node.key, contribution)
    }
    this.rebuildFinalized()
    this.rebuildRunning()
    this.rebuildPartial()
    this.updateTimeline(timeline)
    return this.snapshot()
  }

  apply(
    upserts: readonly ChatConversationViewNode[],
    timeline: ConversationTimelineSnapshot,
  ): LegacyConversationSlice {
    let finalizedChanged = false
    let runningChanged = false
    let partialChanged = false
    for (const node of upserts) {
      const contribution = legacyContribution(node)
      const previous = this.contributions.get(node.key)
      if (sameContribution(previous, contribution)) continue
      finalizedChanged ||= finalizedContributionChanged(previous, contribution)
      runningChanged ||= runningContributionChanged(previous, contribution)
      partialChanged ||= partialContributionChanged(previous, contribution)
      this.contributions.set(node.key, contribution)
      this.indexContribution(node.key, contribution)
    }
    if (finalizedChanged) this.rebuildFinalized()
    if (runningChanged) this.rebuildRunning()
    if (partialChanged) this.rebuildPartial()
    this.updateTimeline(timeline)
    return this.snapshot()
  }

  private indexContribution(key: string, contribution: LegacyContribution): void {
    updateContributionIndex(this.finalizedContributions, key, contribution, contribution.nodes.length > 0)
    updateContributionIndex(this.runningContributions, key, contribution, contribution.running !== null)
    updateContributionIndex(this.partialContributions, key, contribution, contribution.partial !== null)
  }

  private rebuildFinalized(): void {
    const finalized = [...this.finalizedContributions.values()]
      .flatMap(value => value.nodes)
      .sort((left, right) => left.seq - right.seq)
    if (!sameReferences(this.finalized, finalized)) this.finalized = finalized
  }

  private rebuildRunning(): void {
    const runningCalls = [...this.runningContributions.values()]
      .sort((left, right) => left.anchorSeq - right.anchorSeq)
      .flatMap(value => value.running === null ? [] : [value.running])
    if (!sameReferences(this.runningCalls, runningCalls)) this.runningCalls = runningCalls
  }

  private rebuildPartial(): void {
    const partial = [...this.partialContributions.values()]
      .sort((left, right) => left.anchorSeq - right.anchorSeq)
      .findLast(value => value.partial !== null)?.partial ?? null
    if (this.partial?.blocks !== partial?.blocks
      || this.partial?.turn !== partial?.turn
      || this.partial?.step !== partial?.step) this.partial = partial
  }

  private updateTimeline(timeline: ConversationTimelineSnapshot): void {
    if (this.timeline === timeline) return
    this.timeline = timeline
    const turnTimings = new Map<number, { startTime: number; endTime?: number }>()
    const turnEnds = new Map<number, number>()
    for (const turn of timeline.turns.values()) {
      if (turn.start !== undefined) {
        turnTimings.set(turn.turn, {
          startTime: turn.start.time,
          ...turn.end === undefined ? {} : { endTime: turn.end.time },
        })
      }
      if (turn.end !== undefined) turnEnds.set(turn.turn, turn.end.seq)
    }
    this.turnTimings = turnTimings
    this.turnEnds = turnEnds
  }

  private snapshot(): LegacyConversationSlice {
    return {
      nodes: this.finalized,
      turnTimings: this.turnTimings,
      turnEnds: this.turnEnds,
      partial: this.partial,
      runningCalls: this.runningCalls,
    }
  }
}

function updateContributionIndex(
  index: Map<string, LegacyContribution>,
  key: string,
  contribution: LegacyContribution,
  present: boolean,
): void {
  if (present) index.set(key, contribution)
  else index.delete(key)
}

function finalizedContributionChanged(
  previous: LegacyContribution | undefined,
  next: LegacyContribution,
): boolean {
  const previousNodes = previous?.nodes ?? EMPTY_LIST
  return !sameReferences(previousNodes, next.nodes)
    || ((previousNodes.length > 0 || next.nodes.length > 0) && previous?.anchorSeq !== next.anchorSeq)
}

function runningContributionChanged(
  previous: LegacyContribution | undefined,
  next: LegacyContribution,
): boolean {
  return previous?.running !== next.running
    || ((previous.running !== null || next.running !== null)
      && previous.anchorSeq !== next.anchorSeq)
}

function partialContributionChanged(
  previous: LegacyContribution | undefined,
  next: LegacyContribution,
): boolean {
  return previous?.partial?.blocks !== next.partial?.blocks
    || previous?.partial?.turn !== next.partial?.turn
    || previous?.partial?.step !== next.partial?.step
    || (((previous?.partial ?? null) !== null || next.partial !== null)
      && previous?.anchorSeq !== next.anchorSeq)
}

/** Incremental keyed Chat builder registered under the `chat` target. */
export class ChatSnapshotBuilder implements ConversationViewBuilder<ChatConversationViewNode, ChatSnapshot> {
  private readonly store = new MutableChatNodeStore()
  private readonly locations = new MutableChatLocationIndex()
  private readonly navigation = new MutableChatTurnNavigationIndex()
  private readonly legacy = new LegacySliceBuilder()
  private readonly referenceLabels = new ReferenceLabelProjector()
  private readonly skillNames = new SkillNameProjector()
  private readonly flow = new ProcessFlowProjector()
  private order: readonly string[] = EMPTY_KEYS
  readonly empty: ChatSnapshot

  constructor() {
    this.empty = this.snapshot({ turnOrder: EMPTY_TURNS, turns: new Map() })
  }

  replace(input: {
    readonly nodes: readonly ChatConversationViewNode[]
    readonly timeline: ConversationTimelineSnapshot
  }): ChatSnapshot {
    const nodes = this.skillNames.replace(this.referenceLabels.replace(input.nodes))
    this.store.replace(nodes)
    this.order = orderedVisibleChatNodes(nodes).map(node => node.key)
    this.locations.rebuild(this.order, this.store)
    this.navigation.rebuild(input.timeline, this.locations, this.store)
    this.flow.replace(this.order, this.locations, this.store, input.timeline)
    return this.snapshot(input.timeline, this.legacy.replace(nodes, input.timeline))
  }

  apply(input: {
    readonly upserts: readonly ChatConversationViewNode[]
    readonly timeline: ConversationTimelineSnapshot
  }): ChatSnapshot {
    const upserts = this.skillNames.apply(this.referenceLabels.apply(input.upserts, this.store), this.store)
    let structural = false
    const contentOnly: ChatConversationViewNode[] = []
    const changes: { readonly previous: ChatConversationViewNode | undefined; readonly current: ChatConversationViewNode }[] = []
    for (const node of upserts) {
      const previous = this.store.get(node.key)
      changes.push({ previous, current: node })
      const nodeStructural = previous === undefined
        || previous.anchorSeq !== node.anchorSeq
        || previous.visibility !== node.visibility
        || locationIdentity(previous.location) !== locationIdentity(node.location)
      structural ||= nodeStructural
      if (!nodeStructural) contentOnly.push(node)
    }
    this.store.upsert(upserts)
    let orderChanged = false
    if (structural) {
      const next = orderedVisibleChatNodes(this.store.values()).map(node => node.key)
      orderChanged = !sameReferences(this.order, next)
      this.order = orderChanged ? next : this.order
      this.locations.rebuild(this.order, this.store)
    }
    this.locations.touch(contentOnly)
    this.navigation.rebuild(input.timeline, this.locations, this.store)
    this.flow.apply(changes, this.order, orderChanged, this.locations, this.store, input.timeline)
    return this.snapshot(input.timeline, this.legacy.apply(upserts, input.timeline))
  }

  private snapshot(
    timeline: ConversationTimelineSnapshot,
    legacy = this.legacy.replace(EMPTY_LIST, timeline),
  ): ChatSnapshot {
    return {
      order: this.order,
      nodes: this.store,
      locations: this.locations,
      entries: this.flow.flowEntries,
      groups: this.flow.groupStore,
      navigation: this.navigation,
      timeline,
      legacy,
    }
  }
}

function locationIdentity(location: ConversationLocation): string {
  const coordinates = locationCoordinates(location)
  return `${location.kind}:${coordinates.turn ?? ''}:${coordinates.step ?? ''}`
}

/** Chat target factory contributed to the Runtime view registry. */
export const chatViewDefinition: ConversationViewDefinition<ChatConversationViewNode, ChatSnapshot> = {
  target: 'chat',
  create: () => new ChatSnapshotBuilder(),
}

/**
 * Register the incremental Chat target builder.
 * @param ctx - owning UI Conversation context.
 */
export function registerChatConversationView(ctx: Context): void {
  ctx.conversationViews.register(chatViewDefinition)
}
