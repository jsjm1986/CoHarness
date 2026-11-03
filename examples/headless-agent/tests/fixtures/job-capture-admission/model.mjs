/** Actual SDK composition verifies one exact-owner job cannot overfill a limit of one. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
export const inject = ['llm', 'agents', 'jobCaptureHost']
export async function apply(ctx) {
  let exercised = false
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 } }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {})
      let passed = true
      if (!exercised) {
        exercised = true
        const parent = ctx.agents.get(options.sessionId); assert.ok(parent)
        const proof = await ctx.jobCaptureHost.exercise(parent)
        await writeFile(join(process.cwd(), 'job-capture-proof.json'), JSON.stringify(proof))
        passed = proof.nestedRefused && proof.producerStarts === 1 && proof.requests === 1 && proof.closed === 1
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: passed ? 'JOB_CAPTURE_ADMISSION_OK' : 'JOB_CAPTURE_ADMISSION_FAILED' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['job-capture-fixture'], new Adapter()))
  ctx.provide('jobCaptureReady', true)
}
