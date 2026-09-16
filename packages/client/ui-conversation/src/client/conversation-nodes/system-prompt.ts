import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { SystemPromptChatData } from '../contract/chat-nodes.ts'
import { chatNode } from './common.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Complete model-visible system prompt carried by a surface `system/message`. */
    'system-prompt': SystemPromptChatData
  }
}

interface SystemPromptState extends SystemPromptChatData {
  readonly seq: number
  readonly time: number
}

/** Join one message's text content blocks into a plain prompt string. */
function systemPromptText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** One surface `system/message` prompt rendered as a collapsed Chat row. */
export const systemPromptDefinition: ConversationNodeDefinition<SystemPromptState> = {
  kind: 'system-prompt',
  target: 'chat',
  match: (event) => {
    // Empty prompts still start a Context: they clear the effective prompt,
    // so backward lookups must see them instead of a stale predecessor.
    if (event.type !== 'system/message') return null
    return { id: String(event.seq), role: 'start' }
  },
  start: (_context, match) => {
    if (match.event.type !== 'system/message') throw new Error('system-prompt start requires system/message')
    return {
      seq: match.event.seq,
      time: match.event.time,
      text: systemPromptText(match.event.data.message.content),
    }
  },
  update: context => context.state,
  publication: () => 'immediate',
  buildViewNode: (context) => {
    if (context.state === undefined || context.state.text.trim() === '') return null
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
