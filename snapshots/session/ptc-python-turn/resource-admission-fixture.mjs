/** Observe real Loader/model/Python execution through an external node accountant. */
import assert from 'node:assert/strict'

export const name = 'python-resource-admission-fixture'

/** Supply permits while retaining every accepted completion through profile shutdown. */
export function apply(ctx) {
  const lifetime = new AbortController(), active = new Set()
  let probes = 0, programs = 0, closing = false
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('resourceBudget', { async acquire(request) {
    assert.equal(closing, false)
    request.signal?.throwIfAborted()
    if (request.kind === 'process') {
      if (request.origin === 'infrastructure') probes++
      else {
        const sessionId = request.sessionId ?? ctx.get('executionAuthority')?.current()?.parentSessionId
          ?? ctx.get('agents')?.currentInitiator()?.id
        assert.equal(typeof sessionId, 'string')
        assert.ok(sessionId.length > 0)
        if (request.sessionId !== undefined) programs++
      }
    }
    const completion = Promise.withResolvers()
    active.add(completion)
    await Promise.resolve()
    return {
      signal: lifetime.signal,
      async release() { active.delete(completion); completion.resolve() },
      async uncertain() { throw new Error('Python snapshot did not confirm managed process completion') },
    }
  } })
  ctx.effect(() => async () => {
    closing = true
    lifetime.abort(new Error('Python snapshot accountant disposed'))
    await Promise.all([...active].map(completion => completion.promise))
    assert.ok(probes >= 1, 'interpreter probe must acquire infrastructure admission')
    assert.ok(programs >= 1, 'Python program must acquire Session admission')
  })
}
