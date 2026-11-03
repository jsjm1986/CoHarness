/** Actual response streams distinguish unpublished startup rollback from holder-owned runs. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentCarrier } from '@deepseek-ai/dsh-agent'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'
export const inject = ['llm', 'agents', 'withdrawnAdmissionHost']
export async function apply(ctx) {
  const mode = process.env.DSH_WITHDRAWAL_ADMISSION
  assert.ok(['withdrawn', 'publishing', 'rollback-retry', 'holder'].includes(mode))
  const states = new Map(), entered = Promise.withResolvers(), release = Promise.withResolvers(), stopping = Promise.withResolvers()
  let endpoint, starts = 0, attempts = 0, providerSignal, startEvents = 0
  await applyLoopbackServerEffect(ctx, {
    label: 'withdrawal-admission-child', onListening: address => { endpoint = `http://127.0.0.1:${address.port}` }, onCleanup: () => {},
    requestListener: (request, response) => {
      const state = states.get(Number(request.url.slice(1)))
      assert.ok(state)
      state.responded = true
      response.once('close', () => { state.closed = true; state.closedSignal.resolve() })
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('owned child response')
    },
  })
  const stop = async state => {
    state.abort.abort()
    await state.read
    if (state.responded) await state.closedSignal.promise
  }
  ctx.effect(() => async () => { await Promise.all([...states.values()].map(stop)) })
  ctx.on('subagent/start', () => { startEvents++ }, { global: true })
  const { runtime, dispose, observeWithdrawal } = ctx.withdrawnAdmissionHost
  observeWithdrawal(() => { stopping.resolve() })
  runtime.registerProvider({ name: 'withdrawal-child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async spec => {
      providerSignal = spec.signal
      const id = ++starts, ready = Promise.withResolvers()
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
      if (mode === 'publishing' || mode === 'rollback-retry') { entered.resolve(); await release.promise }
      return { id: SessionId(`withdrawal-child-${id}`), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {
          attempts++
          if (mode === 'rollback-retry' && attempts === 1) throw new Error('native response rollback needs retry')
          await stop(state)
        } }
    } })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 }
    }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {})
      const parent = ctx.agents.get(options.sessionId)
      assert.ok(parent)
      const caller = new AbortController(), reason = new Error('holder cancellation')
      const request = { parent, signal: caller.signal, prompt: [{ type: 'text', text: 'bounded child' }] }
      let pending, unloading, held, closedAtWithdrawal, busyDuringWithdrawal = null, scopeCancellation = null, callerCancellationPreserved = null
      const closed = () => [...states.values()].every(state => state.closed)
      const withdraw = () => dispose().then(() => { closedAtWithdrawal = closed() })
      try {
        if (mode === 'withdrawn') await (unloading = withdraw())
        pending = runtime.start('withdrawal-child', request).then(run => ({ run }), error => ({ error }))
        let liveAtBarrier
        if (mode === 'publishing' || mode === 'rollback-retry') {
          await entered.promise
          liveAtBarrier = starts === 1 && !states.get(1).closed
          unloading = withdraw()
          await stopping.promise
          scopeCancellation = providerSignal.aborted
          busyDuringWithdrawal = ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent }) === 'busy'
          release.resolve()
        }
        const result = await pending
        held = result.run
        if (mode === 'holder') {
          liveAtBarrier = starts === 1 && !states.get(1).closed
          await (unloading = withdraw())
          scopeCancellation = providerSignal.aborted
          caller.abort(reason)
          callerCancellationPreserved = providerSignal.reason === reason
          await held.dispose()
        }
        await unloading
        const proof = { mode, starts, rejected: result.error?.code === 'DRAINING',
          liveAtBarrier: mode === 'withdrawn' ? starts === 0 : liveAtBarrier, scopeCancellation,
          busyDuringWithdrawal, closedAtWithdrawal, callerCancellationPreserved, attempts, startEvents, allClosed: closed() }
        await writeFile(join(process.cwd(), 'withdrawal-admission-proof.json'), JSON.stringify(proof))
        const holder = mode === 'holder'
        const passed = proof.rejected === !holder && proof.liveAtBarrier && proof.allClosed
          && starts === (mode === 'withdrawn' ? 0 : 1) && startEvents === (holder ? 1 : 0)
          && attempts === (mode === 'withdrawn' ? 0 : mode === 'rollback-retry' ? 2 : 1)
          && closedAtWithdrawal === !holder && (holder ? scopeCancellation === false && callerCancellationPreserved
            : mode === 'withdrawn' || scopeCancellation && busyDuringWithdrawal)
        yield { type: 'block-end', index: 0, block: { type: 'text', text: passed ? 'WITHDRAWAL_ADMISSION_OK' : 'WITHDRAWAL_ADMISSION_FAILED' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        release.resolve()
        held ??= (await pending)?.run
        if (held !== undefined) await Promise.allSettled([held.dispose()])
        await unloading
        await Promise.all([...states.values()].map(stop))
      }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['withdrawn-admission-cleanup-fixture'], new Adapter()))
  ctx.provide('withdrawnAdmissionReady', true)
}
