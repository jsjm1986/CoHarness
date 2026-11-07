/** Native renewal I/O settles before its service-owned pool reports quiescence. */
import { generateKeyPairSync, sign } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import GatewayRuntime, { verifyGatewayPrincipal, type GatewayPrincipalClaims, type GatewayRuntimeCredential } from '../src/index.ts'
import type { StreamPrincipalLeasePool } from '../src/stream-principal-leases.ts'

it('awaits the native renewal body read before completing pool disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-renewal-io-'))
  const bodyReading = Promise.withResolvers<undefined>()
  const rawSettled = Promise.withResolvers<undefined>()
  void bodyReading.promise.catch(() => { /* cleanup may reject readiness after setup failure */ })
  const serverTasks: Promise<void>[] = []
  const serverErrors: unknown[] = []
  let bodyReads = 0
  let rawFinished = false
  let rawStarted = false
  let readSignal: AbortSignal | undefined
  const server = createServer((request, response) => {
    const task = (async () => {
      for await (const _chunk of request) { /* consume the private batch body */ }
      const closed = once(response, 'close')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"version":1,"leases":[')
      await closed
    })()
    serverTasks.push(task.catch((error: unknown) => { serverErrors.push(error) }))
  })
  const previousFile = process.env.DSH_GATEWAY_CREDENTIAL_FILE
  const previousFd = process.env.DSH_GATEWAY_CREDENTIAL_FD
  const ctx = new Context()
  const nativeFetch = globalThis.fetch
  let restoreFetch: (() => void) | undefined
  let closing: Promise<void> | undefined
  const cleanup = (): Promise<void> => {
    closing ??= (async () => {
      bodyReading.reject(new Error('renewal I/O fixture closed before readiness'))
      try {
        await ctx.fiber.dispose()
        if (rawStarted) await rawSettled.promise
      } finally {
        restoreFetch?.()
        if (previousFile === undefined) delete process.env.DSH_GATEWAY_CREDENTIAL_FILE
        else process.env.DSH_GATEWAY_CREDENTIAL_FILE = previousFile
        if (previousFd === undefined) delete process.env.DSH_GATEWAY_CREDENTIAL_FD
        else process.env.DSH_GATEWAY_CREDENTIAL_FD = previousFd
        const closed = server.listening ? new Promise<void>((resolve, reject) => {
          server.close((error) => { if (error === undefined) resolve(); else reject(error) })
        }) : Promise.resolve()
        server.closeAllConnections()
        try { await Promise.all([closed, ...serverTasks]) }
        finally { await rm(root, { recursive: true, force: true }) }
      }
    })()
    return closing
  }
  onTestFinished(cleanup)
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('renewal fixture did not acquire a TCP listener')
    const origin = `http://127.0.0.1:${String(address.port)}`
    const pair = generateKeyPairSync('ed25519')
    const credential: GatewayRuntimeCredential = {
      version: 1, gatewayUrl: origin, organization: 'stream-fixture',
      runtime: { kind: 'user', id: 7, generation: 2 }, token: 'fixture-runtime-token',
      principalPublicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      streamPrincipalRenewal: { enabled: true, intervalMs: 10, requestTimeoutMs: 5000, maxBatchSize: 2 },
    }
    const file = join(root, 'credential.json')
    await writeFile(file, JSON.stringify(credential), { mode: 0o600 })
    process.env.DSH_GATEWAY_CREDENTIAL_FILE = file
    delete process.env.DSH_GATEWAY_CREDENTIAL_FD
    ctx.provide('connection', {} as never)
    await ctx.plugin(GatewayRuntime).await()

    // The observers return native promises unchanged, including cancellation.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((...args) => {
      const pending = nativeFetch(...args)
      void pending.then((response) => {
        const body = response.body!
        const getReader = body.getReader.bind(body)
        Reflect.set(body, 'getReader', () => {
          const reader = getReader()
          const read = reader.read.bind(reader)
          Reflect.set(reader, 'read', () => {
            const pendingRead = read()
            if (++bodyReads === 2) bodyReading.resolve(undefined)
            return pendingRead
          })
          return reader
        })
      }, () => { /* the production renewal owns transport rejection */ })
      return pending
    })
    restoreFetch = () => { fetchSpy.mockRestore() }
    const runtime = ctx.get('gatewayRuntime')!
    const pool = Reflect.get(runtime, 'streamPrincipals') as StreamPrincipalLeasePool
    const options = Reflect.get(pool, 'options') as {
      renew: (ids: readonly string[], signal: AbortSignal) => Promise<unknown>
    }
    const renew = options.renew
    options.renew = (ids, signal) => {
      readSignal = signal
      rawStarted = true
      const raw = renew(ids, signal)
      const finished = (): void => { rawFinished = true; rawSettled.resolve(undefined) }
      void raw.then(finished, finished)
      return raw
    }
    const now = Date.now()
    const claims: GatewayPrincipalClaims = {
      version: 1, issuer: 'harness-gateway', audience: 'dsh-runtime', organization: credential.organization,
      user: { id: 7, username: 'fixture', displayName: 'Fixture', role: 'user' }, scope: { kind: 'personal' },
      runtime: credential.runtime, issuedAt: now, expiresAt: now + 30_000, nonce: 'fixture-event',
    }
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const assertion = `${payload}.${sign(null, Buffer.from(payload), pair.privateKey).toString('base64url')}`
    const principal = pool.open({ assertion, claims: verifyGatewayPrincipal(assertion, credential) }, new AbortController().signal)
    await bodyReading.promise
    expect(rawFinished).toBe(false)
    await pool.close()
    expect(readSignal?.aborted).toBe(true)
    expect(principal.signal?.aborted).toBe(true)
    expect(rawFinished).toBe(true)
    expect(pool.size).toBe(0)
  } finally { await cleanup() }

  expect(serverErrors).toEqual([])
})
