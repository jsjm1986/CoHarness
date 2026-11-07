/** Retain each browser control request's original real collaboration provider. */
import assert from 'node:assert/strict'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'
export const inject = ['tools', 'llm', 'workingDirectory', 'systemPrompt', 'sessionProjections']
export async function apply(ctx) {
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const load = relative => import(new URL(`../../../../../packages/${relative}/${face}`, import.meta.url))
  const scope = process.env.DSH_CONTROL_SCOPE
  assert.ok(['personal', 'project'].includes(scope))
  let endpoint, authorizationCalls = 0, replacements = 0
  await applyLoopbackServerEffect(ctx, {
    label: 'control-authorization', onListening: address => { endpoint = `http://127.0.0.1:${address.port}` },
    requestListener: async (request, response) => {
      try {
        const chunks = []
        for await (const bytes of request) chunks.push(bytes)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        assert.equal(request.url, '/internal/runtime/collaboration/authorize')
        assert.ok(['read', 'write'].includes(body.action))
        authorizationCalls++
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ access: { sessionId: body.sessionId, rootSessionId: 'control-authority',
          mode: 'rw', canRead: true, canWrite: true, canManage: false,
          ...(scope === 'project' ? { projectId: 41, visibility: 'project', creatorUserId: 7 } : {}) } }))
      } catch (error) { response.writeHead(500); response.end(String(error)) }
    },
  })
  const principal = { assertion: 'fixture-authority', claims: {
    version: 1, issuer: 'harness-gateway', audience: 'dsh-runtime', organization: 'fixture',
    user: { id: 7, username: 'alice', displayName: 'Alice', role: 'user' },
    scope: scope === 'personal' ? { kind: 'personal' } : { kind: 'project', projectId: 41, projectName: 'Shared', mode: 'rw' },
    runtime: scope === 'personal' ? { kind: 'personal', id: 7, generation: 1 } : { kind: 'project', id: 41, generation: 1 },
    issuedAt: Date.now(), expiresAt: Date.now() + 60_000, nonce: 'fixture-nonce',
  } }
  ctx.provide('gatewayRuntime', {
    requireCurrent: () => principal, sessionCreation: () => undefined,
    request: (path, init) => { assert.equal(init.principal, principal); return fetch(endpoint + path, init) },
  })
  await ctx.plugin((await load('subagent/subagent')).default)
  const Provider = (await load('context/collaboration-gateway')).default
  let provider = ctx.plugin(Provider)
  await provider.await()
  ctx.provide('controlAuthorityHost', {
    async replace() {
      const old = ctx.get('collaboration').capture()
      await provider.dispose()
      assert.equal(old.signal.aborted, true)
      provider = ctx.plugin(Provider)
      await provider.await()
      assert.equal(ctx.get('collaboration').capture().signal.aborted, false)
      replacements++
    },
    proof: () => ({ scope, replacements, authorizationCalls }),
  })
}
