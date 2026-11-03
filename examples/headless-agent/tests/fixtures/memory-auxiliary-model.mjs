/** Real auxiliary request logging and resource ownership shared by both SDK fixtures. */
import assert from 'node:assert/strict'

export const inject = ['llm', 'memory', 'agents']

/** Install the model, tracked permits, and a completion record after durable curation. */
export async function apply(ctx) {
  const { LlmAdapter } = await import('@deepseek-ai/dsh-llm')
  const { appendPluginRecord } = await import('@deepseek-ai/dsh-session')
  const admissions = [], latest = new Map()
  const recallComplete = Promise.withResolvers()
  // The primary stream reports an auxiliary assertion failure instead of waiting forever.
  void recallComplete.promise.catch(() => {})
  ctx.provide('resourceBudget', {
    async acquire(request) {
      const admission = { origin: request.origin, released: false }
      assert.equal(request.kind, 'model')
      assert.equal(typeof request.sessionId, 'string')
      admissions.push(admission)
      return {
        signal: new AbortController().signal,
        release: async () => { admission.released = true },
        uncertain: async () => { throw new Error('Memory fixture retained an uncertain model permit') },
      }
    }
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'memory/recall-request' || event.type === 'memory/curation-request') {
      latest.set(session.id, event)
    }
  })
  ctx.on('domain/changed', (change) => {
    if (change.domain !== 'memory' || change.table !== 'cursors' || change.key !== 'consolidation-personal') return
    if (change.value?.changedSince !== 0) return
    const agent = ctx.agents.roots()[0]
    if (agent === undefined) throw new Error('Memory SDK fixture lost its Agent')
    assert.equal(admissions.length, 4)
    assert(admissions.every(admission => admission.released))
    appendPluginRecord(agent.session, 'plugin:memory-fixture/complete', {
      modelAdmissions: admissions.length,
      executionAdmissions: admissions.filter(admission => admission.origin === 'execution').length,
      quiescent: admissions.filter(admission => admission.released).length,
    })
  })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model,
        reasoning: { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' } }
    }
    async *stream(options) {
      let text = 'MEMORY_DONE'
      if (options.purpose === 'memory') {
        try {
          const event = latest.get(options.sessionId)
          assert(event, 'Memory request must be durable before adapter dispatch')
          const { sessionId: _session, signal: _signal, purpose: _purpose,
            resourceOrigin: _origin, executionIdentity: _identity, ...request } = options
          assert.deepEqual(JSON.parse(JSON.stringify(event.data.request)), JSON.parse(JSON.stringify(request)))
          // Conversation admission can follow recall admission before its adapter dispatches.
          assert.equal(admissions.filter(admission => !admission.released && admission.origin === 'execution').length, 1)
          if (event.type === 'memory/recall-request') {
            text = '{"keys":[]}'
            recallComplete.resolve()
          } else text = 'no memories saved'
        } catch (error) {
          recallComplete.reject(error)
          throw error
        }
      } else await recallComplete.promise
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['memory-fixture'], new Adapter()))
  if (await ctx.memory.read({ kind: 'personal' }, 'release-freeze') === undefined) {
    const saved = await ctx.memory.memberSave({ scope: { kind: 'personal' }, key: 'release-freeze',
      kind: 'background', summary: 'Friday release freeze', content: 'Do not deploy on Fridays.' })
    assert(saved.ok, 'Memory SDK fixture must seed its real JSON domain')
  }
  ctx.provide('memoryAuxiliaryReady', true)
}
