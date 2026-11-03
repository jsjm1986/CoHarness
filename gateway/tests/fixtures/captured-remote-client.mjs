/** Captured Client Remote calls over two real Gateway transports. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { registerHooks } from 'node:module'
import TypertRegistry from '../../../packages/typert/registry/lib/index.js'
import commandsRemote from '../../../packages/interaction/commands/lib/typert.remote-client.js'
import { createWebConnectionRpc } from '../../../packages/client/connection/lib/types/client/rpc.js'
import { clientSessionKey, parseClientSessionKey } from '../../../packages/host/apiproxy/lib/types/api/client-session.js'

/**
 * Verify destination capture, foreign-Session rejection and namespace withdrawal.
 * @param base - actual primary Gateway origin.
 * @param cookie - fixture account's authenticated cookie.
 * @param connection - existing browser-object transport directory.
 * @param primary - exact bootstrap Runtime.
 * @param secondary - exact remote Runtime.
 * @param sessionId - existing raw Session identity on the remote Runtime.
 * @returns after actual Remote catalog reads and fail-closed checks settle.
 */
export async function verifyCapturedRemote(base, cookie, connection, primary, secondary, sessionId) {
  const clientExports = registerHooks({ resolve(specifier, context, nextResolve) {
    return specifier === '@deepseek-ai/dsh-client-connection/client'
      ? { url: new URL('../../../packages/client/connection/lib/types/client/index.js', import.meta.url).href, shortCircuit: true }
      : nextResolve(specifier, context)
  } })
  let gateway
  try { gateway = await import('../../../packages/api/gateway/lib/types/client/index.js') }
  finally { clientExports.deregister() }
  const { apply, inject } = gateway
  const sends = []
  const transports = new Map([primary, secondary].map(target => {
    const owned = target === primary ? connection : connection.forTarget(target)
    assert.ok(owned)
    const rpc = createWebConnectionRpc(async (input, init) => {
      const url = new URL(input.pathname + input.search, base)
      sends.push({ runtimeId: target.runtimeId, path: url.pathname })
      const headers = new Headers(init.headers)
      headers.set('cookie', cookie); headers.set('origin', base)
      return fetch(url, { ...init, headers })
    }, target)
    return [target.runtimeId, { ...owned, rpc }]
  }))
  const root = transports.get(primary.runtimeId)
  Object.assign(root, {
    forTarget: target => transports.get(target.runtimeId),
    forSession: id => transports.get(parseClientSessionKey(id).runtime?.runtimeId ?? primary.runtimeId),
    mapRemoteArguments: (_endpoint, args) => typeof args.agentId === 'string'
      ? { ...args, agentId: parseClientSessionKey(args.agentId).sessionId } : args,
  })
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  ctx.provide('connection', root)
  try {
    await ctx.plugin({ inject, apply })
    const withdraw = await ctx.remote.$mount(commandsRemote)
    try {
      const remote = ctx.remote.$forTarget(secondary)
      assert.equal(remote.$forTarget(), remote)
      const local = ctx.remote.$forTarget()
      const key = clientSessionKey(secondary, sessionId)
      const list = remote.commands.list
      const result = await list(key)
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.ok(result.value.length > 0)
      assert.deepEqual(sends.map(item => item.runtimeId), [secondary.runtimeId])
      await assert.rejects(local.commands.list(key), /another Runtime|different Runtime/u)
      assert.equal(sends.length, 1)
      await withdraw()
      assert.equal((await list(key)).ok, false)
      assert.equal(sends.length, 1)
    } finally { await withdraw() }
  } finally { await ctx.fiber.dispose() }
}
