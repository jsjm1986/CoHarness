/** Real model calls cannot replace an original Agent's live failed cleanup with new allocation. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentCarrier } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'
export const inject = ['llm', 'agents', 'tools', 'retiredCleanupHost']
export async function apply(ctx) {
  const mode = process.env.DSH_RETIRED_CLEANUP
  assert.ok(['workflow', 'ralph'].includes(mode))
  const transports = new Map(), ended = Promise.withResolvers()
  let endpoint, allowCleanup = false, starts = 0, parent, originalRun, endings = 0, oldClosedBeforeNew = true
  let firstError, secondError, busyAfterFailedExit, startsBeforeRecovery, oldOpenBeforeRecovery
  await applyLoopbackServerEffect(ctx, {
    label: 'retired-cleanup-child', onListening: address => { endpoint = `http://127.0.0.1:${address.port}` }, onCleanup: () => {},
    requestListener: (request, response) => {
      const state = transports.get(Number(request.url.slice(1)))
      assert.ok(state)
      state.responded = true
      response.once('close', () => { state.closed = true; state.closedSignal.resolve() })
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('original child remains owned')
    },
  })
  const stop = async state => { state.abort.abort(); await state.read; if (state.responded) await state.closedSignal.promise }
  const stopAll = async () => { allowCleanup = true; await Promise.all([...transports.values()].map(stop)) }
  ctx.effect(() => stopAll)
  ctx.on('workflow/start', info => { originalRun ??= info.id })
  ctx.on('session/event', (session, event) => {
    if (session === parent?.session && event.type === 'tool-workflow/run-end' && event.data.runId === originalRun) { endings++; ended.resolve() }
  }, { global: true })
  const provider = { name: 'retained-child', inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
    start: async spec => {
      assert.equal(spec.parent, parent)
      const ordinal = ++starts, ready = Promise.withResolvers()
      if (ordinal > 1) oldClosedBeforeNew &&= transports.get(1).closed
      const state = { abort: new AbortController(), closedSignal: Promise.withResolvers(), responded: false, closed: false }
      transports.set(ordinal, state)
      state.read = (async () => {
        try {
          const response = await fetch(`${endpoint}/${ordinal}`, { signal: state.abort.signal })
          assert.ok(response.body)
          for await (const bytes of response.body) { assert.ok(bytes.length > 0); ready.resolve() }
        } catch (error) { if (!state.abort.signal.aborted) { ready.reject(error); throw error } }
      })()
      void state.read.catch(() => { /* startup and the owned stop path observe failure */ })
      await ready.promise
      return { id: SessionId(`retained-child-${ordinal}`), localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'bounded child answer' }], stopReason: 'completed', structured: {
          status: 'complete', summary: 'Bounded work completed.', evidence: ['A bounded result was returned.'], nextSteps: [], blocker: '',
        } }),
        dispose: async () => { if (ordinal === 1 && !allowCleanup) throw new Error('native child cleanup is unconfirmed'); await stop(state) },
      }
    } }
  ctx.retiredCleanupHost.register(provider)
  let streams = 0
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 } }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {})
      parent ??= ctx.agents.get(options.sessionId)
      assert.ok(parent)
      const stage = streams++
      if (stage === 1 || stage === 2 || stage === 3) assert.equal(options.messages.at(-1).role, 'tool')
      if (stage === 1) {
        firstError = options.messages.at(-1).isError === true
        await ctx.retiredCleanupHost.replace(provider)
        busyAfterFailedExit = ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent }) === 'busy'
      }
      if (stage === 2) {
        secondError = options.messages.at(-1).isError === true
        startsBeforeRecovery = starts
        oldOpenBeforeRecovery = !transports.get(1).closed
        allowCleanup = true
      }
      if (stage < 3) {
        const id = ToolCallId(`retired-cleanup-call-${stage}`), name = mode
        const args = JSON.stringify(mode === 'workflow'
          ? { script: "return await agent('bounded work')", meta: { name: 'retained-recovery', description: 'Preserve original cleanup through replacement.' } }
          : { objective: 'Complete one bounded task.', maxRounds: 1 })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (mode === 'workflow' && secondError && startsBeforeRecovery === 1) await ended.promise
      const proof = { mode, firstError, secondError, busyAfterFailedExit, startsBeforeRecovery, oldOpenBeforeRecovery,
        thirdSucceeded: options.messages.at(-1).isError !== true, startsAfterRecovery: starts, oldClosedBeforeNew,
        allClosed: [...transports.values()].every(state => state.closed), originalEndings: mode === 'workflow' ? endings : null }
      await writeFile(join(process.cwd(), 'retired-cleanup-proof.json'), JSON.stringify(proof))
      const passed = firstError && secondError && busyAfterFailedExit && startsBeforeRecovery === 1 && oldOpenBeforeRecovery
        && proof.thirdSucceeded && starts === 2 && oldClosedBeforeNew && proof.allClosed && (mode !== 'workflow' || endings === 1)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: passed ? 'RETIRED_CLEANUP_OK' : 'RETIRED_CLEANUP_FAILED' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['retired-cleanup-fixture'], new Adapter()))
  ctx.provide('retiredCleanupReady', true)
}
