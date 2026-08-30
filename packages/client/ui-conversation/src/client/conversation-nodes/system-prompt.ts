import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { SystemPromptChatData } from '../contract/chat-nodes.ts'
import { chatNode } from './common.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Complete model-visible system prompt from a request header. */
    'system-prompt': SystemPromptChatData
  }
}

interface SystemPromptState extends SystemPromptChatData {
  readonly seq: number
  readonly time: number
}

/** One request/header system prompt rendered as a collapsed Chat row. */
export const systemPromptDefinition: ConversationNodeDefinition<SystemPromptState> = {
  kind: 'system-prompt',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'request/header') return null
    const system = event.data.header.system
    return typeof system === 'string' && system.trim() !== ''
      ? { id: String(event.seq), role: 'start' }
      : null
  },
  start: (_context, match) => {
    if (match.event.type !== 'request/header') throw new Error('system-prompt start requires request/header')
    return {
      seq: match.event.seq,
      time: match.event.time,
      text: match.event.data.header.system ?? '',
    }
  },
  update: context => context.state,
  publication: () => 'immediate',
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return chatNode(context, 'system-prompt', context.state.seq, { text: context.state.text })
  },
}

/**
 * Register the request-header system prompt projection.
 * @param ctx - conversation registry context that owns the registration.
 */
export function registerSystemPromptConversationNode(ctx: Context): void {
  ctx.conversationEvents.register(systemPromptDefinition)
}
