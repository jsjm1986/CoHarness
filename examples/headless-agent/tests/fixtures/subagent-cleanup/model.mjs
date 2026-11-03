/** One-shot background jobs retain an owned external transport until cleanup succeeds. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentCarrier } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'

export const inject = ['llm', 'agents', 'subagents', 'tools', 'jobs', 'systemPrompt', 'sessionProjections']

/** Mount the real delegation Consumer and the owned external child service. */
export async function apply(ctx) {
  const mode = process.env.DSH_SUBAGENT_CLEANUP
  assert.ok(['completed', 'rejected', 'pending-completed', 'pending-rejected'].includes(mode))
  const pendingCleanup = mode.startsWith('pending-'), firstDisposal = Promise.withResolvers(), cleanupEntered = Promise.withResolvers()
  let cleanupAttempts = 0
  const abort = new AbortController(), closed = Promise.withResolvers()
  let endpoint, transport, activeResponse = false, transportClosed = false, allowCleanup = false
  await applyLoopbackServerEffect(ctx, {
    label: 'subagent-child-transport',
    onListening: address => { endpoint = `http://127.0.0.1:${address.port}` },
    requestListener: (_request, response) => {
      activeResponse = true
      response.once('close', () => { transportClosed = true; closed.resolve() })
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('owned child transport')
    },
  })
  const stopTransport = async () => {
    abort.abort()
    if (transport !== undefined) await Promise.allSettled([transport])
    if (activeResponse) await closed.promise
  }
  ctx.effect(() => stopTransport)
  ctx.effect(() => ctx.subagents.registerProvider({
    name: 'cleanup-child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => {
      const ready = Promise.withResolvers()
      transport = (async () => {
        try {
          const response = await fetch(endpoint, { signal: abort.signal })
          assert.ok(response.body)
          for await (const chunk of response.body) { assert.ok(chunk.length > 0); ready.resolve() }
        } catch (error) {
          if (!abort.signal.aborted) { ready.reject(error); throw error }
        }
      })()
      void transport.catch(() => { /* startup and transport shutdown both observe this owned failure */ })
      await ready.promise
      return {
        id: SessionId('cleanup-child'), localAgent: undefined,
        result: mode.endsWith('rejected') ? Promise.reject(new Error('child result unavailable'))
          : Promise.resolve({ output: [{ type: 'text', text: 'unconfirmed child answer' }], stopReason: 'completed' }),
        dispose: async () => {
          cleanupAttempts++
          if (pendingCleanup && cleanupAttempts === 1) {
            cleanupEntered.resolve(); await firstDisposal.promise
            throw new Error('child transport cleanup unconfirmed')
          }
          if (!allowCleanup) throw new Error('child transport cleanup unconfirmed')
          await stopTransport()
        },
      }
    },
  }))
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const tool = await import(new URL(`../../../../../packages/subagent/tool-subagent/${face}`, import.meta.url))
  await ctx.plugin(tool, { provider: 'cleanup-child', backgroundMode: 'one-shot', maxDepth: 'provider-managed' })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 }
    }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {})
      const parent = ctx.agents.get(options.sessionId)
      assert.ok(parent)
      let jobId
      try {
        const accepted = await ctx.tools.execute({
          name: 'subagent', callId: ToolCallId('subagent-cleanup'), signal: new AbortController().signal,
          arguments: { description: 'retained child', prompt: 'work', run_in_background: true }, agent: parent,
        })
        assert.equal(accepted.isError, false)
        jobId = accepted.value.jobId
        if (pendingCleanup) await cleanupEntered.promise
        let observed = ctx.jobs.get(jobId, parent.id)
        while (!pendingCleanup && !['completed', 'failed', 'killed'].includes(observed.status) && !observed.progress?.includes('cleanup')) {
          observed = await ctx.jobs.wait(jobId, 100, parent.id)
        }
        const proof = {
          mode, liveDuringCleanup: ['running', 'stopping'].includes(observed.status),
          ...pendingCleanup ? { pendingCleanupAtTermination: true } : { cleanupNotice: observed.progress },
          retainedTransport: activeResponse && !transportClosed,
          ownerBusy: ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent }) === 'busy',
          endEventsBeforeCleanup: parent.session.snapshotEvents().filter(event => event.type === 'job/settled').length,
        }
        allowCleanup = true
        proof.retryRequested = ctx.jobs.kill(jobId, parent.id, 'retry child cleanup') === 'requested'
        if (pendingCleanup) firstDisposal.resolve()
        const terminal = await ctx.jobs.wait(jobId, 10_000, parent.id)
        Object.assign(proof, {
          ...pendingCleanup ? { cleanupAttempts } : {},
          finalStatus: terminal.status, finalDetail: terminal.detail, transportClosed,
          jobEndsAfterCleanup: parent.session.snapshotEvents().filter(event => event.type === 'job/settled').length,
        })
        await writeFile(join(process.cwd(), 'subagent-cleanup-proof.json'), JSON.stringify(proof))
        const passed = proof.liveDuringCleanup && proof.retainedTransport && proof.ownerBusy
          && proof.endEventsBeforeCleanup === 0 && proof.retryRequested && proof.finalStatus === 'failed'
          && proof.transportClosed && proof.jobEndsAfterCleanup === 1
        yield { type: 'block-end', index: 0, block: { type: 'text', text: passed ? 'SUBAGENT_CLEANUP_OK' : 'SUBAGENT_CLEANUP_FAILED' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        allowCleanup = true
        firstDisposal.resolve()
        if (jobId !== undefined) {
          ctx.jobs.kill(jobId, parent.id, 'fixture cleanup')
          await ctx.jobs.wait(jobId, 10_000, parent.id)
        }
        await stopTransport()
      }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['subagent-cleanup-fixture'], new Adapter()))
  ctx.provide('subagentCleanupReady', true)
}
