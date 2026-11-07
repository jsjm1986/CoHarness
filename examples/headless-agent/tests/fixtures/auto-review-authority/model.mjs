/** Actual SDK tool reviews with controllable execution authority and model transport. */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { appendFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ExecutionAuthority } from '@deepseek-ai/dsh-execution-authority'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

export const inject = ['llm', 'tools', 'permissionPresets', 'sessions', 'workingDirectory', 'loader']

/** Install external-service controls while the shipped SDK, loop and permission gate execute. */
export async function apply(ctx) {
  const phase = process.env.DSH_AUTO_AUTHORITY_PHASE
  const change = process.env.DSH_AUTO_AUTHORITY_CHANGE
  assert.ok(['directory', 'grant', 'physical', 'response', 'adoption', 'none'].includes(phase))
  assert.ok(['revoke', 'replace', 'adopt', 'none'].includes(change))
  const execution = new AsyncLocalStorage()
  ctx.effect(() => () => { execution.disable() })
  const state = { revision: 'same-revision', scopeId: '10000000-0000-4000-8000-000000000042',
    inputs: ['10000000-0000-4000-8000-000000000043'], actors: [{ userId: 42 }], primaryActorUserId: 42, unverifiedHistory: false }
  let allowed = true, replacementAuthorizations = 0, captured = 0, physical = 0, reviews = 0, executed = 0, primary = 0
  let reviewing = false, paused = false
  const admissions = [], requests = new Map(), tools = []
  class Authority extends ExecutionAuthority {
    constructor(context, replacement = false) { super(context); this.replacement = replacement }
    current() { return execution.getStore()?.scope }
    runCaptured(agent, scope, work) { captured++; return execution.run({ agent, scope }, work) }
    async authorize(capability, agent, signal, pending) {
      assert.equal(capability, 'auto-review')
      assert.equal(pending.agent.session, agent.session)
      signal?.throwIfAborted()
      if (this.replacement) replacementAuthorizations++
      if (!allowed) throw new Error('Auto qualification revoked')
      return structuredClone(state)
    }
    async authorizeSelection() { if (!allowed) throw new Error('Auto qualification revoked') }
  }
  ctx.provide('executionAuthorityRequired', phase !== 'adoption')
  const issuer = phase === 'adoption' ? undefined : ctx.plugin(Authority)
  if (issuer !== undefined) await issuer
  const pause = async () => {
    if (paused) return
    paused = true
    const pending = join(process.cwd(), 'review-pending.json')
    await writeFile(pending + '.tmp', JSON.stringify({ phase, change }))
    await rename(pending + '.tmp', pending)
    const deadline = AbortSignal.timeout(50_000)
    while (!existsSync(join(process.cwd(), 'review-continue'))) await delay(10, undefined, { signal: deadline })
    if (change === 'revoke') allowed = false
    else if (change === 'replace') { await issuer.dispose(); await ctx.plugin(Authority, true) }
    else if (change === 'adopt') { const authority = ctx.plugin(Authority); await authority; await authority.dispose() }
  }
  if (phase === 'directory') {
    const service = ctx.workingDirectory, ensure = service.ensure
    ctx.effect(() => {
      service.ensure = async (...args) => {
        const cwd = await ensure.apply(service, args)
        if (reviewing) await pause()
        return cwd
      }
      return () => { service.ensure = ensure }
    })
  }
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('resourceBudget', {
    async acquire(request) {
      const admission = { origin: request.origin, released: false }
      admissions.push(admission)
      if (request.origin === 'execution' && phase === 'grant') await pause()
      return { signal: new AbortController().signal,
        release: async () => { assert.equal(admission.released, false); admission.released = true },
        uncertain: async () => { throw new Error('Auto fixture must settle all model permits') } }
    },
  })
  ctx.on('session/created', session => { ctx.permissionPresets.set(session, 'auto') })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'auto-review/request') requests.set(session.id, event.data.request)
    if (event.type === 'tool/call') reviewing = true
    if (event.type === 'tool/result') tools.push(event.data)
  })
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'reviewed_probe', description: 'Write the owned fixture file', parameters: {},
    async execute() {
      await appendFile(join(process.cwd(), 'reviewed.txt'), 'reviewed\n')
      executed++
      return [{ type: 'text', text: 'reviewed file written' }]
    },
  })))
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    let fallback
    if (phase === 'adoption') {
      const entry = [...ctx.loader.entries()].find(value => value.options.name === '@deepseek-ai/dsh-experimental-auto-review')
      assert.ok(entry?.fiber)
      await entry.fiber.dispose()
      fallback = ctx.permissionPresets.current(agent.session)
    }
    await writeFile(join(process.cwd(), 'review-observation.json'), JSON.stringify({ phase, change, captured,
      reviews, physical, executed, primary, replacementAuthorizations,
      modelAdmissions: admissions.length, executionAdmissions: admissions.filter(value => value.origin === 'execution').length,
      released: admissions.filter(value => value.released).length,
      denialCodes: tools.flatMap(value => value.error?.code === undefined ? [] : [value.error.code]),
      ...fallback === undefined ? {} : { fallback },
    }))
  })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options, dispatchRequest) {
      if (options.purpose === 'auto-review') {
        reviews++
        const { sessionId, signal: _signal, purpose: _purpose, resourceOrigin: _origin, executionIdentity, ...request } = options
        assert.deepEqual(JSON.parse(JSON.stringify(requests.get(sessionId))), JSON.parse(JSON.stringify(request)))
        assert.deepEqual(executionIdentity, phase === 'adoption' ? undefined : { inputs: state.inputs, primaryActorUserId: 42 })
        if (phase === 'physical') await pause()
        await dispatchRequest(async () => { physical++ })
        if (phase === 'response' || phase === 'adoption') await pause()
      } else if (primary++ === 0) {
        const id = ToolCallId('owned-review-call'), name = 'reviewed_probe', args = '{}'
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const text = options.purpose === 'auto-review' ? '{"risk":"low","decision":"allow"}' : 'AUTO_AUTHORITY_DONE'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['auto-authority'], new Adapter()))
  ctx.provide('autoAuthorityReady', true)
}
