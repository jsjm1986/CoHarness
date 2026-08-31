import type { Context } from '@deepseek-ai/cordis'
import type {
  AssistantBlock, AssistantMessageNode, ConversationLocation, ConversationMatch,
  ConversationNodeContext, ConversationNodeDefinition, PartialAssistant, RequestView,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  displayFailureMessage, IncrementalAssistantBlocks, isTokenDelta, sanitizeAssistantText, toAssistantBlocks,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'
import { trajectoryNode } from './trajectory-definition-common.ts'

/* jscpd:ignore-start -- Target-owned Definitions intentionally keep their event
 * state machines independent; see ../../../../../.agents/notes/implemented/
 * architecture/2026-08-09-client-conversation-node-assembly.md. */
interface UsageValue {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

interface RetryValue {
  readonly message: string
  readonly retry: number
  readonly maxRetries?: number
  readonly delayMs: number
}

interface AssistantState {
  readonly turn: number
  readonly step: number
  readonly startSeq: number
  readonly startTime: number
  readonly started: boolean
  readonly sawChunk: boolean
  readonly blocks: IncrementalAssistantBlocks
  readonly firstVisibleSeq: number | undefined
  readonly firstVisibleTime: number | undefined
  readonly firstTokenTime: number | undefined
  readonly final: ConversationMatch | undefined
  readonly usage: UsageValue | undefined
  readonly retry: RetryValue | undefined
  readonly stepEnd: ConversationMatch | undefined
}

function initialState(
  turn: number,
  step: number,
  startSeq: number,
  startTime: number,
  started: boolean,
): AssistantState {
  return {
    turn,
    step,
    startSeq,
    startTime,
    started,
    sawChunk: false,
    blocks: new IncrementalAssistantBlocks(),
    firstVisibleSeq: undefined,
    firstVisibleTime: undefined,
    firstTokenTime: undefined,
    final: undefined,
    usage: undefined,
    retry: undefined,
    stepEnd: undefined,
  }
}

function hasInterruptionEvidence(blocks: readonly AssistantBlock[]): boolean {
  return blocks.some((block) => {
    if (block.kind === 'text' || block.kind === 'reasoning') return block.text.trim() !== ''
    return true
  })
}

/** Determine visibility from one delta without materializing the accumulated prefix. */
function firstVisibleFromChunk(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'block-start':
      return chunk.blockType !== 'text' && chunk.blockType !== 'reasoning' && chunk.blockType !== 'tool-call'
    case 'text-delta':
      return sanitizeAssistantText(chunk.text).trim() !== ''
    case 'reasoning-delta':
      return chunk.text.trim() !== ''
    case 'tool-call-delta':
      return false
    case 'block-end':
      return chunk.block.type === 'text'
        ? sanitizeAssistantText(chunk.block.text).trim() !== ''
        : chunk.block.type === 'reasoning'
          ? chunk.block.text.trim() !== ''
          : chunk.block.type !== 'tool-call'
    case 'usage':
      return false
    default:
      return false
  }
}

function addUsage(current: UsageValue | undefined, next: UsageValue): UsageValue {
  return {
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    ...(current?.cacheReadTokens === undefined && next.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: (current?.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0) }),
    ...(current?.cacheWriteTokens === undefined && next.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0) }),
    ...(current?.reasoningTokens === undefined && next.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: (current?.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0) }),
  }
}

function updateChunk(state: AssistantState, match: ConversationMatch): AssistantState {
  if (match.event.type !== 'assistant/chunk') return state
  const chunk = match.event.data.chunk
  if (chunk.type === 'usage') {
    return { ...state, sawChunk: true, usage: addUsage(state.usage, chunk.usage) }
  }
  switch (chunk.type) {
    case 'block-start':
      state.blocks.start(chunk.index, chunk.blockType)
      break
    case 'text-delta':
      state.blocks.textDelta(chunk.index, chunk.text)
      break
    case 'reasoning-delta':
      state.blocks.reasoningDelta(chunk.index, chunk.text)
      break
    case 'tool-call-delta':
      state.blocks.toolCallDelta(chunk.index, String(chunk.id), chunk.name, chunk.argumentsDelta)
      break
    case 'block-end':
      state.blocks.end(chunk.index, chunk.block)
      break
    default:
      return { ...state, sawChunk: true }
  }
  const visible = firstVisibleFromChunk(chunk)
  return {
    ...state,
    sawChunk: true,
    ...(visible && state.firstVisibleSeq === undefined
      ? { firstVisibleSeq: match.event.seq, firstVisibleTime: match.event.time }
      : {}),
    ...(isTokenDelta(chunk) && state.firstTokenTime === undefined
      ? { firstTokenTime: match.event.time }
      : {}),
  }
}

function closedBoundary(
  context: ConversationNodeContext<AssistantState>,
): { seq: number; time: number } | undefined {
  if (context.state?.stepEnd?.event.type === 'step/end') return context.state.stepEnd.event
  const location: ConversationLocation | undefined = context.start?.location
    ?? context.matches.at(-1)?.location
  if (location?.kind === 'step' && location.step.status === 'closed') return location.step.end
  if ((location?.kind === 'step' || location?.kind === 'turn')
    && location.turn.status === 'closed') return location.turn.end
  return undefined
}

function fallbackState(context: ConversationNodeContext<AssistantState>): AssistantState | undefined {
  let state: AssistantState | undefined
  for (const match of context.matches) {
    const event = match.event
    if (event.type === 'assistant/chunk') {
      state ??= initialState(event.data.turn, event.data.step, event.seq, event.time, false)
      state = updateChunk(state, match)
    } else if (event.type === 'assistant/message') {
      state ??= initialState(event.data.turn, event.data.step, event.seq, event.time, false)
      const blocks = toAssistantBlocks(event.data.message.content)
      state = {
        ...state,
        blocks: new IncrementalAssistantBlocks(blocks),
        final: match,
        usage: state.usage ?? event.data.usage,
      }
    } else if (event.type === 'step/end' && state !== undefined) {
      state = { ...state, stepEnd: match }
    }
  }
  return state
}

function finalNode(
  state: AssistantState,
  context: ConversationNodeContext<AssistantState>,
): AssistantMessageNode | undefined {
  const final = state.final
  if (final?.event.type === 'assistant/message') {
    const event = final.event
    return {
      kind: 'assistant',
      seq: event.seq,
      messageId: event.data.message.id,
      time: event.time,
      turn: state.turn,
      step: state.step,
      blocks: toAssistantBlocks(event.data.message.content),
      usage: event.data.usage,
      provenance: {
        provider: event.data.message.source.provider,
        model: event.data.message.source.model,
      },
      timing: {
        stepStartTime: state.started ? state.startTime : null,
        firstTokenTime: state.firstTokenTime ?? null,
        completedTime: event.time,
      },
      ...(event.data.interrupted === true ? { interrupted: true } : {}),
    }
  }
  const boundary = closedBoundary(context)
  const blocks = state.blocks.snapshot()
  if (boundary === undefined || !hasInterruptionEvidence(blocks)) return undefined
  return {
    kind: 'assistant',
    seq: boundary.seq - 0.9,
    time: boundary.time,
    turn: state.turn,
    step: state.step,
    blocks,
    interrupted: true,
  }
}

function assistantRequest(
  state: AssistantState,
  node: AssistantMessageNode | undefined,
  boundary: { seq: number; time: number } | undefined,
): Extract<RequestView, { purpose: 'assistant' }> | undefined {
  if (!state.started) return undefined
  const status = node !== undefined && node.interrupted !== true
    ? 'complete'
    : state.retry !== undefined || boundary !== undefined ? 'error' : 'running'
  return {
    purpose: 'assistant',
    startSeq: state.startSeq,
    turn: state.turn,
    step: state.step,
    startedAt: state.startTime,
    completedAt: node?.time ?? boundary?.time ?? null,
    status,
    ...(state.retry === undefined
      ? {}
      : {
        error: state.retry.message,
        retry: state.retry.retry,
        ...(state.retry.maxRetries === undefined ? {} : { maxRetries: state.retry.maxRetries }),
        retryDelayMs: state.retry.delayMs,
      }),
    ...(node?.messageId === undefined
      ? {}
      : {
        resultSeq: node.seq,
        ...(node.provenance === undefined ? {} : { provenance: node.provenance }),
      }),
    ...(state.usage === undefined ? {} : { usage: state.usage }),
  }
}

/** Trajectory-owned Assistant streaming, settlement, and request lifecycle. */
const trajectoryAssistantDefinition: ConversationNodeDefinition<AssistantState> = {
  kind: 'trajectory-assistant-step',
  target: 'trajectory',
  match: (event) => {
    if (event.type === 'step/start') {
      return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
    }
    if (event.type === 'assistant/chunk'
      || event.type === 'assistant/message'
      || event.type === 'llm/retry'
      || event.type === 'step/end') {
      return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'step/start') {
      throw new Error('trajectory-assistant-step start requires step/start')
    }
    return initialState(
      match.event.data.turn,
      match.event.data.step,
      match.event.seq,
      match.event.time,
      true,
    )
  },
  update: (context, match) => {
    if (match.event.type === 'assistant/chunk') return updateChunk(context.state, match)
    if (match.event.type === 'assistant/message') {
      const blocks = toAssistantBlocks(match.event.data.message.content)
      return {
        ...context.state,
        blocks: new IncrementalAssistantBlocks(blocks),
        final: match,
        usage: context.state.usage ?? match.event.data.usage,
      }
    }
    if (match.event.type === 'step/end') return { ...context.state, stepEnd: match }
    if (match.event.type !== 'llm/retry') return context.state
    const data = match.event.data
    return {
      ...initialState(
        context.state.turn,
        context.state.step,
        context.state.startSeq,
        context.state.startTime,
        true,
      ),
      firstTokenTime: context.state.firstTokenTime,
      usage: context.state.usage,
      retry: {
        message: displayFailureMessage(data.failure),
        retry: data.retry,
        ...(data.mode === 'normal' ? { maxRetries: data.maxRetries } : {}),
        delayMs: data.delayMs,
      },
    }
  },
  publication: (match) => {
    if (match.event.type === 'step/start') return 'none'
    if (match.event.type !== 'assistant/chunk') return 'immediate'
    const type = match.event.data.chunk.type
    return type === 'usage' || type === 'finish' ? 'none' : 'animation-frame'
  },
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context)
    if (state === undefined) return null
    const node = finalNode(state, context)
    const boundary = closedBoundary(context)
    const partial: PartialAssistant | null = node === undefined && boundary === undefined && state.sawChunk
      ? { turn: state.turn, step: state.step, blocks: state.blocks.snapshot() }
      : null
    const request = assistantRequest(state, node, boundary)
    if (node === undefined && partial === null && request === undefined) return null
    return trajectoryNode(context, state.startSeq, {
      kind: 'assistant',
      ...(node === undefined ? {} : { node }),
      partial,
      ...(request === undefined ? {} : { request }),
    })
  },
}

interface TurnEndState {
  readonly turn: number
  readonly seq: number
  readonly time: number
  readonly error?: string
}

const trajectoryTurnEndDefinition: ConversationNodeDefinition<TurnEndState> = {
  kind: 'trajectory-turn-end',
  target: 'trajectory',
  match: event => event.type === 'turn/end'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'turn/end') {
      throw new Error('trajectory-turn-end start requires turn/end')
    }
    const reason = match.event.data.reason
    return {
      turn: match.event.data.turn,
      seq: match.event.seq,
      time: match.event.time,
      ...(reason.kind === 'error' ? { error: displayFailureMessage(reason.error) } : {}),
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : trajectoryNode(context, context.state.seq, {
      kind: 'turn-end',
      turn: context.state.turn,
      time: context.state.time,
      ...(context.state.error === undefined ? {} : { error: context.state.error }),
    }),
}
/* jscpd:ignore-end */

/**
 * Register the Trajectory Assistant lifecycle.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
export function registerTrajectoryAssistantDefinition(ctx: Context): void {
  ctx.conversationEvents.register(trajectoryAssistantDefinition)
  ctx.conversationEvents.register(trajectoryTurnEndDefinition)
}
