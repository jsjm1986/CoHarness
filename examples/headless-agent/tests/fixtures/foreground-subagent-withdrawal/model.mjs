/** A real model tool call retains a native response through result failure and runtime withdrawal. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentCarrier } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'
export const inject = ['llm', 'agents', 'tools', 'foregroundWithdrawalHost']
export async function apply(ctx) {
  const mode = process.env.DSH_FOREGROUND_WITHDRAWAL
  assert.ok(['completed', 'rejected'].includes(mode))
  const result = Promise.withResolvers(), closed = Promise.withResolvers(), stopping = Promise.withResolvers()
  const abort = new AbortController()
  let endpoint, transport, responseStarted = false, responseClosed = false, attempts = 0, starts = 0, parent, childSignal, completion, proof
  await applyLoopbackServerEffect(ctx, {
    label: 'foreground-withdrawal-child', onListening: address => { endpoint = `http://127.0.0.1:${address.port}` }, onCleanup: () => {},
    requestListener: (_request, response) => {
      responseStarted = true
      response.once('close', () => { responseClosed = true; closed.resolve() })
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('owned foreground child response')
    },
  })
  const stop = async () => { abort.abort(); await Promise.allSettled([transport]); if (responseStarted) await closed.promise }
  ctx.effect(() => async () => {
    result.resolve({ output: [], stopReason: 'completed' })
    try { await completion } finally { await stop() }
  })
  ctx.foregroundWithdrawalHost.runtime.registerProvider({ name: 'foreground-child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async spec => {
      parent = spec.parent
      childSignal = spec.signal
      starts++
      const ready = Promise.withResolvers()
      transport = (async () => {
        try {
          const response = await fetch(endpoint, { signal: abort.signal })
          assert.ok(response.body)
          for await (const bytes of response.body) { assert.ok(bytes.length > 0); ready.resolve() }
        } catch (error) { if (!abort.signal.aborted) { ready.reject(error); throw error } }
      })()
      void transport.catch(() => { /* startup and stop own transport failures */ })
      await ready.promise
      return { id: SessionId('foreground-withdrawal-child'), localAgent: undefined, result: result.promise,
        dispose: async () => { if (++attempts === 1) throw new Error('foreground native cleanup needs retry'); await stop() } }
    } })
  const host = ctx.foregroundWithdrawalHost
  host.observe(() => { stopping.resolve() })
  ctx.on('subagent/start', () => {
    completion = (async () => {
      const liveAtWithdrawal = responseStarted && !responseClosed
      const withdrawal = host.dispose().then(() => responseClosed)
      await stopping.promise
      const cancelled = childSignal.aborted
      const busy = ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent }) === 'busy'
      if (mode === 'completed') result.resolve({ output: [{ type: 'text', text: 'child answer' }], stopReason: 'completed' })
      else result.reject(new Error('foreground child result unavailable'))
      const closedBeforeWithdrawal = await withdrawal
      proof = { mode, liveAtWithdrawal, cancelled, busy, closedBeforeWithdrawal, attempts, starts, responseClosed }
    })()
    void completion.catch(() => { /* the model and fixture teardown await the same controller */ })
  }, { global: true })
  let streams = 0
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 } }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {})
      if (streams++ === 0) {
        const id = ToolCallId('foreground-withdrawal-call'), name = 'subagent', args = JSON.stringify({ description: 'owned foreground', prompt: 'bounded work' })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      await completion
      assert.ok(proof)
      const transcript = JSON.stringify(options.messages)
      const sawCleanupFailure = transcript.includes('foreground native cleanup needs retry')
      const sawResultFailure = transcript.includes('foreground child result unavailable')
      Object.assign(proof, { sawCleanupFailure, sawResultFailure })
      await writeFile(join(process.cwd(), 'foreground-withdrawal-proof.json'), JSON.stringify(proof))
      const passed = proof.liveAtWithdrawal && proof.cancelled && proof.busy && proof.closedBeforeWithdrawal
        && attempts === 2 && starts === 1 && responseClosed && sawCleanupFailure && sawResultFailure === (mode === 'rejected')
      const text = passed ? 'FOREGROUND_WITHDRAWAL_OK' : 'FOREGROUND_WITHDRAWAL_FAILED'
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['foreground-withdrawal-fixture'], new Adapter()))
  ctx.provide('foregroundWithdrawalReady', true)
}
