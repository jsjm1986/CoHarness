/** Complete SDK runtime with a deterministic model and a deliberately unresolved plugin disposer. */
import { writeFile } from 'node:fs/promises'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'sdk-close-recovery-runtime'
export const inject = ['llm']
export function apply(ctx, config) {
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Runtime cleanup recovery verified.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Runtime cleanup recovery verified.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['close-fixture'], new Adapter()))
  ctx.effect(() => {
    const keepAlive = setInterval(() => {}, 1_000)
    return async () => {
      await writeFile(config.marker, 'cleanup-entered')
      await new Promise(() => {})
      clearInterval(keepAlive)
    }
  })
}
