/** Actual registry and Gateway transport replacements retain catalog ordering. */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'

export const inject = ['llm', 'agents', 'fs', 'sessions', 'sessionPersistence']

/** Mount a controlled external Gateway and the deterministic primary model. */
export async function apply(ctx) {
  const mode = process.env.DSH_WORKSPACE_REMOUNT
  assert.ok(['registry', 'transport'].includes(mode))
  let endpoint, accepted = { revision: 0, items: [] }, notify
  const publications = []
  await applyLoopbackServerEffect(ctx, {
    label: 'workspace-catalog-remount-gateway',
    onCleanup: () => {},
    onListening: address => { endpoint = `http://127.0.0.1:${address.port}` },
    requestListener: async (request, response) => {
      assert.equal(request.url, '/internal/runtime/workspace/catalog')
      assert.equal(request.headers.authorization, 'Bearer owned-catalog-fixture')
      let body = ''
      for await (const chunk of request) body += chunk.toString()
      const value = JSON.parse(body)
      publications.push(value)
      if (value.revision > accepted.revision) accepted = value
      notify?.(value)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"synchronized":true}')
    },
  })
  const observed = title => {
    const matches = value => value.items.some(item => item.title === title)
    const prior = publications.findLast(matches)
    if (prior !== undefined) return Promise.resolve(prior)
    return new Promise(resolve => { notify = value => { if (matches(value)) { notify = undefined; resolve(value) } } })
  }
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 }
    }
    async *stream(_options, dispatchRequest) {
      await dispatchRequest(async () => {})
      const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
      const entry = async name => import(new URL(`../../../../../packages/${name}/${face}`, import.meta.url))
      if (ctx.get('credentials') === undefined) await ctx.plugin((await entry('credentials/credentials-local')).default, {
        path: join(process.cwd(), 'catalog-credentials.yaml'), dshHome: join(process.cwd(), '.dsh'), watch: false,
      })
      if (ctx.get('connection') === undefined) await ctx.plugin(await entry('client/connection'))
      if (ctx.get('storage') === undefined) await ctx.plugin((await entry('storage/storage')).default)
      if (ctx.get('storage.backend.sqlite') === undefined) await ctx.plugin(await entry('storage/storage-sqlite'), { path: join(process.cwd(), 'workspaces.sqlite') })
      if (ctx.get('storageDomain') === undefined) await ctx.plugin(await entry('storage/storage-domain'), { backend: 'sqlite' })
      if (ctx.root.get('apiProxy') === undefined) ctx.root.effect(() => ctx.root.provide('apiProxy', {
        sessions: { list: async () => ({ result: { ok: true, value: { items: [] } } }) },
      }), 'workspace-remount-fixture: conversation metadata stub')
      const registry = await entry('workspace/workspace'), gateway = await entry('context/gateway-runtime')
      const folder = join(process.cwd(), 'catalog-directory')
      await mkdir(folder)
      const credentialPath = join(process.cwd(), 'catalog-runtime-credential.json')
      await writeFile(credentialPath, JSON.stringify({ version: 1, gatewayUrl: endpoint, organization: 'catalog-fixture',
        runtime: { kind: 'user', id: 12, generation: 7 }, token: 'owned-catalog-fixture',
        principalPublicKey: generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      }), { mode: 0o600 })
      const oldFile = process.env.DSH_GATEWAY_CREDENTIAL_FILE, oldFd = process.env.DSH_GATEWAY_CREDENTIAL_FD
      process.env.DSH_GATEWAY_CREDENTIAL_FILE = credentialPath
      delete process.env.DSH_GATEWAY_CREDENTIAL_FD
      let registryFiber, gatewayFiber
      try {
        registryFiber = ctx.plugin(registry.default)
        await registryFiber.await()
        const workspaces = ctx.get('workspaceRegistry')
        assert.ok(workspaces)
        let workspace = await workspaces.create(folder, 'Initial')
        gatewayFiber = ctx.plugin(gateway.default)
        await gatewayFiber.await()
        await observed('Initial')
        await workspace.setTitle('Before one')
        await observed('Before one')
        await workspace.setTitle('Before remount')
        const before = await observed('Before remount')
        if (mode === 'registry') {
          await registryFiber.dispose()
          registryFiber = ctx.plugin(registry.default)
          await registryFiber.await()
          workspace = ctx.get('workspaceRegistry').list().find(item => item.id === workspace.id)
          assert.ok(workspace)
          await workspace.setTitle('After remount')
        } else {
          await gatewayFiber.dispose()
          await workspace.setTitle('After remount')
          gatewayFiber = ctx.plugin(gateway.default)
          await gatewayFiber.await()
        }
        const after = await observed('After remount')
        const proof = { mode, newerRevision: after.revision > before.revision,
          acceptedTitle: accepted.items.find(item => item.workspaceId === workspace.id)?.title,
          retainedWorkspaceIdentity: after.items.some(item => item.workspaceId === workspace.id),
          generation: ctx.get('gatewayRuntime').identity.generation }
        await writeFile(join(process.cwd(), 'workspace-remount-proof.json'), JSON.stringify(proof))
        const passed = proof.newerRevision && proof.acceptedTitle === 'After remount' && proof.retainedWorkspaceIdentity && proof.generation === 7
        yield { type: 'block-end', index: 0, block: { type: 'text', text: passed ? 'WORKSPACE_REMOUNT_OK' : 'WORKSPACE_REMOUNT_FAILED' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        await gatewayFiber?.dispose()
        await registryFiber?.dispose()
        if (oldFile === undefined) delete process.env.DSH_GATEWAY_CREDENTIAL_FILE
        else process.env.DSH_GATEWAY_CREDENTIAL_FILE = oldFile
        if (oldFd === undefined) delete process.env.DSH_GATEWAY_CREDENTIAL_FD
        else process.env.DSH_GATEWAY_CREDENTIAL_FD = oldFd
      }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['workspace-remount-fixture'], new Adapter()))
  ctx.provide('workspaceCatalogRemountReady', true)
}
