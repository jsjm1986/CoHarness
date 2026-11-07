/** Project curation keeps its issuer and qualification through actual SDK model admission and tool rounds. */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { memoryConsolidationCursorKey, memoryExtractionCursorKey } from '@deepseek-ai/dsh-memory'

export const name = 'memory-authority-model'
export const inject = ['llm', 'memory']

/** Publish a JSON marker atomically: the spec polls existsSync, so a plain writeFile exposes an empty window. */
const publishMarker = async (file, value) => {
  await writeFile(`${file}.tmp`, JSON.stringify(value))
  await rename(`${file}.tmp`, file)
}

export async function apply(ctx) {
  const kind = process.env.DSH_MEMORY_AUTHORITY_KIND
  const change = process.env.DSH_MEMORY_AUTHORITY_CHANGE
  const phase = process.env.DSH_MEMORY_AUTHORITY_PHASE
  assert.ok(kind === 'extraction' || kind === 'consolidation')
  assert.ok(change === 'revocation' || change === 'replacement')
  assert.ok(phase === 'grant' || phase === 'tool-read' || phase === 'cursor')
  const execution = new AsyncLocalStorage()
  const latest = new Map()
  let allowed = true, admitted = 0, released = 0, memoryRequests = 0, replacementAuthorizations = 0
  let issuer, removeIssuer, holdAuthorization = false, holding
  const holdingEntered = Promise.withResolvers(), holdingRelease = Promise.withResolvers()
  ctx.effect(() => () => { holdingRelease.resolve() })
  const finish = async agent => {
    if (holding !== undefined) {
      const outcome = await holding
      assert.ok(outcome.error instanceof Error)
      assert.match(outcome.error.message, /revoked|authorization changed/i)
    }
    const key = kind === 'extraction' ? memoryExtractionCursorKey(agent.id) : memoryConsolidationCursorKey({ kind: 'project' })
    const cursor = await ctx.memory.getCursor(key)
    const owner = await ctx.memory.memberRead({ scope: { kind: 'project' }, key: 'release-rule' })
    await publishMarker(join(process.cwd(), 'authority-observation.json'), {
      kind, change, phase, admitted, released, memoryRequests, replacementAuthorizations,
      cursorAdvanced: kind === 'extraction' ? cursor !== undefined : cursor?.lastRunAt !== undefined,
      ownerContent: owner?.content, loggedBeforeDispatch: true,
    })
  }
  const authority = {
    capture: agent => ({ parentSessionId: agent.id, inputs: [], unverifiedHistory: false, primaryActorUserId: 42 }),
    current: () => execution.getStore()?.scope,
    runCaptured: (agent, scope, work) => execution.run({ agent, scope }, () => Promise.resolve().then(work).finally(() => finish(agent))),
    async authorize(capability) {
      if (holdAuthorization) {
        holdAuthorization = false
        holdingEntered.resolve()
        await holdingRelease.promise
      }
      if (capability === 'memory' && !allowed) throw new Error('Project memory qualification revoked')
      return { revision: 'fixture-current', inputs: [], actors: [{ userId: 42 }], primaryActorUserId: 42, unverifiedHistory: false }
    },
  }
  issuer = authority
  removeIssuer = ctx.provide('executionAuthority', issuer)
  ctx.provide('executionAuthorityRequired', true)
  const withdraw = async () => {
    if (change === 'revocation') allowed = false
    else {
      removeIssuer()
      issuer = { ...authority, async authorize() {
        replacementAuthorizations++
        return { revision: 'fixture-replacement', inputs: [], actors: [{ userId: 77 }], primaryActorUserId: 77, unverifiedHistory: false }
      } }
      removeIssuer = ctx.provide('executionAuthority', issuer)
    }
    await issuer.authorize('execute')
    replacementAuthorizations = 0
    await publishMarker(join(process.cwd(), 'authority-pending.json'), { kind, change, phase, executeAllowed: true })
    const deadline = AbortSignal.timeout(50_000)
    while (!existsSync(join(process.cwd(), 'authority-continue'))) await delay(10, undefined, { signal: deadline })
  }
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('resourceBudget', {
    async acquire() {
      admitted++
      if (phase === 'grant' && admitted === 2) await withdraw()
      return { signal: new AbortController().signal, release: async () => { released++ },
        uncertain: async () => { throw new Error('Authority fixture retained an uncertain permit') } }
    },
  })
  // Generic model execution stays available independently of memory qualification.
  ctx.on('llm/pre-dispatch', async (_options, next) => { await ctx.executionAuthority.authorize('execute'); await next() }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'memory/curation-request') latest.set(session.id, event)
  })
  if (phase === 'tool-read') {
    const read = ctx.memory.read.bind(ctx.memory)
    ctx.effect(() => {
      ctx.memory.read = async (...args) => { const result = await read(...args); await withdraw(); return result }
      return () => { ctx.memory.read = read }
    })
  }
  if (phase === 'cursor') {
    const method = kind === 'extraction' ? 'writeCursor' : 'writeCursorIfUnchanged'
    const write = ctx.memory[method].bind(ctx.memory)
    ctx.effect(() => {
      ctx.memory[method] = async (...args) => {
        const result = write(...args)
        try { await withdraw() }
        finally { holdingRelease.resolve() }
        return result
      }
      return () => { ctx.memory[method] = write }
    })
  }
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      if (options.purpose === 'memory') {
        memoryRequests++
        const event = latest.get(options.sessionId)
        assert.ok(event?.data.kind === kind)
        const { sessionId: _session, signal: _signal, purpose: _purpose,
          resourceOrigin: _origin, executionIdentity, ...request } = options
        assert.deepEqual(executionIdentity, { inputs: [], primaryActorUserId: 42 })
        assert.deepEqual(JSON.parse(JSON.stringify(event.data.request)), JSON.parse(JSON.stringify(request)))
        if (phase === 'cursor') {
          holdAuthorization = true
          holding = ctx.memory.save({ scope: { kind: 'project' }, key: 'holding', kind: 'guidance', summary: 'Holding', content: 'Owned write' },
            { kind: 'agent', agent: execution.getStore().agent }).then(value => ({ value }), error => ({ error }))
          await holdingEntered.promise
        }
        if (phase === 'tool-read' && memoryRequests === 1) {
          const id = ToolCallId('project-read'), name = 'memory_read', args = '{"key":"release-rule"}'
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
      }
      const text = options.purpose === 'memory' ? 'no memories saved' : 'AUTHORITY_PRIMARY_DONE'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['memory-curation-authority'], new Adapter()))
  const saved = await ctx.memory.memberSave({ scope: { kind: 'project' }, key: 'release-rule', kind: 'guidance',
    summary: 'Release policy', content: 'PRIVATE_PROJECT_MEMORY' })
  assert.equal(saved.ok, true)
  ctx.provide('memoryAuthorityFixtureReady', true)
}
