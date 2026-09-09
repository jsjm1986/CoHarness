import { expect, it } from 'vitest'
import { createWebConnectionRpc } from '../src/client/rpc.ts'

it.each([{ kind: 'personal' as const }, { kind: 'project' as const, projectId: 7 }])('routes generic RPC to its explicit runtime target (%j)', async (target) => {
  let sent: URL | undefined
  const rpc = createWebConnectionRpc(async (url, init) => {
    sent = url
    const body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
    const request = JSON.parse(body) as { rpcId: string }
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: 'ok' } }))
  }, target)
  await expect(rpc.call('/api', 'session.list', {})).resolves.toEqual({ ok: true, value: 'ok' })
  expect(sent?.searchParams.get('dshTarget')).toBe(target.kind === 'personal' ? 'personal' : 'project:7')
})
