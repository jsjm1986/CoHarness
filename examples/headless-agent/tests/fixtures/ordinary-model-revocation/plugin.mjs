/** Real provider preparation refuses a policy revoked while credentials resolve. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'

export const inject = ['llm', 'credentials']

/** Own only external authentication, policy decisions, capacity and loopback responses. */
export async function apply(ctx, config) {
  const proofPath = join(process.cwd(), 'ordinary-model-proof.json')
  const inputPath = join(process.cwd(), 'ordinary-model-credential-state.txt')
  await writeFile(inputPath, 'revoke')
  let allowed = true, endpoint
  const proof = { code: undefined, httpRequests: 0, credentialLookups: 0, acquired: 0, released: 0, uncertain: 0, usageChunks: 0 }
  ctx.provide('modelAccessRequired', true)
  ctx.provide('modelAccess', { decide: () => allowed ? { allowed: true } : { allowed: false, reason: 'Fixture access revoked during credential lookup.' } })
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('resourceBudget', { async acquire(request) {
    assert.equal(request.kind, 'model')
    assert.equal(typeof request.sessionId, 'string')
    proof.acquired += 1
    return { signal: new AbortController().signal,
      release: async () => { proof.released += 1 },
      uncertain: async () => { proof.uncertain += 1 },
    }
  } })
  ctx.effect(() => ctx.credentials.registerReadOnlyLayer({
    id: 'ordinary-model-fixture',
    owns: ref => ref === 'ORDINARY_FIXTURE_KEY',
    describe: async () => ({ configured: true, source: 'fixture', writable: false }),
    async resolve() {
      proof.credentialLookups += 1
      assert.equal(proof.acquired - proof.released, 1)
      assert.equal(await readFile(inputPath, 'utf8'), 'revoke')
      allowed = false
      return { value: 'owned-fixture-key', source: 'fixture' }
    },
  }))
  ctx.on('llm/stream', async function* (_options, next) {
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') proof.usageChunks += 1
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') proof.code = chunk.reason.failure.code
        yield chunk
      }
    } finally { await writeFile(proofPath, JSON.stringify(proof)) }
  })
  await applyLoopbackServerEffect(ctx, {
    label: 'ordinary-model-revocation-fixture',
    requestListener: (_request, response) => {
      proof.httpRequests += 1
      response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Unexpected upstream request.' } }))
    },
    onListening: address => { endpoint = `http://127.0.0.1:${String(address.port)}` },
    onCleanup: () => { assert.equal(proof.acquired, proof.released); assert.equal(proof.uncertain, 0) },
  })
  if (config.protocol === 'pi') {
    await ctx.plugin(await import('@deepseek-ai/dsh-llm-pi-ai'), { providers: { 'ordinary-pi': {
      api: 'openai-completions', baseURL: endpoint, apiKeyEnv: 'ORDINARY_FIXTURE_KEY', models: [{ id: 'm', maxTokens: 64 }],
    } } })
  } else {
    await ctx.plugin(await import('@deepseek-ai/dsh-llm-deepseek-api-key'), { baseURL: endpoint, apiKeyEnv: 'ORDINARY_FIXTURE_KEY' })
  }
  ctx.provide('ordinaryModelRevocationReady', true)
}
