import { expect, it } from 'vitest'
import { createWebConnectionRpc } from '../src/client/rpc.ts'

it.each([{ kind: 'personal' as const }, { kind: 'project' as const, projectId: 7 }])('routes generic RPC to its explicit runtime target (%j)', async (target) => {
  let sent: URL | undefined
  const rpc = createWebConnectionRpc(async (url, init) => {
    sent = url
    const request = JSON.parse(init.body as string) as { rpcId: string }
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: 'ok' } }))
  }, target)
  await expect(rpc.call('/api', 'session.list', {})).resolves.toEqual({ ok: true, value: 'ok' })
  expect(sent?.searchParams.get('dshTarget')).toBe(target.kind === 'personal' ? 'personal' : 'project:7')
})


it.each([undefined, { kind: 'personal' as const }, { kind: 'project' as const, projectId: 7 }])('routes read streams through the same authenticated runtime target (%j)', async (target) => {
  let sent: URL | undefined
  const rpc = createWebConnectionRpc(async (url, init) => {
    sent = url
    expect(init.method).toBe('POST')
    const request = JSON.parse(init.body as string) as { rpcId: string; method: string; payload: unknown }
    expect(request.method).toBe('terminal/retain')
    expect(request.payload).toEqual({ args: { sessionId: 'session-a', id: 'terminal-a' } })
    return new Response([
      JSON.stringify({ rpcId: request.rpcId, type: 'result', result: { ok: true, value: 'held' } }),
      JSON.stringify({ rpcId: request.rpcId, type: 'end' }), '',
    ].join('\n'), { headers: { 'content-type': 'application/x-ndjson' } })
  }, target)
  const values: unknown[] = []
  for await (const value of rpc.stream!('/api', 'terminal/retain', { args: { sessionId: 'session-a', id: 'terminal-a' } }, new AbortController().signal)) values.push(value)
  expect(values).toEqual([{ ok: true, value: 'held' }])
  expect(sent?.pathname).toBe('/api/_stream/terminal/retain')
  expect(sent?.searchParams.get('dshTarget')).toBe(target === undefined ? null : target.kind === 'personal' ? 'personal' : 'project:7')
  expect(() => rpc.stream!('/other', 'terminal/retain', {}, new AbortController().signal)).toThrow('shared /api channel')
  expect(() => rpc.stream!('/api', '../retain', {}, new AbortController().signal)).toThrow('invalid RPC target')
})
