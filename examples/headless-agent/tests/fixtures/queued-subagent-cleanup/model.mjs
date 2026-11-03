/** Native responses remain owned when another cleanup joins a waiting admission. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'

export const inject = ['llm', 'agents', 'subagents']
export async function apply(ctx) {
  const mode = process.env.DSH_QUEUED_CLEANUP
  assert.ok(['refused', 'recovered'].includes(mode))
  const states = new Map(), entered = Promise.withResolvers(), release = Promise.withResolvers()
  let endpoint, starts = 0, firstAttempts = 0, secondAttempts = 0, allowSecond = false, closedBeforeDispatch = true
  await applyLoopbackServerEffect(ctx, {
    label: 'queued-subagent-child', onListening: address => { endpoint = `http://127.0.0.1:${address.port}` }, onCleanup: () => {},
    requestListener: (request, response) => {
      const state = states.get(Number(request.url.slice(1)))
      assert.ok(state)
      state.responded = true
      response.once('close', () => { state.closed = true; state.closedSignal.resolve() })
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('owned child response')
    },
  })
  const stop = async (state) => {
    state.abort.abort()
    await state.read
    if (state.responded) await state.closedSignal.promise
  }
  ctx.effect(() => async () => { await Promise.all([...states.values()].map(stop)) })
  ctx.subagents.registerProvider({ name: 'queued-child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => {
      const id = ++starts, ready = Promise.withResolvers()
      if (id > 2) closedBeforeDispatch &&= states.get(1).closed && states.get(2).closed
      const state = { abort: new AbortController(), responded: false, closed: false, closedSignal: Promise.withResolvers() }
      states.set(id, state)
      state.read = (async () => {
        try {
          const response = await fetch(`${endpoint}/${id}`, { signal: state.abort.signal })
          assert.ok(response.body)
          for await (const bytes of response.body) { assert.ok(bytes.length > 0); ready.resolve() }
        } catch (error) { if (!state.abort.signal.aborted) { ready.reject(error); throw error } }
      })()
      void state.read.catch(() => { /* startup and the owned stop path observe failure */ })
      await ready.promise
      return { id: SessionId(`queued-child-${id}`), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => {
          if (!state.closed && id === 1) {
            if (++firstAttempts === 1) throw new Error('first response cleanup unconfirmed')
            entered.resolve()
            await release.promise
          }
          if (!state.closed && id === 2) {
            secondAttempts++
            if (!allowSecond) throw new Error('second response cleanup unconfirmed')
          }
          await stop(state)
        },
      }
    } })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 }
    }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {})
      const parent = ctx.agents.get(options.sessionId)
      assert.ok(parent)
      const request = { parent, signal: new AbortController().signal, prompt: [{ type: 'text', text: 'bounded child' }] }
      const runs = []
      let pending
      try {
        const first = await ctx.subagents.start('queued-child', request)
        const second = await ctx.subagents.start('queued-child', request)
        runs.push(first, second)
        await assert.rejects(first.dispose(), /first response/)
        void ctx.subagents.retainFailedCleanup(parent, first)
        pending = ctx.subagents.start('queued-child', request).then(run => ({ run }), error => ({ error }))
        await entered.promise
        const bothHeldAtBarrier = !states.get(1).closed && !states.get(2).closed && starts === 2
        await assert.rejects(second.dispose(), /second response/)
        void ctx.subagents.retainFailedCleanup(parent, second)
        allowSecond = mode === 'recovered'
        release.resolve()
        const result = await pending
        if (result.run !== undefined) runs.push(result.run)
        const proof = { mode, bothHeldAtBarrier, refused: result.run === undefined, startsAfterWait: starts,
          secondAttemptsAfterWait: secondAttempts, secondOpenAfterWait: !states.get(2).closed }
        allowSecond = true
        if (result.run === undefined) runs.push(await ctx.subagents.start('queued-child', request))
        await Promise.all(runs.map(run => run.dispose()))
        Object.assign(proof, { closedBeforeDispatch, startsAfterRecovery: starts, allClosed: [...states.values()].every(state => state.closed) })
        await writeFile(join(process.cwd(), 'queued-cleanup-proof.json'), JSON.stringify(proof))
        const passed = bothHeldAtBarrier && proof.refused === (mode === 'refused') && proof.startsAfterWait === (mode === 'refused' ? 2 : 3)
          && proof.secondAttemptsAfterWait === 2 && proof.secondOpenAfterWait === (mode === 'refused')
          && closedBeforeDispatch && starts === 3 && proof.allClosed
        yield { type: 'block-end', index: 0, block: { type: 'text', text: passed ? 'QUEUED_CLEANUP_OK' : 'QUEUED_CLEANUP_FAILED' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        allowSecond = true
        release.resolve()
        const result = await pending
        if (result?.run !== undefined) runs.push(result.run)
        await Promise.allSettled(runs.map(run => run.dispose()))
        await Promise.all([...states.values()].map(stop))
      }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['queued-cleanup-fixture'], new Adapter()))
  ctx.provide('queuedCleanupReady', true)
}
