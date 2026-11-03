/** External node accountant around the shipped MCP resource profile and real stdio processes. */
import assert from 'node:assert/strict'

export const name = 'mcp-resource-admission-fixture'

/** Retain permits until their real consumers report completion during profile shutdown. */
export function apply(ctx) {
  const lifetime = new AbortController(), active = new Set()
  let processes = 0, closing = false
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('resourceBudget', { async acquire(request) {
    assert.equal(closing, false)
    request.signal?.throwIfAborted()
    if (request.kind === 'process') {
      assert.equal(request.origin, 'infrastructure')
      processes++
    }
    const completion = Promise.withResolvers()
    active.add(completion)
    await Promise.resolve()
    return {
      signal: lifetime.signal,
      async release() { active.delete(completion); completion.resolve() },
      async uncertain() { throw new Error('MCP resource snapshot did not confirm process completion') },
    }
  } })
  ctx.effect(() => async () => {
    closing = true
    lifetime.abort(new Error('MCP snapshot accountant disposed'))
    await Promise.all([...active].map(completion => completion.promise))
    assert.ok(processes >= 2, 'MCP discovery and serving processes must both acquire admission')
  })
}
