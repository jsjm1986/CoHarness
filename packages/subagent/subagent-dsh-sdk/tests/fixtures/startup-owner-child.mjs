/** Deterministic child profile records physical startup and completes one model turn. */
import { appendFileSync } from 'node:fs'

export const inject = ['llm']
export async function apply(ctx, config) {
  appendFileSync(config.record, JSON.stringify({ started: true }) + '\n')
  const { LlmAdapter } = await import(config.llmEntry)
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() {
      if (config.dispatchRecord !== undefined) appendFileSync(config.dispatchRecord, JSON.stringify({ dispatched: true }) + '\n')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'SDK_OWNER_DONE' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'SDK_OWNER_DONE' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['startup-owner'], new Adapter()))
}
