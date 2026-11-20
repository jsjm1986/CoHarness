/** Controlled Host initialization and deterministic first model response. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/cordis' {
  interface Context {
    coldPresetControl: { entered: PromiseWithResolvers<undefined>; release: PromiseWithResolvers<undefined> }
    coldPresetReady: { value: string }
  }
}

class Adapter extends LlmAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!options.tools?.some(tool => tool.name === 'cold_ready')) throw new Error('First request lacks the Host-backed preset tool')
    const text = 'First request includes the ready Host tool.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'cold-preset-model'
export const inject = ['llm']
/** Install fixture-owned barriers and the keyless adapter. @param ctx - Loader context. */
export function apply(ctx: Context): void {
  ctx.provide('coldPresetControl', { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>() })
  ctx.effect(() => ctx.llm.registerAdapter(['cold-preset-model'], new Adapter()))
}
