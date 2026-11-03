/** Runtime withdrawal cancels and joins real child-model metadata transport. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'
export const inject = ['llm', 'agents', 'tools', 'preflightHost']
export async function apply(ctx) {
  const mode = process.env.DSH_PREFLIGHT_MODE
  assert.ok(['foreground', 'background'].includes(mode))
  const workspace = process.cwd(), ownedAbort = new AbortController(), closed = Promise.withResolvers()
  let endpoint, transport, responseOpen = false, responseClosed = false, metadataStarted = 0, childStarts = 0
  let runtimeCancelled = false, providerFinished = false, providerFinishedBeforeWithdrawal = false, withdrawalWhileResponseOpen = false
  let withdrawal
  await applyLoopbackServerEffect(ctx, {
    label: 'child-model-metadata', onListening: address => { endpoint = `http://127.0.0.1:${address.port}` },
    requestListener: (_request, response) => {
      responseOpen = true
      response.once('close', () => { responseClosed = true; closed.resolve() })
      response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"pending":')
    },
  })
  const stop = async () => {
    ownedAbort.abort()
    if (transport !== undefined) await transport
    if (responseOpen) await closed.promise
  }
  ctx.effect(() => stop)
  ctx.preflightHost.register({ name: 'preflight-child', inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => { childStarts++; return { id: SessionId('unexpected-preflight-child'), localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} } },
  })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model, signal) {
      const metadata = { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 }
      if (model !== 'child-model') return metadata
      assert.ok(signal)
      metadataStarted++
      const ready = Promise.withResolvers()
      // Bounds a broken predecessor; success requires cancellation from the actual Runtime signal.
      const readingSignal = AbortSignal.any([signal, ownedAbort.signal, AbortSignal.timeout(10_000)])
      transport = (async () => {
        try {
          const response = await fetch(endpoint, { signal: readingSignal }); assert.ok(response.body)
          for await (const bytes of response.body) { assert.ok(bytes.length > 0); ready.resolve() }
        } catch (error) {
          if (!readingSignal.aborted) { ready.reject(error); throw error }
        } finally { if (responseOpen) await closed.promise }
      })()
      void transport.catch(() => { /* metadata resolution and owned shutdown observe the same transport */ })
      await ready.promise
      withdrawal = ctx.preflightHost.withdraw().then(() => {
        providerFinishedBeforeWithdrawal = providerFinished
        withdrawalWhileResponseOpen = responseOpen && !responseClosed
      })
      void withdrawal.catch(() => { /* the model stream awaits this owned withdrawal */ })
      await transport
      providerFinished = true; runtimeCancelled = signal.aborted
      signal.throwIfAborted()
      throw new Error('Fixture metadata deadline reached without Runtime cancellation')
    }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {})
      const parent = ctx.agents.get(options.sessionId); assert.ok(parent)
      const result = await ctx.tools.execute({ signal: options.signal, callId: ToolCallId('child-model-preflight'), name: 'subagent',
        arguments: { description: 'preflight ownership', prompt: 'work', run_in_background: mode === 'background' }, agent: parent })
      await withdrawal
      const proof = { mode, metadataStarted, runtimeCancelled, responseClosed, providerFinishedBeforeWithdrawal,
        withdrawalWhileResponseOpen, childStarts, toolError: result.isError }
      await writeFile(join(workspace, 'preflight-proof.json'), JSON.stringify(proof))
      const passed = metadataStarted === 1 && runtimeCancelled && responseClosed && providerFinishedBeforeWithdrawal
        && !withdrawalWhileResponseOpen && childStarts === 0 && result.isError
      yield { type: 'block-end', index: 0, block: { type: 'text', text: passed ? 'PREFLIGHT_WITHDRAWAL_OK' : 'PREFLIGHT_WITHDRAWAL_FAILED' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['preflight-fixture'], new Adapter()))
  ctx.provide('preflightReady', true)
}
