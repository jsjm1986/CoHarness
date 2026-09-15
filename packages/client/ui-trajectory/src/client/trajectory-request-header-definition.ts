import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationContextReader, ConversationMatch, ConversationNodeDefinition,
  ConversationPromptSnapshot, RequestPromptChange,
} from '@deepseek-ai/dsh-client-runtime/client'
import { trajectoryNode } from './trajectory-definition-common.ts'
import type { TrajectoryRequestHeaderState } from './trajectory-contract.ts'

/** Structural view of the ui-conversation `system-prompt` Context state. */
interface SystemPromptContextState {
  readonly text: string
}

function requestPrompt(
  match: ConversationMatch,
  reader: ConversationContextReader,
): ConversationPromptSnapshot {
  if (match.event.type !== 'request/header') {
    throw new Error('trajectory-request-header start requires request/header')
  }
  const header = match.event.data.header
  const tools: unknown = header.tools
  const system = reader.previous<SystemPromptContextState>('system-prompt')?.state.text ?? ''
  return {
    config: header.config,
    system,
    tools: Array.isArray(tools) ? tools as ConversationPromptSnapshot['tools'] : [],
  }
}

function promptChange(
  previous: ConversationPromptSnapshot | undefined,
  prompt: ConversationPromptSnapshot,
  match: ConversationMatch,
): RequestPromptChange | undefined {
  if (match.event.type !== 'request/header') return undefined
  if (previous === undefined && match.event.data.reason !== 'initial') return undefined
  const systemChanged = previous !== undefined && previous.system !== prompt.system
  const toolsChanged = previous !== undefined
    && JSON.stringify(previous.tools) !== JSON.stringify(prompt.tools)
  if (previous !== undefined && !systemChanged && !toolsChanged) return undefined
  return {
    seq: match.event.seq,
    time: match.event.time,
    kind: previous === undefined
      ? 'initial'
      : systemChanged && toolsChanged
        ? 'system-and-tools'
        : systemChanged ? 'system' : 'tools',
    ...(previous === undefined ? {} : { previous }),
  }
}

const trajectoryRequestHeaderDefinition: ConversationNodeDefinition<TrajectoryRequestHeaderState> = {
  kind: 'trajectory-request-header',
  target: 'trajectory',
  match: event => event.type === 'request/header'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match, reader) => {
    const prompt = requestPrompt(match, reader)
    const previous = reader.previous<TrajectoryRequestHeaderState>('trajectory-request-header')
      ?.state.prompt
    const change = promptChange(previous, prompt, match)
    return {
      seq: match.event.seq,
      time: match.event.time,
      prompt,
      location: match.location,
      ...(change === undefined ? {} : { change }),
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : trajectoryNode(context, context.state.seq, {
      kind: 'request-header',
      header: context.state,
    }),
}

/**
 * Register Trajectory request-header facts.
 *
 * @param ctx - Plugin context receiving the Definition.
 */
export function registerTrajectoryRequestHeaderDefinition(ctx: Context): void {
  ctx.conversationEvents.register(trajectoryRequestHeaderDefinition)
}
