/** Real auxiliary memory tools stop after their owning curation plugin unloads. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memoryCancellationFixture: { readonly stopped: Promise<void> }
  }
}

export const inject = ['llm', 'memory', 'loader']

/** Durable observation at which the fixture unloads curation. */
export interface Config { trigger?: 'after-entry' | 'before-entry' }

/**
 * Unload the actual Loader entry at a selected durable memory write.
 * @param ctx - Example context owning the keyless adapter and stop observer.
 * @param config - Whether cancellation precedes or follows the entry mutation.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const trigger = config.trigger ?? 'after-entry'
  if (trigger !== 'after-entry' && trigger !== 'before-entry') throw new TypeError('Unsupported memory cancellation trigger')
  const stopped = Promise.withResolvers<undefined>()
  ctx.provide('memoryCancellationFixture', { stopped: stopped.promise })
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    const entry = [...ctx.loader.entries()].find(entry => entry.id.endsWith(':memory-curation'))
    if (entry?.fiber === undefined) throw new Error('fixture requires the loaded curation entry')
    void entry.fiber.dispose().then(() => { stopped.resolve(undefined) }, stopped.reject)
  }
  ctx.on('memory/changed', (_scope, key) => {
    if (trigger === 'after-entry' && key === 'first') stop()
  })
  ctx.on('domain/changed', (change) => {
    if (trigger === 'before-entry' && change.domain === 'memory'
      && change.table === 'cursors' && change.key === 'consolidation-personal') stop()
  })
  class CancellationAdapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      const off = ReasoningEffortId('off')
      return { provider, id: model, name: model, reasoning: { efforts: [{ id: off, name: 'Off' }], defaultEffort: off } }
    }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (options.purpose === 'memory') {
        for (const [index, key] of ['first', 'second'].entries()) {
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'block-end', index, block: {
            type: 'tool-call', id: ToolCallId(`save-${key}`), name: 'memory_save',
            arguments: JSON.stringify({ key, kind: 'guidance', summary: `${key} fact`, content: `${key} body` }),
          } }
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['memory-cancellation'], new CancellationAdapter()))
}
