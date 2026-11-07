/** Browser admission and Worker authorization share one origin policy. */

import WebSocket from 'ws'
import { expect, it } from 'vitest'
import { startInspector } from '../src/host/bridge/controller.ts'
import { parseInspectorClientBootstrap } from '../src/shared/bridge/control-codec.ts'
import { isInspectorClientOriginAllowed } from '../src/shared/web.ts'

const clientOrigins = ['https://inspector.local.example']
const origins = [
  ['http://localhost:4321', true],
  ['http://127.0.0.1:4321', true],
  ['http://[::1]:4321', true],
  ['https://inspector.local.example', true],
  ['https://harness.example', false],
  ['https://inspector.local.example.evil.example', false],
  ['null', false],
] as const

it.each(origins)('checks browser origin %s without changing its allowlist semantics', (origin, admitted) => {
  expect(isInspectorClientOriginAllowed(origin, clientOrigins)).toBe(admitted)
})

it('publishes the allowlist and keeps Worker token and origin authorization independent', async (test) => {
  const inspector = await startInspector({ port: 0, captureFetch: false, clientOrigins })
  test.onTestFinished(() => inspector.close())
  const bootstrap = inspector.endpoint.client
  expect(bootstrap.clientOrigins).toEqual(clientOrigins)
  expect(parseInspectorClientBootstrap(bootstrap)).toEqual(bootstrap)
  for (const [origin, admitted] of origins) {
    expect(await connectStatus(bootstrap.endpoint, bootstrap.protocol, origin)).toBe(admitted ? 101 : 403)
  }
  expect(await connectStatus(bootstrap.endpoint, bootstrap.protocol)).toBe(101)
  expect(await connectStatus(bootstrap.endpoint, 'wrong-token', clientOrigins[0])).toBe(403)
  expect(await connectStatus(bootstrap.endpoint, undefined, 'http://localhost')).toBe(403)
})

async function connectStatus(endpoint: string, protocol: string | undefined, origin?: string): Promise<number> {
  const socket = new WebSocket(endpoint, protocol, origin === undefined ? {} : { origin })
  const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
  try {
    return await new Promise<number>((resolve, reject) => {
      socket.once('open', () => { resolve(101) })
      socket.once('error', reject)
      socket.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
        socket.terminate()
      })
    })
  } finally {
    if (socket.readyState === WebSocket.OPEN) socket.close()
    else if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
    await closed
  }
}
