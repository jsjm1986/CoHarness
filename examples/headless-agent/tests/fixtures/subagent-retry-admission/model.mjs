/** Exact-parent cleanup gates native child allocation and observes provider replacement. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentCarrier } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'

export const inject = ['llm', 'agents', 'subagents', 'tools', 'systemPrompt', 'sessionProjections', 'workingDirectory']

/** Own external child transports while exercising the normal delegation Consumer. */
export async function apply(ctx) {
  const mode = process.env.DSH_SUBAGENT_RETRY
  assert.ok(['published', 'catalog', 'replacement'].includes(mode))
  const transports = []
  let endpoint, starts = 0, allowCleanup = false
  await applyLoopbackServerEffect(ctx, {
    label: 'subagent-retry-admission-transport', onCleanup: () => {},
    onListening: address => { endpoint = `http://127.0.0.1:${address.port}` },
    requestListener: (request, response) => {
      const state = transports[Number(request.url.slice(1))]
      assert.ok(state)
      state.open = true
      response.once('close', () => { state.closed = true; state.close.resolve() })
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('owned child transport')
    },
  })
  const stop = async state => {
    state.abort.abort()
    await Promise.allSettled([state.work])
    if (state.open) await state.close.promise
  }
  ctx.effect(() => async () => { await Promise.all(transports.map(stop)) })
  const start = async () => {
    const ordinal = ++starts
    const state = { abort: new AbortController(), close: Promise.withResolvers(), open: false, closed: false }
    const index = transports.push(state) - 1, ready = Promise.withResolvers()
    state.work = (async () => {
      try {
        const response = await fetch(`${endpoint}/${index}`, { signal: state.abort.signal })
        for await (const chunk of response.body) { assert.ok(chunk.length > 0); ready.resolve() }
      } catch (error) { if (!state.abort.signal.aborted) { ready.reject(error); throw error } }
    })()
    void state.work.catch(() => { /* readiness and owned transport cleanup observe this failure */ })
    await ready.promise
    return { id: SessionId(`retry-child-${ordinal}`), localAgent: undefined,
      result: Promise.resolve({ output: [{ type: 'text', text: 'child answer' }], stopReason: 'completed' }),
      dispose: async () => {
        if (!allowCleanup) throw new Error('child transport cleanup unconfirmed')
        await stop(state)
      } }
  }
  const provider = startRun => ({ name: 'retry-child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }, start: startRun })
  let removeProvider = ctx.subagents.registerProvider(provider(start))
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  await ctx.plugin(await import(new URL(`../../../../../packages/subagent/tool-subagent/${face}`, import.meta.url)), {
    provider: 'retry-child', backgroundMode: 'one-shot', maxDepth: 'provider-managed',
  })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 }
    }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {})
      const parent = ctx.agents.get(options.sessionId)
      assert.ok(parent)
      const call = ordinal => ctx.tools.execute({ name: 'subagent', callId: ToolCallId(`retry-${ordinal}`),
        signal: new AbortController().signal, arguments: { description: 'retained child', prompt: 'work' }, agent: parent })
      const originalAppend = parent.session.append, directory = ctx.workingDirectory, originalEnsure = directory.ensure
      let proof
      try {
        if (mode === 'replacement') {
          const preparing = Promise.withResolvers(), ready = Promise.withResolvers()
          directory.ensure = async (...args) => {
            const cwd = await originalEnsure.call(directory, ...args)
            preparing.resolve()
            await ready.promise
            return cwd
          }
          const pending = call(1)
          try {
            await preparing.promise
            removeProvider()
            let currentStarts = 0
            removeProvider = ctx.subagents.registerProvider(provider(async () => { currentStarts++; return start() }))
            ready.resolve()
            const refused = await pending
            proof = { mode, obsoleteProviderRefused: refused.isError === true, obsoleteAllocations: starts,
              replacementAllocationsBeforeRetry: currentStarts }
            directory.ensure = originalEnsure
            allowCleanup = true
            const current = await call(2)
            Object.assign(proof, { currentSucceeded: current.isError !== true, currentStarts })
          } finally { ready.resolve(); directory.ensure = originalEnsure; await pending }
        } else {
          if (mode === 'catalog') {
            let failCatalog = true
            parent.session.append = function(type, ...args) {
              if (type === 'subagent/catalog' && failCatalog) { failCatalog = false; throw new Error('catalog storage unavailable') }
              return originalAppend.call(this, type, ...args)
            }
          }
          const first = await call(1)
          parent.session.append = originalAppend
          const firstTransport = transports[0]
          assert.ok(firstTransport)
          proof = { mode, firstFailed: first.isError === true, resourceRetained: firstTransport.open && !firstTransport.closed,
            ownerBusy: ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent }) === 'busy' }
          const blocked = await call(2)
          Object.assign(proof, { anotherAdmissionRefused: blocked.isError === true, allocationsBeforeCleanup: starts })
          allowCleanup = true
          const after = await call(3)
          Object.assign(proof, { nextSucceeded: after.isError !== true, oldTransportClosed: firstTransport.closed,
            allocationsAfterCleanup: starts,
            ownerReleased: ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent }) !== 'busy' })
        }
        await writeFile(join(process.cwd(), 'subagent-retry-proof.json'), JSON.stringify(proof))
        const passed = mode === 'replacement'
          ? proof.obsoleteProviderRefused && proof.obsoleteAllocations === 0 && proof.replacementAllocationsBeforeRetry === 0
            && proof.currentSucceeded && proof.currentStarts === 1
          : proof.firstFailed && proof.resourceRetained && proof.ownerBusy && proof.anotherAdmissionRefused
            && proof.allocationsBeforeCleanup === 1 && proof.nextSucceeded && proof.oldTransportClosed
            && proof.allocationsAfterCleanup === 2 && proof.ownerReleased
        yield { type: 'block-end', index: 0, block: { type: 'text', text: passed ? 'SUBAGENT_RETRY_OK' : 'SUBAGENT_RETRY_FAILED' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        parent.session.append = originalAppend
        directory.ensure = originalEnsure
        allowCleanup = true
        await Promise.all(transports.map(stop))
      }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['subagent-retry-fixture'], new Adapter()))
  ctx.provide('subagentRetryAdmissionReady', true)
}
