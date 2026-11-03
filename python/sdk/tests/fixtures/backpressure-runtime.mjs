/** Complete model runtime whose second request blocks its event loop and stdin reader. */
import { writeFileSync } from 'node:fs'

export const name = 'sdk-backpressure-runtime'
export const inject = ['llm']
export async function apply(ctx, config) {
  const { LlmAdapter } = await import(config.llmEntry)
  let requests = 0
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() {
      requests++
      if (requests > 1) {
        writeFileSync(config.marker, 'runtime-input-blocked')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Backpressure runtime ready.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Backpressure runtime ready.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['backpressure-fixture'], new Adapter()))
}
