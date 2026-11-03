/** Deterministic external model probes memory tools with the feature off and on. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'

export const inject = ['llm', 'memory']

/**
 * Register a model that exercises explicit and implicit memory scopes.
 * @param ctx - Loader-owned adapter context.
 */
export function apply(ctx: Context): void {
  class Adapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      return { provider, id: model, name: model }
    }

    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const command = options.messages.filter(message => message.role === 'user')
        .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : [])
        .findLast(text => text === 'MEMORY_TOOLS_OFF' || text === 'MEMORY_TOOLS_ON')
      assert.ok(command !== undefined)
      const disabled = command === 'MEMORY_TOOLS_OFF'
      const lastAssistant = options.messages.findLastIndex(message => message.role === 'assistant')
      const results = options.messages.slice(lastAssistant + 1).filter(message => message.role === 'tool')
        .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : [])
      if (results.length === 0) {
        const kinds = ctx.memory.space === 'personal' ? ['personal', 'workspace'] : ['project']
        const calls: { name: string; args: Record<string, string> }[] = []
        for (const kind of kinds) {
          const scope: Record<string, string> = kind === 'project' ? {} : { scope: kind }
          calls.push({ name: 'memory_read', args: { ...scope, key: 'release-rule' } },
            { name: 'memory_search', args: { ...scope, query: 'member' } })
        }
        if (ctx.memory.space === 'personal') calls.push({ name: 'memory_search', args: { query: 'member' } })
        if (disabled) {
          const scope: Record<string, string> = ctx.memory.space === 'personal' ? { scope: 'personal' } : {}
          calls.push({ name: 'memory_save', args: { ...scope, key: 'blocked-write', kind: 'guidance',
            summary: 'Blocked new entry', content: 'This must not be persisted.' } },
          { name: 'memory_delete', args: { ...scope, key: 'release-rule' } })
        }
        for (const [index, call] of calls.entries()) {
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'block-end', index, block: { type: 'tool-call',
            id: ToolCallId(`${disabled ? 'off' : 'on'}-${index}`), name: call.name, arguments: JSON.stringify(call.args) } }
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (disabled) assert.ok(results.every(text => text === 'Error: Saved memories are unavailable to this conversation.'))
      else {
        assert.ok(results.every(text => text.includes('release-rule')))
        assert.ok(results.some(text => text.includes('Stored member guidance.')))
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Done.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['memory-disabled-tools'], new Adapter()))
}
