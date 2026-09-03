import type { Context } from '@deepseek-ai/cordis'
import type {
  AssistantMessageNode, ConversationNode, ConversationPromptSnapshot,
  ConversationViewBuilder, ConversationViewDefinition, RequestView,
  ToolCallBlock,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  TrajectoryConversationViewNode, TrajectoryRequestHeaderState,
  TrajectorySnapshot,
} from './trajectory-contract.ts'

const EMPTY_LIST: readonly never[] = []
type AssistantRequest = Extract<RequestView, { purpose: 'assistant' }>
type ToolSchema = ConversationPromptSnapshot['tools'][number]

/** Stable empty target used until a Session has assembled Trajectory records. */
export const EMPTY_TRAJECTORY_SNAPSHOT: TrajectorySnapshot = {
  eventNodes: EMPTY_LIST,
  eventLocations: new Map(),
  requests: EMPTY_LIST,
  callSchemas: new Map(),
  partial: null,
  runningCalls: EMPTY_LIST,
}

function stepKey(turn: number, step: number): string {
  return `${turn}\u0000${step}`
}

function headerStepKey(header: TrajectoryRequestHeaderState): string | undefined {
  const location = header.location
  return location.kind === 'step'
    ? stepKey(location.turn.turn, location.step.step)
    : undefined
}

function headerFor(
  request: AssistantRequest,
  headersByStep: ReadonlyMap<string, TrajectoryRequestHeaderState>,
  previous: TrajectoryRequestHeaderState | undefined,
): TrajectoryRequestHeaderState | undefined {
  return headersByStep.get(stepKey(request.turn, request.step))
    ?? (previous !== undefined && previous.seq < request.startSeq ? previous : undefined)
}

function applyHeader(
  request: AssistantRequest,
  header: TrajectoryRequestHeaderState | undefined,
  includeChange: boolean,
): AssistantRequest {
  return header === undefined
    ? request
    : {
      ...request,
      prompt: header.prompt,
      requestConfig: header.prompt.config,
      ...(includeChange && header.change !== undefined ? { promptChange: header.change } : {}),
    }
}

function withRequestConfig(
  node: AssistantMessageNode,
  prompt: ConversationPromptSnapshot | undefined,
): AssistantMessageNode {
  return prompt === undefined ? node : { ...node, requestConfig: prompt.config }
}

function captureSchemas(
  block: ToolCallBlock,
  toolsByName: ReadonlyMap<string, ToolSchema>,
  output: Map<string, ToolSchema>,
): void {
  const name = 'kind' in block ? block.call?.name : block.name
  const schema = name === undefined ? undefined : toolsByName.get(name)
  if (schema !== undefined) output.set(block.callId, schema)
  for (const child of block.subCalls) captureSchemas(child, toolsByName, output)
}

function indexTools(tools: readonly ToolSchema[]): ReadonlyMap<string, ToolSchema> {
  return new Map(tools.map(tool => [tool.name, tool]))
}

function interruptCompactions(
  requests: RequestView[],
  boundaries: readonly { seq: number; time: number }[],
): void {
  let nextRequest = 0
  const runningCompactions: number[] = []
  for (const boundary of boundaries) {
    while (nextRequest < requests.length) {
      const request = requests[nextRequest]
      if (request === undefined || request.startSeq >= boundary.seq) break
      if (request.purpose === 'compaction' && request.status === 'running') {
        runningCompactions.push(nextRequest)
      }
      nextRequest++
    }
    let index = runningCompactions.pop()
    while (index !== undefined && requests[index]?.status !== 'running') {
      index = runningCompactions.pop()
    }
    if (index === undefined) continue
    const request = requests[index]
    if (request?.purpose !== 'compaction') continue
    requests[index] = {
      ...request,
      completedAt: boundary.time,
      status: 'error',
      error: 'Compaction was interrupted before completion.',
    }
  }
}

function applyTurnErrors(
  requests: RequestView[],
  endings: readonly { turn: number; time: number; error?: string }[],
): void {
  const lastAssistantByTurn = new Map<number, number>()
  for (const [index, request] of requests.entries()) {
    if (request.purpose === 'assistant') lastAssistantByTurn.set(request.turn, index)
  }
  for (const ending of endings) {
    if (ending.error === undefined) continue
    const index = lastAssistantByTurn.get(ending.turn)
    if (index === undefined) continue
    const request = requests[index]
    if (request?.purpose !== 'assistant') continue
    requests[index] = {
      ...request,
      completedAt: request.completedAt ?? ending.time,
      status: 'error',
      error: ending.error,
    }
  }
}

function sameReferences<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function shallowEqual(left: object, right: object): boolean {
  if (left === right) return true
  const before = left as Record<string, unknown>
  const after = right as Record<string, unknown>
  const keys = Object.keys(before)
  return keys.length === Object.keys(after).length
    && keys.every(key => Object.hasOwn(after, key) && before[key] === after[key])
}

function sameMapEntries<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) return false
  for (const [key, value] of left) {
    if (!right.has(key) || right.get(key) !== value) return false
  }
  return true
}

/**
 * Keep the previous element for every rebuilt row whose content did not change,
 * then the previous array when no row changed. Rows are matched by a durable
 * ordering key because a structural rebuild may insert rows anywhere.
 */
function reuseRows<T extends object>(
  previous: readonly T[],
  next: T[],
  keyOf: (value: T) => number,
): readonly T[] {
  if (previous.length === 0) return next
  const byKey = new Map<number, T>()
  for (const value of previous) byKey.set(keyOf(value), value)
  for (const [index, value] of next.entries()) {
    const before = byKey.get(keyOf(value))
    if (before !== undefined && shallowEqual(before, value)) next[index] = before
  }
  return sameReferences(previous, next) ? previous : next
}

/**
 * Whether an upsert replaced only the streaming partial of an Assistant
 * contribution: same settled node, same request facts, only `partial` moved.
 * Every other change (a node settling, a request status or usage edge, a tool
 * lifecycle step) needs the request/finalized ledger rebuilt.
 */
function partialOnlyChange(
  previous: TrajectoryConversationViewNode,
  next: TrajectoryConversationViewNode,
): boolean {
  const before = previous.data
  const after = next.data
  return before.kind === 'assistant' && after.kind === 'assistant'
    && before.node === after.node
    && (before.request === after.request
      || (before.request !== undefined && after.request !== undefined && shallowEqual(before.request, after.request)))
}

/**
 * Keyed adapter retaining the old Trajectory snapshot and stage layout. A
 * publication that only moved an Assistant's streaming partial swaps that one
 * field; every other publication rebuilds the ledger but publishes new
 * identities only for the rows and fields whose content changed, so the view's
 * layout memos stay valid across a stream.
 */
export class TrajectorySnapshotBuilder implements ConversationViewBuilder<
  TrajectoryConversationViewNode,
  TrajectorySnapshot
> {
  private readonly nodes = new Map<string, TrajectoryConversationViewNode>()
  private readonly positions = new Map<string, number>()
  private contributions: TrajectoryConversationViewNode[] = []
  private current: TrajectorySnapshot = EMPTY_TRAJECTORY_SNAPSHOT
  readonly empty = EMPTY_TRAJECTORY_SNAPSHOT

  replace(input: {
    readonly nodes: readonly TrajectoryConversationViewNode[]
  }): TrajectorySnapshot {
    this.nodes.clear()
    for (const node of input.nodes) this.nodes.set(node.key, node)
    this.rebuildContributions()
    this.current = this.rebuild()
    return this.current
  }

  apply(input: {
    readonly upserts: readonly TrajectoryConversationViewNode[]
  }): TrajectorySnapshot {
    let structural = false
    let partialOnly = true
    for (const node of input.upserts) {
      const previous = this.nodes.get(node.key)
      if (previous === node) continue
      this.nodes.set(node.key, node)
      if (previous === undefined || previous.anchorSeq !== node.anchorSeq) {
        structural = true
        partialOnly = false
        continue
      }
      const position = this.positions.get(node.key)
      if (position === undefined) {
        structural = true
        partialOnly = false
      } else {
        this.contributions[position] = node
      }
      if (partialOnly && !partialOnlyChange(previous, node)) partialOnly = false
    }
    if (structural) this.rebuildContributions()
    if (partialOnly) {
      const partial = this.latestPartial()
      if (partial !== this.current.partial) this.current = { ...this.current, partial }
      return this.current
    }
    this.current = this.rebuild()
    return this.current
  }

  /** The streaming partial of the latest contribution that carries one. */
  private latestPartial(): TrajectorySnapshot['partial'] {
    for (let index = this.contributions.length - 1; index >= 0; index--) {
      const data = this.contributions[index]?.data
      if (data?.kind === 'assistant' && data.partial !== null) return data.partial
    }
    return null
  }

  private rebuild(): TrajectorySnapshot {
    const headersByStep = new Map<string, TrajectoryRequestHeaderState>()
    for (const contribution of this.contributions) {
      if (contribution.data.kind !== 'request-header') continue
      const key = headerStepKey(contribution.data.header)
      if (key !== undefined) headersByStep.set(key, contribution.data.header)
    }
    const finalized: ConversationNode[] = []
    const eventLocations = new Map<number, TrajectoryConversationViewNode['location']>()
    const requests: RequestView[] = []
    const boundaries: { seq: number; time: number }[] = []
    const turnEndings: { turn: number; time: number; error?: string }[] = []
    const callSchemas = new Map<string, ToolSchema>()
    const consumedPromptChanges = new Set<number>()
    let previousHeader: TrajectoryRequestHeaderState | undefined
    let previousTools: ReadonlyMap<string, ToolSchema> = new Map()
    let partial: TrajectorySnapshot['partial'] = null
    const runningCalls: TrajectorySnapshot['runningCalls'][number][] = []

    for (const contribution of this.contributions) {
      const data = contribution.data
      if (data.kind === 'request-header') {
        previousHeader = data.header
        previousTools = indexTools(data.header.prompt.tools)
        continue
      }
      if (data.kind === 'node') {
        finalized.push(data.node)
        eventLocations.set(data.node.seq, contribution.location)
        continue
      }
      if (data.kind === 'assistant') {
        const header = data.request === undefined
          ? undefined
          : headerFor(data.request, headersByStep, previousHeader)
        if (data.node !== undefined) finalized.push(withRequestConfig(data.node, header?.prompt))
        if (data.partial !== null) partial = data.partial
        if (data.request !== undefined) {
          const includeChange = header?.change !== undefined
            && !consumedPromptChanges.has(header.seq)
          requests.push(applyHeader(data.request, header, includeChange))
          if (includeChange) consumedPromptChanges.add(header.seq)
        }
        continue
      }
      if (data.kind === 'tool') {
        if ('kind' in data.root) finalized.push(data.root)
        else runningCalls.push(data.root)
        if (previousHeader !== undefined && previousHeader.seq < contribution.anchorSeq) {
          captureSchemas(data.root, previousTools, callSchemas)
        }
        continue
      }
      if (data.kind === 'compaction') {
        requests.push(data.request)
        continue
      }
      if (data.kind === 'session-end') {
        boundaries.push({ seq: data.seq, time: data.time })
        continue
      }
      turnEndings.push({
        turn: data.turn,
        time: data.time,
        ...(data.error === undefined ? {} : { error: data.error }),
      })
    }

    requests.sort((left, right) => left.startSeq - right.startSeq)
    interruptCompactions(requests, boundaries)
    applyTurnErrors(requests, turnEndings)
    finalized.sort((left, right) => left.seq - right.seq)
    const previous = this.current
    return {
      eventNodes: reuseRows(previous.eventNodes, finalized, node => node.seq),
      eventLocations: sameMapEntries(previous.eventLocations, eventLocations) ? previous.eventLocations : eventLocations,
      requests: reuseRows(previous.requests, requests, request => request.startSeq),
      callSchemas: sameMapEntries(previous.callSchemas, callSchemas) ? previous.callSchemas : callSchemas,
      partial,
      runningCalls: sameReferences(previous.runningCalls, runningCalls) ? previous.runningCalls : runningCalls,
    }
  }

  private rebuildContributions(): void {
    this.contributions = [...this.nodes.values()]
      .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
    this.positions.clear()
    for (const [index, contribution] of this.contributions.entries()) {
      this.positions.set(contribution.key, index)
    }
  }
}

/** Trajectory target factory preserving the existing stage-oriented view model. */
export const trajectoryViewDefinition: ConversationViewDefinition<
  TrajectoryConversationViewNode,
  TrajectorySnapshot
> = {
  target: 'trajectory',
  create: () => new TrajectorySnapshotBuilder(),
}

/**
 * Register the stage-oriented Trajectory target builder.
 *
 * @param ctx - Plugin context receiving the view Definition.
 */
export function registerTrajectoryConversationView(ctx: Context): void {
  ctx.conversationViews.register(trajectoryViewDefinition)
}
