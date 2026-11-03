/** Keyless model endpoint behind the actual Gateway policy consumer. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

export const inject = ['llm']

/**
 * Count requests that pass authorization and reach the model endpoint.
 * @param ctx - Context owning the fixture adapter.
 */
export function apply(ctx: Context): void {
  class PolicyAdapter extends LlmAdapter {
    async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      process.stdout.write(`${JSON.stringify({ type: 'adapter-request' })}\n`)
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['p'], new PolicyAdapter()))
}
