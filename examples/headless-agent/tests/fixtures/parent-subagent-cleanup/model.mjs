/** Parent Session shutdown joins native resources before its scoped world disappears. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'
export const inject = ['llm', 'agents', 'tools', 'parentCleanupHost']
export async function apply(ctx) {
  const mode = process.env.DSH_PARENT_CLEANUP, phase = process.env.DSH_PARENT_CLEANUP_PHASE
  assert.ok(['workflow', 'ralph'].includes(mode)); assert.ok(['live', 'retired'].includes(phase))
  const transport = { abort: new AbortController(), responded: false, closed: false, closedSignal: Promise.withResolvers() }
  const workspace = process.cwd()
  let endpoint, parent, allowCleanup = false, attempts = 0, starts = 0, streams = 0
  let parentExiting = false, hostStillLive = true
  ctx.effect(() => () => { hostStillLive = false })
  await applyLoopbackServerEffect(ctx, {
    label: 'parent-cleanup-child', onListening: address => { endpoint = `http://127.0.0.1:${address.port}` }, onCleanup: () => {},
    requestListener: (_request, response) => {
      transport.responded = true
      response.once('close', () => { transport.closed = true; transport.closedSignal.resolve() })
      response.writeHead(200, { 'content-type': 'text/plain' }); response.write('parent-owned child remains live')
    },
  })
  const stop = async () => {
    transport.abort.abort(); await transport.read
    if (transport.responded) await transport.closedSignal.promise
  }
  ctx.effect(() => stop)
  const provider = { name: 'retained-child', inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
    start: async spec => {
      assert.equal(spec.parent, parent); starts++
      const ready = Promise.withResolvers()
      transport.read = (async () => {
        try {
          const response = await fetch(endpoint, { signal: transport.abort.signal })
          assert.ok(response.body)
          for await (const bytes of response.body) { assert.ok(bytes.length > 0); ready.resolve() }
        } catch (error) { if (!transport.abort.signal.aborted) { ready.reject(error); throw error } }
      })()
      void transport.read.catch(() => { /* startup and owned native stop observe the same failure */ })
      await ready.promise
      return { id: SessionId('parent-cleanup-child'), localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'bounded child answer' }], stopReason: 'completed', structured: {
          status: 'complete', summary: 'Bounded work completed.', evidence: ['A bounded result was returned.'], nextSteps: [], blocker: '',
        } }),
        dispose: async () => {
          attempts++
          if (!allowCleanup) throw new Error('native child cleanup is unconfirmed')
          await stop()
          await writeFile(join(workspace, 'parent-cleanup-proof.json'), JSON.stringify({ mode, phase, parentExiting,
            hostStillLive, starts, attempts, responseClosed: transport.closed }))
        },
      }
    } }
  ctx.parentCleanupHost.register(provider)
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 } }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {})
      parent ??= ctx.agents.get(options.sessionId); assert.ok(parent)
      if (streams++ === 0) {
        parent.ctx.effect(() => () => { parentExiting = true })
        const id = ToolCallId('parent-cleanup-call'), name = mode
        const args = JSON.stringify(mode === 'workflow'
          ? { script: "return await agent('bounded work')", meta: { name: 'parent-cleanup', description: 'Keep original cleanup through parent shutdown.' } }
          : { objective: 'Complete one bounded task.', maxRounds: 1 })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
      }
      assert.equal(options.messages.at(-1).isError, true)
      if (phase === 'retired') await ctx.parentCleanupHost.replace(provider)
      await writeFile(join(workspace, 'parent-cleanup-before.json'), JSON.stringify({ mode, phase, toolError: true,
        responseOpen: !transport.closed, starts, attemptsBeforeShutdown: attempts }))
      allowCleanup = true
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'PARENT_CLEANUP_READY' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['parent-cleanup-fixture'], new Adapter()))
  ctx.provide('parentCleanupReady', true)
}
