/** Real PTC scripts retain an external child transport through failed cleanup. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentCarrier } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'

export const inject = ['llm', 'agents', 'subagents', 'workflowEngine', 'tools', 'jobs']

/** Mount only the external child endpoint and deterministic main model. */
export async function apply(ctx) {
  const mode = process.env.DSH_WORKFLOW_CLEANUP
  assert.ok(['holder-retry', 'background-retry'].includes(mode))
  const abort = new AbortController(), closed = Promise.withResolvers()
  let endpoint, transport, activeResponse = false, transportClosed = false, allowCleanup = false
  await applyLoopbackServerEffect(ctx, {
    label: 'workflow-child-transport',
    onListening: address => { endpoint = `http://127.0.0.1:${address.port}` },
    requestListener: (_request, response) => {
      activeResponse = true
      response.once('close', () => { transportClosed = true; closed.resolve() })
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('child work remains active')
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
      void transport.catch(() => { /* the owned startup and stop paths observe this failure */ })
      await ready.promise
      return {
        id: SessionId('cleanup-child'), localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'child output' }], stopReason: 'completed' }),
        dispose: async () => {
          if (!allowCleanup) throw new Error('child transport cleanup unconfirmed')
          await stopTransport()
        },
      }
    },
  }))
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 }
    }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {})
      const parent = ctx.agents.get(options.sessionId)
      assert.ok(parent)
      const source = { script: "return await agent('owned external child')",
        meta: { name: 'cleanup-flow', description: 'Retain child cleanup ownership.' } }
      let run, jobId
      try {
        let proof
        if (mode === 'holder-retry') {
          run = ctx.workflowEngine.start({ ...source, parent })
          await run.result
          let cleanupRejected = false
          try { await run.dispose() } catch { cleanupRejected = true }
          const retainedTransport = activeResponse && !transportClosed
          allowCleanup = true
          await run.dispose()
          proof = { mode, cleanupRejected, retainedTransport, transportClosedByRetry: transportClosed }
        } else {
          const accepted = await ctx.tools.execute({
            name: 'workflow', callId: ToolCallId('workflow-cleanup'), signal: new AbortController().signal,
            arguments: { ...source, run_in_background: true }, agent: parent,
          })
          assert.equal(accepted.isError, false)
          const runId = accepted.value.runId
          jobId = accepted.value.jobId
          let observed = ctx.jobs.get(jobId, parent.id)
          while (!['completed', 'failed', 'killed'].includes(observed.status) && !observed.progress?.includes('cleanup')) {
            observed = await ctx.jobs.wait(jobId, 100, parent.id)
          }
          const liveDuringCleanup = ['running', 'stopping'].includes(ctx.jobs.get(jobId, parent.id).status)
          const cleanupNotice = ctx.jobs.get(jobId, parent.id).progress
          const ownerBusy = ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent }) === 'busy'
          const runEnds = () => parent.session.snapshotEvents().filter(event => event.type === 'tool-workflow/run-end' && event.data.runId === runId).length
          const endEventsBeforeCleanup = runEnds()
          allowCleanup = true
          ctx.jobs.kill(jobId, parent.id, 'retry child cleanup')
          const terminal = await ctx.jobs.wait(jobId, 10_000, parent.id)
          proof = { mode, liveDuringCleanup, cleanupNotice, ownerBusy, endEventsBeforeCleanup, finalStatus: terminal.status,
            transportClosed, runEndsAfterCleanup: runEnds(),
            jobEndsAfterCleanup: parent.session.snapshotEvents().filter(event => event.type === 'job/settled' && event.data.jobId === jobId).length }
        }
        await writeFile(join(process.cwd(), 'workflow-cleanup-proof.json'), JSON.stringify(proof))
        const passed = mode === 'holder-retry'
          ? proof.cleanupRejected && proof.retainedTransport && proof.transportClosedByRetry
          : proof.liveDuringCleanup && proof.ownerBusy && proof.endEventsBeforeCleanup === 0
            && proof.finalStatus === 'failed' && proof.transportClosed && proof.runEndsAfterCleanup === 1 && proof.jobEndsAfterCleanup === 1
        yield { type: 'block-end', index: 0, block: { type: 'text', text: passed ? 'WORKFLOW_CLEANUP_OK' : 'WORKFLOW_CLEANUP_FAILED' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        allowCleanup = true
        if (jobId !== undefined) {
          ctx.jobs.kill(jobId, parent.id, 'fixture cleanup')
          await ctx.jobs.wait(jobId, 10_000, parent.id)
        }
        await run?.dispose()
        await stopTransport()
      }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['workflow-cleanup-fixture'], new Adapter()))
  ctx.provide('workflowCleanupReady', true)
}
