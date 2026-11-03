/** One refused startup followed by a deterministic SDK child in the same provider. */
import { writeFile } from 'node:fs/promises'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'sdk-startup-recovery-child'
export const inject = ['llm']
export async function apply(ctx, config) {
  let first = false
  try { await writeFile(config.marker, '', { flag: 'wx' }); first = true }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  if (first) {
    await writeFile(config.pidFile, JSON.stringify({ pid: process.pid }) + '\n')
    throw new Error('Scripted initial child startup refusal')
  }
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Startup recovery verified.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Startup recovery verified.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['completion-fixture'], new Adapter()))
}
