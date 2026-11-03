/** Real native child transports survive failed cleanup until exact-owner retry. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'

export const inject = ['llm', 'agents', 'subagents', 'workflowEngine', 'tools']

export async function apply(ctx) {
  const mode = process.env.DSH_FOREGROUND_WORKFLOW
  assert.ok(['workflow', 'ralph'].includes(mode))
  const transports = new Map(), runIds = [], ended = Promise.withResolvers()
  const ownedRuns = new Set(), engine = ctx.get('workflowEngine'), originalStart = engine.start
  engine.start = function (request) {
    const run = Reflect.apply(originalStart, this, [request])
    ownedRuns.add(run)
    return run
  }
  ctx.effect(() => () => { engine.start = originalStart })
  let endpoint, allowCleanup = false, allocations = 0, oldClosedBeforeNew = true
  await applyLoopbackServerEffect(ctx, {
    label: 'foreground-workflow-child',
    onListening: address => { endpoint = `http://127.0.0.1:${address.port}` },
    onCleanup: () => {},
    requestListener: (request, response) => {
      const state = transports.get(Number(request.url.slice(1)))
      assert.ok(state)
      state.responded = true
      response.once('close', () => { state.closed = true; state.closedSignal.resolve() })
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('child transport remains owned')
    },
  })
  const stop = async (state) => {
    state.abort.abort()
    await state.read
    if (state.responded) await state.closedSignal.promise
  }
  const stopAll = async () => {
    allowCleanup = true
    await Promise.all([...transports.values()].map(stop))
  }
  ctx.effect(() => stopAll)
  ctx.on('workflow/start', info => { runIds.push(info.id) })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool-workflow/run-end' && event.data.runId === runIds[0]) ended.resolve()
  })
  ctx.subagents.registerProvider({
    name: 'foreground-child', inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
    start: async () => {
      const id = ++allocations, ready = Promise.withResolvers()
      if (id > 1) oldClosedBeforeNew &&= transports.get(1).closed
      const state = { abort: new AbortController(), closedSignal: Promise.withResolvers(), closed: false, responded: false }
      transports.set(id, state)
      state.read = (async () => {
        try {
          const response = await fetch(`${endpoint}/${id}`, { signal: state.abort.signal })
          assert.ok(response.body)
          for await (const bytes of response.body) { assert.ok(bytes.length > 0); ready.resolve() }
        } catch (error) {
          if (!state.abort.signal.aborted) { ready.reject(error); throw error }
        }
      })()
      void state.read.catch(() => { /* startup and the owned stop path observe failure */ })
      await ready.promise
      return { id: SessionId(`foreground-child-${id}`), localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'child completed' }], stopReason: 'completed', structured: {
          status: 'complete', summary: 'The bounded child completed.', evidence: ['The child returned its result.'], nextSteps: [], blocker: '',
        } }),
        dispose: async () => {
          if (id === 1 && !allowCleanup) throw new Error('foreground child transport cleanup is unconfirmed')
          await stop(state)
        },
      }
    },
  })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 }
    }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {})
      const parent = ctx.agents.get(options.sessionId)
      assert.ok(parent)
      const args = mode === 'workflow'
        ? { script: "return await agent('owned child')", meta: { name: 'foreground-recovery', description: 'Preserve child cleanup ownership.' } }
        : { objective: 'Complete one bounded independent task.', maxRounds: 1 }
      const execute = () => ctx.tools.execute({ name: mode, callId: ToolCallId(`foreground-call-${runIds.length + 1}`),
        signal: new AbortController().signal, agent: parent, arguments: args })
      const originalEnds = () => mode === 'ralph' ? null : parent.session.snapshotEvents()
        .filter(event => event.type === 'tool-workflow/run-end' && event.data.runId === runIds[0]).length
      try {
        const first = await execute()
        const second = await execute()
        const allocationsBeforeRecovery = allocations
        const oldOpenWhileRefused = !transports.get(1).closed
        const originalEndsBeforeRecovery = originalEnds()
        allowCleanup = true
        const third = await execute()
        if (mode === 'workflow' && second.isError && allocationsBeforeRecovery === 1) await ended.promise
        const proof = { mode, firstError: first.isError, secondError: second.isError,
          allocationsBeforeRecovery, oldOpenWhileRefused, originalEndsBeforeRecovery,
          thirdSucceeded: !third.isError, allocationsAfterRecovery: allocations, oldClosedBeforeNew,
          allClosedAfterRecovery: [...transports.values()].every(state => state.closed), originalEndsAfterRecovery: originalEnds() }
        await writeFile(join(process.cwd(), 'foreground-workflow-proof.json'), JSON.stringify(proof))
        const passed = proof.firstError && proof.secondError && allocationsBeforeRecovery === 1 && oldOpenWhileRefused
          && proof.thirdSucceeded && allocations === 2 && oldClosedBeforeNew && proof.allClosedAfterRecovery
          && (mode === 'ralph' || originalEndsBeforeRecovery === 0 && proof.originalEndsAfterRecovery === 1)
        yield { type: 'block-end', index: 0, block: { type: 'text', text: passed ? 'WORKFLOW_FOREGROUND_RECOVERY_OK' : 'WORKFLOW_FOREGROUND_RECOVERY_FAILED' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        allowCleanup = true
        await Promise.allSettled([...ownedRuns].map(run => run.dispose()))
        await stopAll()
      }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['foreground-workflow-fixture'], new Adapter()))
  ctx.provide('foregroundWorkflowReady', true)
}
