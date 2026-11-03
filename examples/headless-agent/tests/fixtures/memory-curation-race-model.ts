/** Two real user turns with a member deletion during the first auxiliary review. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { MemoryCursor } from '@deepseek-ai/dsh-memory'

/** Observed model inputs and completion of their conditional durable cursor. */
export interface CurationFixtureState {
  readonly reviews: readonly (readonly string[])[]
  readonly toolResults: readonly (readonly string[])[]
  readonly complete: Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context { memoryCurationFixture: CurationFixtureState }
}

export const inject = ['llm', 'memory']

/** Business scenario exercised by the keyless model. */
export interface Config { scenario?: 'member-edit' | 'scope-isolation' }

/**
 * Install a keyless adapter with an interleaved member operation.
 * @param ctx - Fixture context owning its adapter, state, and observers.
 * @param config - Concurrent member editing or scope-limited consolidation.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const scenario = config.scenario ?? 'member-edit'
  if (scenario !== 'member-edit' && scenario !== 'scope-isolation') throw new TypeError('Unsupported memory curation scenario')
  const reviews: string[][] = []
  const toolResults: string[][] = []
  let completed!: () => void
  const complete = new Promise<void>((resolve) => { completed = resolve })
  ctx.provide('memoryCurationFixture', { reviews, toolResults, complete })
  ctx.on('domain/changed', (change) => {
    if (change.domain !== 'memory' || change.table !== 'cursors') return
    const finalScope = scenario === 'member-edit'
      ? change.key === 'consolidation-personal' : change.key.startsWith('consolidation-workspace-')
    if (!finalScope) return
    const cursor = change.value as MemoryCursor | undefined
    if (reviews.length === 2 && cursor?.changedSince === 0) completed()
  })
  class CurationAdapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      const off = ReasoningEffortId('off')
      return { provider, id: model, name: model, reasoning: { efforts: [{ id: off, name: 'Off' }], defaultEffort: off } }
    }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      let text = 'Done.'
      if (options.purpose === 'memory') {
        const results = options.messages.filter(message => message.role === 'tool')
          .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : [])
        const instruction = options.messages.flatMap(message => message.content)
          .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        if (results.length > 0) toolResults.push(results)
        else reviews.push([...instruction.matchAll(/^- `([^`]+)`/gm)].map(match => match[1]!))
        if (scenario === 'scope-isolation' && results.length === 0) {
          const calls = instruction.includes('in the personal scope') ? [
            { name: 'memory_search', args: { query: 'workspace-only' } },
            { name: 'memory_search', args: { scope: 'workspace', query: 'workspace-only' } },
            { name: 'memory_read', args: { scope: 'workspace', key: 'workspace-only' } },
            { name: 'memory_save', args: { scope: 'workspace', key: 'cross-write', kind: 'guidance', summary: 'cross scope fact', content: 'unreviewed body' } },
            { name: 'memory_delete', args: { scope: 'workspace', key: 'workspace-only' } },
          ] : [{ name: 'memory_delete', args: { key: 'workspace-only' } }]
          for (const [index, call] of calls.entries()) {
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'block-end', index, block: {
              type: 'tool-call', id: ToolCallId(`scope-call-${index}`), name: call.name, arguments: JSON.stringify(call.args),
            } }
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        if (scenario === 'member-edit' && reviews.length === 1) {
          const removed = await ctx.memory.memberDelete({ scope: { kind: 'personal' }, key: 'obsolete' })
          if (!removed.ok) throw new Error('fixture could not remove the obsolete entry')
          const agent = options.sessionId === undefined ? undefined : ctx.get('agents')?.get(options.sessionId)
          if (agent === undefined) throw new Error('curation fixture requires its real root Agent')
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review the updated memories.' }], source: { kind: 'user' } }))
          await agent.whenIdle()
        }
        text = 'no changes'
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['curation-race'], new CurationAdapter()))
}
