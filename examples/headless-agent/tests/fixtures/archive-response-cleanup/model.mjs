/** Refused archive synchronization releases its native HTTP transport before retry. */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'

export const inject = ['llm', 'sessions', 'sessionPersistence']

/** Assemble the normal archive providers around an owned external Gateway. */
export async function apply(ctx) {
  let endpoint, snapshots = 0
  const first = Promise.withResolvers(), closed = Promise.withResolvers(), retry = Promise.withResolvers()
  await applyLoopbackServerEffect(ctx, {
    label: 'archive-response-cleanup-gateway',
    onCleanup: () => {},
    onListening: address => { endpoint = `http://127.0.0.1:${address.port}` },
    requestListener: async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer owned-archive-fixture')
      for await (const _chunk of request) { /* drain the fixture's request payload */ }
      if (request.url === '/internal/runtime/archive/snapshot') {
        snapshots++
        if (snapshots === 1) {
          response.once('close', () => { closed.resolve() })
          response.writeHead(503, { 'content-type': 'application/json' })
          response.flushHeaders()
          response.write('{"unfinished":')
          first.resolve()
          return
        }
        retry.resolve()
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ commands: [], pending: false, synchronized: true }))
    },
  })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 }
    }
    async *stream(_options, dispatchRequest) {
      await dispatchRequest(async () => {})
      const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
      const entry = async name => import(new URL(`../../../../../packages/${name}/${face}`, import.meta.url))
      if (ctx.get('credentials') === undefined) await ctx.plugin((await entry('credentials/credentials-local')).default, {
        path: join(process.cwd(), 'archive-credentials.yaml'), dshHome: join(process.cwd(), '.dsh'), watch: false,
      })
      if (ctx.get('connection') === undefined) await ctx.plugin(await entry('client/connection'))
      if (ctx.get('storage') === undefined) await ctx.plugin((await entry('storage/storage')).default)
      if (ctx.get('storage.backend.sqlite') === undefined) await ctx.plugin(await entry('storage/storage-sqlite'), { path: join(process.cwd(), 'archive.sqlite') })
      if (ctx.get('storageDomain') === undefined) await ctx.plugin(await entry('storage/storage-domain'), { backend: 'sqlite' })
      const credentialPath = join(process.cwd(), 'archive-runtime-credential.json')
      await writeFile(credentialPath, JSON.stringify({ version: 1, gatewayUrl: endpoint, organization: 'archive-fixture',
        runtime: { kind: 'user', id: 12, generation: 7 }, token: 'owned-archive-fixture',
        principalPublicKey: generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      }), { mode: 0o600 })
      const oldFile = process.env.DSH_GATEWAY_CREDENTIAL_FILE, oldFd = process.env.DSH_GATEWAY_CREDENTIAL_FD
      process.env.DSH_GATEWAY_CREDENTIAL_FILE = credentialPath
      delete process.env.DSH_GATEWAY_CREDENTIAL_FD
      let registryFiber, gatewayFiber, archiveFiber, timer
      try {
        registryFiber = ctx.plugin((await entry('workspace/workspace')).default)
        await registryFiber.await()
        const registry = ctx.get('workspaceRegistry')
        assert.ok(registry)
        gatewayFiber = ctx.plugin((await entry('context/gateway-runtime')).default)
        await gatewayFiber.await()
        archiveFiber = ctx.plugin((await entry('context/archive-gateway')).default, { commandPollMs: 60000 })
        await archiveFiber.await()
        await first.promise
        const refusalClosedWhileLoaded = await Promise.race([
          closed.promise.then(() => true),
          new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000) }),
        ])
        clearTimeout(timer)
        const idle = ctx.sessions.create(SessionId('archive-cleanup-idle'), { meta: { cwd: process.cwd() } })
        await registry.archiveSession(idle.id)
        await retry.promise
        const proof = { refusalClosedWhileLoaded, laterSync: true, generation: 7 }
        await writeFile(join(process.cwd(), 'archive-response-proof.json'), JSON.stringify(proof))
        const text = refusalClosedWhileLoaded ? 'ARCHIVE_RESPONSE_CLEANUP_OK' : 'ARCHIVE_RESPONSE_CLEANUP_FAILED'
        yield { type: 'block-start', index: 0, block: { type: 'text', text } }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        clearTimeout(timer)
        try { await archiveFiber?.dispose() }
        finally {
          try { await gatewayFiber?.dispose() }
          finally {
            try { await registryFiber?.dispose() }
            finally {
              if (oldFile === undefined) delete process.env.DSH_GATEWAY_CREDENTIAL_FILE
              else process.env.DSH_GATEWAY_CREDENTIAL_FILE = oldFile
              if (oldFd === undefined) delete process.env.DSH_GATEWAY_CREDENTIAL_FD
              else process.env.DSH_GATEWAY_CREDENTIAL_FD = oldFd
            }
          }
        }
      }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['archive-cleanup-fixture'], new Adapter()))
  ctx.provide('archiveResponseCleanupReady', true)
}
