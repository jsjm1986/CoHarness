import type {
  AssistantMessageNode, ChatConversationViewNode, ChatSnapshot, ConversationNode,
  ChatLocationNodeIndex, ChatNodeStore, CompactionSummaryNode, ConversationLocationDataSource,
  ConversationLocationDataStore, ConversationTurnDataMap, LegacyConversationSlice, PartialAssistant,
  RunningToolCall, ToolCallBlock, TurnLocation,
} from '@deepseek-ai/dsh-client-runtime/client'
import { hasAssistantReplyContent } from '../src/client/contract/assistant-content.ts'
import type { AssistantChatData, FinalAssistantChatData } from '../src/client/contract/chat-nodes.ts'
import { isAtOrOutside } from '../src/client/contract/group-tree.ts'
import {
  isSubagentDelegationTool, sameTurnProcessSpec, type TurnProcessSpec,
} from '../src/client/contract/turn-process.ts'
import { deriveTurnMetrics } from '../src/client/chat/turn-metrics.ts'
import { orderedVisibleChatNodes, ProcessFlowProjector } from '../src/client/conversation-nodes/process-groups.ts'

const EMPTY: readonly never[] = []

function sameValues<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function nodeSource(node: ChatConversationViewNode): unknown {
  if (node.kind === 'assistant-step') {
    const data = node.data as ReturnType<typeof assistantData>
    return data.finalNode ?? data.blocks
  }
  if (node.kind === 'tool-call') return (node.data as { readonly root: ToolCallBlock }).root
  if (node.kind === 'model-retry') return (node.data as { readonly current: unknown }).current
  if (node.kind === 'turn-tail') return (node.data as { readonly seq: number }).seq
  return node.data
}

class FixtureNodeStore implements ChatNodeStore {
  /** Incremental flow projection shared by successive fixture publications. */
  readonly flow = new ProcessFlowProjector()
  private byKey = new Map<string, ChatConversationViewNode>()
  private list: readonly ChatConversationViewNode[] = EMPTY

  get(key: string): ChatConversationViewNode | undefined {
    return this.byKey.get(key)
  }

  values(): readonly ChatConversationViewNode[] {
    return this.list
  }

  /** @returns the upserted (identity-changed or added) Nodes plus their previous versions. */
  replace(candidates: readonly ChatConversationViewNode[]): {
    readonly previous: ChatConversationViewNode | undefined
    readonly current: ChatConversationViewNode
  }[] {
    const changes: { previous: ChatConversationViewNode | undefined; current: ChatConversationViewNode }[] = []
    const next = new Map<string, ChatConversationViewNode>()
    const list = candidates.map((candidate) => {
      const previous = this.byKey.get(candidate.key)
      const node = previous !== undefined
        && previous.kind === candidate.kind
        && previous.anchorSeq === candidate.anchorSeq
        && previous.visibility === candidate.visibility
        && nodeSource(previous) === nodeSource(candidate)
        ? previous
        : candidate
      if (previous !== node) changes.push({ previous, current: node })
      next.set(node.key, node)
      return node
    })
    this.byKey = next
    this.list = sameValues(this.list, list) ? this.list : list
    return changes
  }
}

class FixtureLocationIndex implements ChatLocationNodeIndex {
  private turns = new Map<number, readonly string[]>()

  getTurn(turn: number): readonly string[] {
    return this.turns.get(turn) ?? EMPTY
  }

  getStep(): readonly string[] {
    return EMPTY
  }

  replace(next: ReadonlyMap<number, readonly string[]>): void {
    const stable = new Map<number, readonly string[]>()
    for (const [turn, keys] of next) {
      const previous = this.turns.get(turn) ?? EMPTY
      stable.set(turn, sameValues(previous, keys) ? previous : keys)
    }
    this.turns = stable
  }
}

class FixtureTurnDataStore implements ConversationLocationDataStore<ConversationTurnDataMap> {
  private readonly values = new Map<string, unknown>()
  private readonly sources = new Map<string, ConversationLocationDataSource<unknown>>()

  get<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
  ): Readonly<ConversationTurnDataMap[Key]> | undefined {
    return this.values.get(key) as Readonly<ConversationTurnDataMap[Key]> | undefined
  }

  source<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
  ): ConversationLocationDataSource<Readonly<ConversationTurnDataMap[Key]> | undefined> {
    let source = this.sources.get(key)
    if (source === undefined) {
      source = { getSnapshot: () => this.get(key), subscribe: () => () => {} }
      this.sources.set(key, source)
    }
    return source as ConversationLocationDataSource<Readonly<ConversationTurnDataMap[Key]> | undefined>
  }

  set<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
    value: ConversationTurnDataMap[Key],
  ): void {
    this.values.set(key, value)
  }
}

function assistantData(node: AssistantMessageNode) {
  return {
    status: node.interrupted === true ? 'interrupted' as const : 'settled' as const,
    turn: node.turn,
    step: node.step,
    blocks: node.blocks,
    time: node.time,
    finalNode: node,
  }
}

function settledNode(
  node: ConversationNode,
  turns: ReadonlyMap<number, TurnLocation>,
  triggerSeqs: ReadonlySet<number>,
  inferredTurn?: number,
): ChatConversationViewNode {
  const ownTurn = 'turn' in node && typeof node.turn === 'number' ? node.turn : inferredTurn
  const turn = ownTurn === undefined ? undefined : turns.get(ownTurn)
  const base = {
    key: `fixture:${node.kind}:${node.seq}`,
    id: String(node.seq),
    target: 'chat' as const,
    anchorSeq: node.seq,
    location: turn === undefined
      ? { kind: 'session' as const }
      : { kind: 'turn' as const, turn },
    visibility: 'visible' as const,
  }
  switch (node.kind) {
    case 'assistant':
      return { ...base, kind: 'assistant-step', data: assistantData(node) }
    case 'tool-result':
      return { ...base, key: `fixture:tool:${node.callId}`, kind: 'tool-call', data: { root: node } }
    case 'model-retry':
      return { ...base, key: 'fixture:model-retry', kind: 'model-retry', data: { attempts: [node], current: node } }
    default:
      return triggerSeqs.has(node.seq) && node.kind === 'context'
        ? { ...base, kind: 'turn-trigger', data: { ...node, waking: true } }
        : { ...base, kind: node.kind, data: node }
  }
}

/** Build the canonical Chat fixture corresponding to one legacy test slice. */
export function chatSnapshotFixture(input: {
  readonly nodes?: readonly ConversationNode[]
  readonly partial?: PartialAssistant | null
  readonly runningCalls?: readonly RunningToolCall[]
  readonly turnTimings?: LegacyConversationSlice['turnTimings']
  readonly turnEnds?: LegacyConversationSlice['turnEnds']
  /** Durable turn/end reason per turn; defaults to 'completed' for every ended turn. */
  readonly turnEndReasons?: ReadonlyMap<number, 'completed' | 'aborted' | 'interrupted' | 'error'>
  /** Durable turn/start seq per turn; forces a start event even without timings. */
  readonly turnStarts?: ReadonlyMap<number, number>
  /** Context-node seqs presented as Turn-opening `turn-trigger` rows. */
  readonly turnTriggerSeqs?: readonly number[]
} = {}, previous?: ChatSnapshot): ChatSnapshot {
  const legacy: LegacyConversationSlice = {
    nodes: input.nodes ?? EMPTY,
    partial: input.partial ?? null,
    runningCalls: input.runningCalls ?? EMPTY,
    turnTimings: input.turnTimings ?? new Map(),
    turnEnds: input.turnEnds ?? new Map(),
  }
  const turnNumbers = new Set([...legacy.turnTimings.keys(), ...legacy.turnEnds.keys()])
  for (const node of legacy.nodes) {
    if ('turn' in node && typeof node.turn === 'number') turnNumbers.add(node.turn)
  }
  if (legacy.partial !== null) turnNumbers.add(legacy.partial.turn)
  for (const call of legacy.runningCalls) turnNumbers.add(call.turn)
  for (const turn of input.turnStarts?.keys() ?? []) turnNumbers.add(turn)
  // A settling Tool call inherits the Turn its running call occupied: production
  // projects the tool-result inside the executing Turn, so the keyed Node keeps
  // that location instead of falling back to session scope.
  const inheritedTurns = new Map<string, number>()
  for (const node of legacy.nodes) {
    if (node.kind !== 'tool-result' || 'turn' in node) continue
    const prior = previous?.nodes.get(`fixture:tool:${node.callId}`)?.location
    if (prior?.kind === 'turn' || prior?.kind === 'step') {
      inheritedTurns.set(`fixture:tool:${node.callId}`, prior.turn.turn)
      turnNumbers.add(prior.turn.turn)
    }
  }
  const turns = new Map<number, TurnLocation>()
  const turnData = new Map<number, FixtureTurnDataStore>()
  for (const turn of [...turnNumbers].sort((left, right) => left - right)) {
    const timing = legacy.turnTimings.get(turn)
    const startSeq = input.turnStarts?.get(turn)
    const endSeq = legacy.turnEnds.get(turn)
    const previousData = previous?.timeline.turns.get(turn)?.data
    const data = previousData instanceof FixtureTurnDataStore ? previousData : new FixtureTurnDataStore()
    turnData.set(turn, data)
    turns.set(turn, {
      turn,
      start: timing === undefined && startSeq === undefined ? undefined : {
        type: 'turn/start',
        seq: startSeq ?? Math.max(0, (endSeq ?? 1) - 1),
        time: timing?.startTime ?? 0,
        data: { turn },
      } as never,
      end: endSeq === undefined ? undefined : {
        type: 'turn/end',
        seq: endSeq,
        time: timing?.endTime ?? endSeq,
        data: { turn, reason: { kind: input.turnEndReasons?.get(turn) ?? 'completed' } },
      } as never,
      status: endSeq === undefined ? 'open' : 'closed',
      steps: EMPTY,
      data,
    })
  }
  const linkedCompactions = new Set<CompactionSummaryNode>()
  const triggerSeqs = new Set(input.turnTriggerSeqs ?? EMPTY)
  const nodes = legacy.nodes.flatMap((node, index): ChatConversationViewNode[] => {
    if (node.kind === 'command' && node.name === 'compact') {
      const sourceSeq = node.outcome?.kind === 'success' ? node.outcome.sourceEventSeq : undefined
      const candidates = sourceSeq === undefined
        ? []
        : legacy.nodes.filter((candidate): candidate is CompactionSummaryNode =>
          candidate.kind === 'compaction' && candidate.summaryEventSeq === sourceSeq)
      const compaction = candidates.length === 1 ? candidates[0] : undefined
      if (node.outcome === null || compaction !== undefined) {
        if (compaction !== undefined) linkedCompactions.add(compaction)
        const base = settledNode(node, turns, triggerSeqs)
        return [{
          ...base,
          key: `fixture:manual-compaction:${node.commandId}`,
          kind: 'manual-compaction',
          anchorSeq: compaction?.seq ?? node.seq,
          data: { command: node, compaction: compaction ?? null },
        }]
      }
    }
    if (node.kind === 'compaction' && linkedCompactions.has(node)) return []
    const inferredTurn = node.kind === 'tool-result'
      ? legacy.nodes.slice(0, index).findLast(
        (candidate): candidate is AssistantMessageNode => candidate.kind === 'assistant',
      )?.turn ?? inheritedTurns.get(`fixture:tool:${node.callId}`)
      : undefined
    return [settledNode(node, turns, triggerSeqs, inferredTurn)]
  })
  if (legacy.partial !== null) {
    const turn = turns.get(legacy.partial.turn)
    nodes.push({
      key: `fixture:assistant:${legacy.partial.turn}:${legacy.partial.step}`,
      id: `${legacy.partial.turn}:${legacy.partial.step}`,
      target: 'chat',
      kind: 'assistant-step',
      anchorSeq: Number.MAX_SAFE_INTEGER - 1,
      location: turn === undefined ? { kind: 'session' } : { kind: 'turn', turn },
      visibility: 'visible',
      data: {
        status: 'running',
        turn: legacy.partial.turn,
        step: legacy.partial.step,
        blocks: legacy.partial.blocks,
        time: 0,
      },
    })
  }
  for (const call of legacy.runningCalls) {
    const turn = turns.get(call.turn)
    nodes.push({
      key: `fixture:tool:${call.callId}`,
      id: call.callId,
      target: 'chat',
      kind: 'tool-call',
      anchorSeq: Number.MAX_SAFE_INTEGER,
      location: turn === undefined ? { kind: 'session' } : { kind: 'turn', turn },
      visibility: 'visible',
      data: { root: call },
    })
  }
  for (const [turnNumber, dataStore] of turnData) {
    const turn = turns.get(turnNumber)
    if (turn === undefined) continue
    const inTurn = nodes.filter((candidate) => {
      const location = candidate.location
      return (location.kind === 'turn' || location.kind === 'step') && location.turn.turn === turnNumber
    })
    const assistants = inTurn
      .filter(candidate => candidate.kind === 'assistant-step')
      .map(candidate => candidate.data as AssistantChatData)
    const toolCalls = inTurn
      .filter(candidate => candidate.kind === 'tool-call')
      .map(candidate => (candidate.data as { readonly root: ToolCallBlock }).root)
    const latestStep = Math.max(
      0,
      ...assistants.map(candidate => candidate.step),
      ...inTurn.flatMap((candidate) => {
        if (candidate.kind !== 'tool-call') return []
        const root = (candidate.data as { root: ToolCallBlock }).root as ToolCallBlock & { step?: unknown }
        const step: unknown = root.step
        return typeof step === 'number' ? [step] : []
      }),
    )
    const answer = assistants.findLast((candidate): candidate is FinalAssistantChatData =>
      candidate.step === latestStep
      && candidate.finalNode !== undefined
      && hasAssistantReplyContent(candidate.blocks)
      && !candidate.blocks.some(block => block.kind === 'tool-call'))
    const controlAnchor = inTurn.find(candidate => candidate.kind === 'assistant-step'
      || candidate.kind === 'tool-call'
      || candidate.kind === 'model-retry')
    const controlAnchorSeq = controlAnchor?.anchorSeq ?? turn.start?.seq
    if (controlAnchorSeq === undefined) continue
    const processStart = inTurn.find(candidate => !isAtOrOutside(candidate, 'turn'))
    const spec: TurnProcessSpec = {
      turn: turnNumber,
      controlAnchorSeq,
      processStartSeq: processStart?.anchorSeq ?? controlAnchorSeq,
      answerAnchorSeq: answer?.finalNode.seq ?? null,
      answerStep: answer?.step ?? null,
      inlineReasoning: answer !== undefined
        && answer.blocks.some(block => block.kind === 'reasoning' && block.text.trim() !== ''),
      messageCount: answer === undefined
        ? assistants.filter(candidate => hasAssistantReplyContent(candidate.blocks)).length
        : assistants.filter(candidate => candidate.step < answer.step
          && hasAssistantReplyContent(candidate.blocks)).length,
      toolCallCount: toolCalls.filter((call) => {
        const name = 'kind' in call ? call.call?.name ?? null : call.name
        return name === null || !isSubagentDelegationTool(name)
      }).length,
      subagentCount: toolCalls.filter((call) => {
        const name = 'kind' in call ? call.call?.name ?? null : call.name
        return name !== null && isSubagentDelegationTool(name)
      }).length,
    }
    const previousSpec = dataStore.get('turn-process')
    const stable = previousSpec !== undefined && sameTurnProcessSpec(previousSpec, spec)
      ? previousSpec
      : spec
    dataStore.set('turn-process', stable)
    nodes.push({
      key: `fixture:turn-process:${turnNumber}`,
      id: String(turnNumber),
      target: 'chat',
      kind: 'turn-process',
      anchorSeq: stable.controlAnchorSeq - 0.1,
      location: { kind: 'turn', turn },
      visibility: 'visible',
      data: stable,
    })
  }
  nodes.sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
  for (const [turnNumber, endSeq] of legacy.turnEnds) {
    const turn = turns.get(turnNumber)
    const dataStore = turnData.get(turnNumber)
    if (turn === undefined || dataStore === undefined) continue
    const closing = legacy.nodes
      .filter((candidate): candidate is AssistantMessageNode => candidate.kind === 'assistant'
        && candidate.turn === turnNumber
        && candidate.blocks.some(block => block.kind === 'text' && block.text.trim() !== ''))
      .map(assistantData)
      .at(-1) ?? null
    const preceding = nodes.findLast((candidate) => {
      const location = candidate.location
      return (location.kind === 'turn' || location.kind === 'step')
        && location.turn.turn === turnNumber
    })
    const metrics = deriveTurnMetrics(legacy.nodes).get(turnNumber)
    const tailData = {
      turn: turnNumber,
      seq: endSeq,
      time: turn.end?.time ?? 0,
      closing,
      branchUnavailable: closing === null
        || preceding?.kind !== 'assistant-step'
        || (preceding.data as ReturnType<typeof assistantData>).finalNode.seq !== closing.finalNode.seq,
      ...metrics?.ttftMs === undefined ? {} : { ttftMs: metrics.ttftMs },
      ...metrics?.tokensPerSecond === undefined ? {} : { tokensPerSecond: metrics.tokensPerSecond },
    }
    dataStore.set('turn-tail', tailData)
    nodes.push({
      key: `fixture:turn-tail:${turnNumber}`,
      id: String(turnNumber),
      target: 'chat',
      kind: 'turn-tail',
      anchorSeq: endSeq,
      location: { kind: 'turn', turn },
      visibility: 'visible',
      data: tailData,
    })
  }
  nodes.sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
  const store = previous?.nodes instanceof FixtureNodeStore ? previous.nodes : new FixtureNodeStore()
  const previousOrder = previous?.order
  const changes = store.replace(nodes)
  const byKey = new Map(store.values().map(node => [node.key, node]))
  const nextOrder = orderedVisibleChatNodes(store.values()).map(node => node.key)
  const order = previous !== undefined && sameValues(previous.order, nextOrder) ? previous.order : nextOrder
  const byTurn = new Map<number, readonly string[]>()
  for (const turn of turns.keys()) {
    byTurn.set(turn, order.filter((key) => {
      const location = byKey.get(key)?.location
      return location?.kind === 'turn' && location.turn.turn === turn
        || location?.kind === 'step' && location.turn.turn === turn
    }))
  }
  const locations = previous?.locations instanceof FixtureLocationIndex
    ? previous.locations
    : new FixtureLocationIndex()
  locations.replace(byTurn)
  const timeline = previous !== undefined
    && previous.legacy.turnTimings === legacy.turnTimings
    && previous.legacy.turnEnds === legacy.turnEnds
    ? previous.timeline
    : { turnOrder: [...turns.keys()], turns }
  if (previousOrder === undefined) {
    store.flow.replace(order, locations, store, timeline)
  } else {
    store.flow.apply(changes, order, previousOrder !== order, locations, store, timeline)
  }
  return {
    order,
    nodes: store,
    locations,
    entries: store.flow.flowEntries,
    groups: store.flow.groupStore,
    navigation: { items: () => EMPTY },
    timeline,
    legacy,
  }
}
