/** Real foreground and background workflow calls keep durable records after tool withdrawal. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentCarrier } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'
export const inject = ['llm', 'agents', 'subagents', 'workflowEngine', 'tools', 'jobs', 'workflowRecordHost']
export async function apply(ctx) {
  const mode = process.env.DSH_WORKFLOW_RECORD_LIFETIME
  assert.ok(['foreground', 'background'].includes(mode))
  const child = Promise.withResolvers(), ended = Promise.withResolvers(), closed = Promise.withResolvers()
  const abort = new AbortController(), records = [], progress = []
  let endpoint, transport, responseStarted = false, responseClosed = false, parent, control, starts = 0, busyAfterWithdrawal, busyAtMemberEnd
  await applyLoopbackServerEffect(ctx, {
    label: 'workflow-record-child', onListening: address => { endpoint = `http://127.0.0.1:${address.port}` }, onCleanup: () => {},
    requestListener: (_request, response) => {
      responseStarted = true
      response.once('close', () => { responseClosed = true; closed.resolve() })
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('owned workflow response')
    },
  })
  const stop = async () => { abort.abort(); await Promise.allSettled([transport]); if (responseStarted) await closed.promise }
  ctx.effect(() => async () => {
    child.resolve({ output: [], stopReason: 'completed' })
    try { await control } finally { await stop() }
  })
  ctx.effect(() => ctx.jobs.events.subscribe({ owners: 'all' }, event => {
    if (event.type === 'progress' && event.job.kind === 'workflow') progress.push(event.job.progress)
  }))
  ctx.subagents.registerProvider({ name: 'record-child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async spec => {
      parent = spec.parent
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
      return { id: SessionId('workflow-record-child'), localAgent: undefined, result: child.promise, dispose: stop }
    } })
  ctx.on('session/event', (_session, event) => {
    if (parent === undefined || _session !== parent.session || !event.type.startsWith('tool-workflow/')) return
    records.push(event.type)
    if (event.type === 'tool-workflow/run-end') ended.resolve()
  }, { global: true })
  ctx.on('workflow/agent-start', () => {
    control = (async () => {
      assert.ok(responseStarted && !responseClosed)
      await ctx.workflowRecordHost.withdraw()
      busyAfterWithdrawal = ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent }) === 'busy'
      child.resolve({ output: [{ type: 'text', text: 'bounded child answer' }], stopReason: 'completed' })
    })()
    void control.catch(() => { /* the model and fixture teardown await this controller */ })
  })
  ctx.on('workflow/agent-end', () => {
    busyAtMemberEnd = ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent }) === 'busy'
  })
  let streams = 0
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 } }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {})
      if (streams++ === 0) {
        parent = ctx.agents.get(options.sessionId)
        assert.ok(parent)
        const id = ToolCallId('workflow-record-call'), name = 'workflow'
        const args = JSON.stringify({ script: "await agent('bounded child', { label: 'bounded member' }); phase('After withdrawal'); log('member finished'); return 'observed'", meta: { name: 'record-lifetime', description: 'Keep the original durable run record.' }, run_in_background: mode === 'background' })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (mode === 'background') {
        const jobs = ctx.get('jobs')
        assert.ok(jobs)
        const job = jobs.list(parent.id)[0]
        if (job === undefined) {
          await writeFile(join(process.cwd(), 'workflow-record-proof.json'), JSON.stringify({ error: 'no background job', lastMessage: options.messages.at(-1) }))
          throw new Error('Background workflow was not accepted')
        }
        const outcome = await jobs.wait(job.id, 5000, parent.id)
        if (outcome.status !== 'completed') {
          await writeFile(join(process.cwd(), 'workflow-record-proof.json'), JSON.stringify({ error: 'background job incomplete', outcome }))
          throw new Error('Background workflow did not complete')
        }
      }
      await control
      await ended.promise
      const job = mode === 'background' ? ctx.jobs.list(parent.id)[0] : undefined
      const jobLog = job === undefined ? undefined : ctx.jobs.readAt(job.id, 0, parent.id).chunks.map(chunk => chunk.text).join('')
      const proof = { mode, starts, busyAfterWithdrawal, busyAtMemberEnd, responseClosed, records, ...mode === 'background' ? { progress, jobLog } : {} }
      await writeFile(join(process.cwd(), 'workflow-record-proof.json'), JSON.stringify(proof))
      const passed = starts === 1 && busyAfterWithdrawal && busyAtMemberEnd && responseClosed && (mode !== 'background' ||
        JSON.stringify(progress) === JSON.stringify(['After withdrawal']) && jobLog === 'agent #1 bounded member started\nagent #1 completed\n▸ After withdrawal\nmember finished\n') && JSON.stringify(records) === JSON.stringify([
        'tool-workflow/run-start', 'tool-workflow/agent-start', 'tool-workflow/agent-end', 'tool-workflow/run-end',
      ])
      const text = passed ? 'WORKFLOW_RECORD_LIFETIME_OK' : 'WORKFLOW_RECORD_LIFETIME_FAILED'
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['workflow-record-fixture'], new Adapter()))
  ctx.provide('workflowRecordReady', true)
}
