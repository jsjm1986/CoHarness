import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { PeerBackupRelay } from '../src/peer-backup-relay.ts'
import { PeerBackupError, PEER_REPOSITORY_PREFIX, type PeerRepositoryGrant } from '../src/peer-backup-repository.ts'
import { NODE_SERVICE_TARGET_HEADER } from '../src/node-service-stream.ts'
import { loadNodeServiceConfig } from '../src/node-service.ts'

const stop: Array<() => Promise<void>> = []
function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(async () => {
  for (const release of stop.splice(0).reverse()) await release()
})
async function listen(server: Server) {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  stop.push(
    () =>
      new Promise<void>((ok, fail) => {
        server.closeAllConnections()
        server.close((e) => {
          if (e) fail(e)
          else ok()
        })
      }),
  )
  const result = server.address()
  if (!result || typeof result === 'string') throw new Error('no TCP listener')
  return result.port
}

it('reuses the enrolled node connection, drops user credentials and cancels an already flowing upload on revocation', async () => {
  const node = randomUUID(),
    policy = randomUUID()
  const arrived = barrier(),
    upstreamClosed = barrier()
  let served = 0,
    allowed = true,
    opened = 0,
    validated = 0,
    borrowedChecks = 0
  const target = createServer((req, res) => {
    served++
    expect(req.headers.cookie).toBeUndefined()
    expect(req.headers['x-dsh-gateway-principal']).toBeUndefined()
    expect(req.headers['x-dsh-runtime-id']).toBeUndefined()
    expect(req.headers.authorization).toBe('Basic synthetic')
    expect(req.headers[NODE_SERVICE_TARGET_HEADER]).toBe(node)
    res.setHeader(NODE_SERVICE_TARGET_HEADER, node)
    if (req.method === 'POST') {
      req.once('data', () => {
        arrived.resolve()
      })
      req.once('close', () => {
        upstreamClosed.resolve()
      })
      req.on('error', () => {})
    } else res.end('encrypted object')
  })
  const targetPort = await listen(target)
  const relay = new PeerBackupRelay(
    {
      capacity: () => 'available',
      open: async () => {
        opened++
        return connect(targetPort, '127.0.0.1')
      },
      revalidate: async () => {
        borrowedChecks++
      },
      released: async () => {},
    },
    loadNodeServiceConfig({}),
    30000,
  )
  stop.push(() => relay.close())
  const grant: PeerRepositoryGrant = {
    organizationId: randomUUID(),
    policyId: policy,
    scopeId: randomUUID(),
    sourceNodeId: randomUUID(),
    targetNodeId: node,
    mode: 'append',
    quotaBytes: 16 << 20,
    revision: 1,
    revalidate: async () => {
      validated++
      if (!allowed) throw new PeerBackupError(403, 'peer-backup/pair-denied')
    },
  }
  const primary = createServer((req, res) => {
    void relay.forward(req, res, grant).catch((error) => {
      if (!res.headersSent && !res.destroyed) res.writeHead(error instanceof PeerBackupError ? error.status : 503).end()
      else res.destroy()
    })
  })
  const primaryPort = await listen(primary),
    url = 'http://127.0.0.1:' + primaryPort + PEER_REPOSITORY_PREFIX + policy + '/config'
  const headers = {
    authorization: 'Basic synthetic',
    cookie: 'fake-browser-cookie',
    'x-dsh-gateway-principal': 'forbidden',
    'x-dsh-runtime-id': 'forbidden',
  }
  for (let i = 0; i < 2; i++) expect(await (await fetch(url, { headers })).text()).toBe('encrypted object')
  expect(opened).toBe(1)
  expect(borrowedChecks).toBe(1)
  expect(validated).toBe(4)
  const body = new TransformStream<Uint8Array, Uint8Array>(),
    writer = body.writable.getWriter()
  const abort = new AbortController()
  const request = fetch(url, {
    method: 'POST',
    headers,
    body: body.readable,
    duplex: 'half',
    signal: abort.signal,
  } as RequestInit)
  const outcome = Promise.allSettled([request])
  try {
    await writer.write(new Uint8Array([1, 2, 3]))
    await arrived.promise
    allowed = false
    relay.invalidate(policy)
    await upstreamClosed.promise
    expect((await fetch(url, { headers })).status).toBe(403)
    expect(served).toBe(3)
  } finally {
    abort.abort()
    await writer.abort().catch(() => {})
    await outcome
  }
})
