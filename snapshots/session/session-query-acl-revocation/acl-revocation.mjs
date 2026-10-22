/** Model an external participant ACL that revokes access after query admission. */
export const name = 'session-query-acl-revocation-fixture'
export const inject = ['agents', 'sessions']

/** Seed a real source Session and vary only the external readability response. */
export function apply(ctx) {
  let checks = 0
  ctx.provide('collaboration', {
    capture: () => ({
      readableSessionIds: async ids => new Set(++checks === 1 ? ids : []),
    }),
  })
  ctx.on('agent/created', async ({ agent }) => {
    const source = ctx.sessions.create('acl-source', {
      meta: { cwd: agent.session.header.cwd, parentSession: agent.id },
    })
    source.append('turn/start', { turn: 1 })
    source.append('user/message', {
      role: 'user',
      id: 'acl-source-message',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'PRIVATE_SOURCE_BODY' }],
    }, { surfaceOp: 'append' })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(source)
  })
}
