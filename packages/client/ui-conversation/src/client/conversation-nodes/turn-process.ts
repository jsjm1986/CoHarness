import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationNodeDefinition, ConversationLocation,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { TurnProcessChatData } from '../contract/chat-nodes.ts'
import { chatNode } from './common.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Turn-level process summary shown before the final answer. */
    'turn-process': TurnProcessChatData
  }
}

interface TurnProcessState extends TurnProcessChatData {
  readonly evidence: boolean
}

type ConversationEvent = Parameters<ConversationNodeDefinition['match']>[0]

function eventTurn(event: ConversationEvent): number | undefined {
  const value = (event.data as Record<string, unknown> | undefined)?.turn
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

/**
 * Recognize the shipped delegation-tool naming convention without treating
 * unrelated tools such as `manage_agent` as subagent work. The durable
 * `tool/call` event stores the resolved tool name, not the provider metadata,
 * so the canonical `subagent` prefix is the only stable classification fact
 * available to this projection.
 * @param name - resolved durable tool name.
 * @returns whether the name denotes a delegation tool instance.
 */
function isSubagentToolName(name: string): boolean {
  return name === 'subagent' || name.startsWith('subagent_')
}

function turnLocation(context: {
  readonly start: { readonly location: ConversationLocation } | undefined
  readonly matches: readonly { readonly location: ConversationLocation }[]
}): ConversationLocation | undefined {
  return context.start?.location ?? context.matches.at(-1)?.location
}

function initial(turn: number, seq: number): TurnProcessState {
  return {
    turn,
    controlAnchorSeq: seq,
    messageCount: 0,
    toolCallCount: 0,
    subagentCount: 0,
    answerAnchorSeq: null,
    evidence: false,
  }
}

function update(state: TurnProcessState, event: ConversationEvent): TurnProcessState {
  let current = state
  if (event.type === 'assistant/message') {
    current = {
      ...current,
      messageCount: current.messageCount + 1,
      answerAnchorSeq: event.seq,
      evidence: true,
    }
  } else if (event.type === 'tool/call') {
    const subagent = isSubagentToolName(event.data.name)
    current = {
      ...current,
      toolCallCount: current.toolCallCount + (subagent ? 0 : 1),
      subagentCount: current.subagentCount + (subagent ? 1 : 0),
      evidence: true,
    }
  } else if (event.type === 'assistant/chunk' || event.type === 'llm/retry') {
    current = { ...current, evidence: true }
  }
  if (event.seq < current.controlAnchorSeq && current.evidence) return { ...current, controlAnchorSeq: event.seq }
  return current
}

function isTurnLocation(location: ConversationLocation | undefined): location is Extract<ConversationLocation, { kind: 'turn' | 'step' }> {
  return location?.kind === 'turn' || location?.kind === 'step'
}

/** Turn-scoped process summary projection. */
export const turnProcessDefinition: ConversationNodeDefinition<TurnProcessState> = {
  kind: 'turn-process',
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    const turn = eventTurn(event)
    if (turn === undefined) return null
    if (event.type === 'assistant/chunk' || event.type === 'assistant/message'
      || event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'llm/retry'
      || event.type === 'step/start' || event.type === 'step/end' || event.type === 'turn/end') {
      return { id: String(turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('turn-process start requires turn/start')
    return initial(match.event.data.turn, match.event.seq)
  },
  update: (context, match) => update(context.state, match.event),
  publication: () => 'immediate',
  buildViewNode: (context) => {
    const state = context.state
    const location = turnLocation(context)
    if (state === undefined || !state.evidence || !isTurnLocation(location)) return null
    return chatNode(context, 'turn-process', state.controlAnchorSeq - 0.5, {
      turn: state.turn,
      controlAnchorSeq: state.controlAnchorSeq,
      messageCount: state.messageCount,
      toolCallCount: state.toolCallCount,
      subagentCount: state.subagentCount,
      answerAnchorSeq: state.answerAnchorSeq,
    })
  },
}

/**
 * Register the turn-level process summary projection.
 * @param ctx - conversation registry context that owns the registration.
 */
export function registerTurnProcess(ctx: Context): void {
  ctx.conversationEvents.register(turnProcessDefinition)
}
