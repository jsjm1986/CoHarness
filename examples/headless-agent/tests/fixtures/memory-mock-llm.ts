import type { Context } from '@deepseek-ai/cordis'
import {
  ToolCallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const HIGH = ReasoningEffortId('high')
const OFF = ReasoningEffortId('off')

/** Keyless adapter: one real memory call followed by its fixture answer. */
class MemoryMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: OFF, name: 'Off' },
          { id: HIGH, name: 'High' },
        ],
        defaultEffort: HIGH,
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages.at(-1)
    const toolResult = last?.role === 'tool' ? last : undefined
    const searching = options.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text.includes('SEARCH_NORMALIZATION:')))
    if (toolResult === undefined) {
      const tool = searching ? 'memory_search' : 'memory_save'
      const args = JSON.stringify(searching ? { scope: 'personal', query: 'needle' } : {
        scope: 'personal',
        key: 'release-freeze',
        kind: 'background',
        summary: 'Freeze window for the release',
        content: 'No deploys on Friday.',
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('memory-smoke-call'), name: tool, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('memory-smoke-call'), name: tool, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const reply = searching
      ? toolResult.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      : 'Memory saved.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5, reasoningTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'memory-mock-llm'
export const inject = ['llm']

/**
 * Register the keyless `memory-mock` adapter.
 * @param ctx - Fixture owner of the adapter registration.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.llm.registerAdapter(['memory-mock'], new MemoryMockAdapter()))
}
