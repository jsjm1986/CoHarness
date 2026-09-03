import type { Context } from '@deepseek-ai/cordis'
import type {
  AssistantBlock, AssistantMessageNode, ConversationLocation, ConversationMatch,
  ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  IncrementalAssistantBlocks, isAppendSurfaceEvent, isTokenDelta, sanitizeAssistantText,
  toAssistantBlocks,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'
import type { AssistantChatData } from '../contract/chat-nodes.ts'
import { CHAT_SYNTHETIC_SEQ_OFFSETS, chatNode } from './common.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Streaming, settled, or interrupted Assistant step. */
    'assistant-step': AssistantChatData
  }
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationStepDataMap {
    /** Streaming, settled, or interrupted Assistant material for this Step. */
    'assistant-step': AssistantChatData
  }
}

interface AssistantState {
  readonly turn: number
  readonly step: number
  /** Sparse stream slots; mutable accumulators keep each chunk O(1). */
  readonly blocks: IncrementalAssistantBlocks
  readonly firstVisibleSeq: number | undefined
  readonly firstVisibleTime: number | undefined
  readonly firstTokenTime: number | undefined
  readonly hidden: boolean
  readonly final: ConversationMatch | undefined
  readonly usage: unknown
}

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

function materializeBlocks(state: AssistantState): AssistantBlock[] {
  return state.blocks.snapshot()
}

function initialState(turn: number, step: number): AssistantState {
  return {
    turn,
    step,
    blocks: new IncrementalAssistantBlocks(),
    firstVisibleSeq: undefined,
    firstVisibleTime: undefined,
    firstTokenTime: undefined,
    hidden: false,
    final: undefined,
    usage: undefined,
  }
}

function hasVisibleContent(blocks: readonly AssistantBlock[]): boolean {
  return blocks.some((block) => {
    if (block.kind === 'tool-call') return false
    if (block.kind === 'text' || block.kind === 'reasoning') return block.text.trim() !== ''
    return true
  })
}

function hasInterruptionEvidence(blocks: readonly AssistantBlock[]): boolean {
  return blocks.some((block) => {
    if (block.kind === 'text' || block.kind === 'reasoning') return block.text.trim() !== ''
    return true
  })
}

function resetForRetry(state: AssistantState): AssistantState {
  return {
    ...initialState(state.turn, state.step),
    firstTokenTime: state.firstTokenTime,
    hidden: true,
  }
}

function updateChunk(state: AssistantState, match: ConversationMatch): AssistantState {
  if (match.event.type !== 'assistant/chunk') return state
  const chunk = match.event.data.chunk
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
    case 'usage':
      return { ...state, usage: chunk.usage }
    default:
      return state
  }
  const visible = firstVisibleFromChunk(chunk)
  const firstToken = isTokenDelta(chunk)
  return {
    ...state,
    hidden: visible ? false : state.hidden,
    ...visible && state.firstVisibleSeq === undefined
      ? { firstVisibleSeq: match.event.seq, firstVisibleTime: match.event.time }
      : {},
    ...firstToken && state.firstTokenTime === undefined
      ? { firstTokenTime: match.event.time }
      : {},
  }
}

function closedBoundary(location: ConversationLocation): { seq: number; time: number } | undefined {
  if (location.kind === 'step' && location.step.status === 'closed' && location.step.end !== undefined) {
    return location.step.end
  }
  if ((location.kind === 'step' || location.kind === 'turn')
    && location.turn.status === 'closed' && location.turn.end !== undefined) {
    return location.turn.end
  }
  return undefined
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
      timing: {
        stepStartTime: context.start?.event.time ?? null,
        firstTokenTime: state.firstTokenTime ?? null,
        completedTime: event.time,
      },
      ...event.data.interrupted === true ? { interrupted: true } : {},
    }
  }
  const location = context.start?.location ?? context.matches.at(-1)?.location
  const boundary = location === undefined ? undefined : closedBoundary(location)
  const blocks = materializeBlocks(state)
  if (boundary === undefined || !hasInterruptionEvidence(blocks)) return undefined
  return {
    kind: 'assistant',
    seq: boundary.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedAssistant,
    time: boundary.time,
    turn: state.turn,
    step: state.step,
    blocks,
    interrupted: true,
  }
}

function fallbackState(context: ConversationNodeContext<AssistantState>): AssistantState | undefined {
  let state: AssistantState | undefined
  for (const match of context.matches) {
    if (match.event.type === 'assistant/chunk') {
      state ??= initialState(match.event.data.turn, match.event.data.step)
      state = updateChunk(state, match)
      continue
    }
    if (match.event.type === 'assistant/message') {
      const blocks = toAssistantBlocks(match.event.data.message.content)
      state ??= initialState(match.event.data.turn, match.event.data.step)
      state = {
        ...state,
        blocks: new IncrementalAssistantBlocks(blocks),
        hidden: false,
        final: match,
        usage: match.event.data.usage,
      }
      continue
    }
    if (match.event.type === 'llm/retry' && state !== undefined) {
      state = resetForRetry(state)
    }
  }
  return state
}

interface AssistantProjection {
  readonly data: AssistantChatData
  readonly anchorSeq: number
  readonly visible: boolean
  readonly settled: AssistantMessageNode | undefined
}

/**
 * One projection per (state, start Location) pair. Every chunk yields a new
 * state object and every boundary change yields a new Location value, so the
 * pair identifies the projection's inputs; the step-scope Location data and
 * the view node of one flush then share it instead of materializing twice.
 */
const projectionMemo = new WeakMap<AssistantState, {
  readonly location: ConversationLocation | undefined
  readonly projection: AssistantProjection
}>()

function projectAssistant(context: ConversationNodeContext<AssistantState>): AssistantProjection | undefined {
  const state = context.state ?? fallbackState(context)
  if (state === undefined) return undefined
  const location = context.start?.location
  const memoized = context.state === undefined ? undefined : projectionMemo.get(state)
  if (memoized !== undefined && memoized.location === location) return memoized.projection
  const projection = buildProjection(state, context)
  if (context.state !== undefined) projectionMemo.set(state, { location, projection })
  return projection
}

function buildProjection(state: AssistantState, context: ConversationNodeContext<AssistantState>): AssistantProjection {
  const settled = finalNode(state, context)
  const blocks = settled?.blocks ?? materializeBlocks(state)
  const visible = hasVisibleContent(blocks)
  const status = settled?.interrupted === true
    ? 'interrupted'
    : settled === undefined ? 'running' : 'settled'
  const anchorSeq = settled?.seq ?? state.firstVisibleSeq ?? context.matches[0]?.event.seq ?? 0
  const time = settled?.time ?? state.firstVisibleTime ?? context.matches[0]?.event.time ?? 0
  return {
    anchorSeq,
    visible,
    settled,
    data: {
      status,
      turn: state.turn,
      step: state.step,
      blocks,
      time,
      ...state.usage === undefined ? {} : { usage: state.usage },
      ...settled === undefined ? {} : { finalNode: settled },
    },
  }
}

/** Per-step Assistant streaming/final/interruption Definition. */
export const assistantDefinition: ConversationNodeDefinition<AssistantState> = {
  kind: 'assistant-step',
  target: 'chat',
  match: (event) => {
    if (event.type === 'step/start') return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
    if (event.type === 'assistant/chunk'
      || (event.type === 'assistant/message' && isAppendSurfaceEvent(event))) {
      return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
    }
    if (event.type === 'llm/retry') {
      return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'step/start') throw new Error('assistant-step start requires step/start')
    return initialState(match.event.data.turn, match.event.data.step)
  },
  update: (context, match) => {
    if (match.event.type === 'assistant/chunk') return updateChunk(context.state, match)
    if (match.event.type === 'assistant/message') {
      const blocks = toAssistantBlocks(match.event.data.message.content)
      return {
        ...context.state,
        blocks: new IncrementalAssistantBlocks(blocks),
        hidden: false,
        final: match,
        usage: match.event.data.usage,
      }
    }
    if (match.event.type === 'llm/retry') {
      return resetForRetry(context.state)
    }
    return context.state
  },
  publication: (match) => {
    if (match.event.type === 'step/start') return 'none'
    if (match.event.type !== 'assistant/chunk') return 'immediate'
    const type = match.event.data.chunk.type
    return type === 'usage' || type === 'finish' ? 'none' : 'animation-frame'
  },
  buildLocationData: (context, scope) => {
    if (scope !== 'step') return null
    const projected = projectAssistant(context)
    if (projected === undefined) return null
    return {
      kind: 'step',
      turn: projected.data.turn,
      step: projected.data.step,
      key: 'assistant-step',
      value: projected.data,
    }
  },
  buildViewNode: (context) => {
    const projected = projectAssistant(context)
    if (projected === undefined) return null
    if (projected.settled === undefined && !projected.visible) {
      const state = context.state ?? fallbackState(context)
      if (state === undefined) return null
      const current = context.current.get('chat')
      if (!state.hidden || current === undefined || current === null) return null
    }
    return chatNode(context, 'assistant-step', projected.anchorSeq, projected.data, {
      visibility: projected.settled?.interrupted === true || projected.visible ? 'visible' : 'hidden',
    })
  },
}

/**
 * Register the Assistant lifecycle business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerAssistantConversationNode(ctx: Context): void {
  ctx.conversationEvents.register(assistantDefinition)
}
