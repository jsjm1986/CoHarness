/** Real pipe credentials retain application ownership across provider replacement. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspect } from 'node:util'

const mode = process.argv[2], root = process.argv[3]
assert.ok(mode === 'src' || mode === 'lib')
const repo = new URL('../../../../../', import.meta.url)
const { Context } = await import(new URL(`vendor/cordis/${mode}/index.${mode === 'src' ? 'ts' : 'js'}`, repo))
const providerUrl = new URL(`packages/context/gateway-runtime/${mode}/index.${mode === 'src' ? 'ts' : 'js'}`, repo)
const { default: GatewayRuntime, parseGatewayRuntimeCredential } = await import(providerUrl)
const contexts = []
function application() {
  const ctx = new Context(); contexts.push(ctx)
  ctx.effect(() => ctx.provide('connection', {}), 'fixture: connection')
  return ctx
}
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`)
try {
  const original = application()
  const first = original.plugin(GatewayRuntime); await first.await()
  assert.equal(original.gatewayRuntime.organization, 'first-root')
  assert.equal(original.gatewayRuntime.identity.generation, 7)
  output({ operation: 'initial-pipe-authority', generation: 7 })
  await first.dispose()
  providerUrl.searchParams.set('credential-replacement', 'updated-module')
  const { default: ReplacementRuntime } = await import(providerUrl)
  assert.notEqual(ReplacementRuntime, GatewayRuntime)
  const replacement = original.plugin(ReplacementRuntime); await replacement.await()
  assert.equal(original.gatewayRuntime.organization, 'first-root')
  assert.equal(original.gatewayRuntime.identity.generation, 7)
  await replacement.dispose()
  output({ operation: 'provider-remount', authorityRetained: true })

  const exhausted = application(), denied = exhausted.plugin(GatewayRuntime)
  await assert.rejects(denied.await(), /failed to read Gateway runtime credential/u)
  await denied.dispose()
  delete process.env.DSH_GATEWAY_CREDENTIAL_FD
  process.env.DSH_GATEWAY_CREDENTIAL_FILE = join(root, 'second.json')
  const other = application(); await other.plugin(GatewayRuntime)
  assert.equal(other.gatewayRuntime.organization, 'second-root')
  assert.equal(other.gatewayRuntime.identity.generation, 8)
  await original.plugin(GatewayRuntime)
  assert.equal(original.gatewayRuntime.organization, 'first-root')
  assert.equal(original.gatewayRuntime.identity.generation, 7)
  output({ operation: 'application-isolation', exhaustedPipeRefused: true, firstGeneration: 7, secondGeneration: 8 })

  const retryPath = join(root, 'retry.json'), recovering = application()
  process.env.DSH_GATEWAY_CREDENTIAL_FILE = retryPath
  await writeFile(retryPath, '{"token":private-synthetic-bearer}', { mode: 0o600 })
  const malformed = recovering.plugin(GatewayRuntime)
  await assert.rejects(malformed.await(), error => {
    assert.match(error.message, /failed to read Gateway runtime credential/u)
    assert.equal(inspect(error, { depth: 8 }).includes('private-'), false, 'Credential contents must not enter startup diagnostics')
    return true
  }); await malformed.dispose()
  const valid = JSON.parse(await readFile(join(root, 'second.json'), 'utf8'))
  await writeFile(retryPath, JSON.stringify({ ...valid, gatewayUrl: 'private-synthetic-origin' }))
  const invalidOrigin = recovering.plugin(GatewayRuntime)
  await assert.rejects(invalidOrigin.await(), error => {
    assert.equal(inspect(error, { depth: 8 }).includes('private-'), false, 'Origin bytes must not enter startup diagnostics')
    return true
  }); await invalidOrigin.dispose()
  await writeFile(retryPath, JSON.stringify({ ...valid, principalPublicKey: 'not a public key' }))
  const invalidKey = recovering.plugin(GatewayRuntime)
  await assert.rejects(invalidKey.await()); await invalidKey.dispose()
  await writeFile(retryPath, JSON.stringify(valid))
  await recovering.plugin(GatewayRuntime)
  assert.equal(recovering.gatewayRuntime.identity.generation, 8)
  output({ operation: 'initial-failure-recovery', malformedJsonRetried: true, invalidOriginRetried: true, invalidKeyRetried: true, diagnosticRedacted: true })
  for (const gatewayUrl of ['http://127.0.0.1:8899', 'http://localhost:8899', 'http://[::1]:8899']) {
    assert.equal(parseGatewayRuntimeCredential({ ...valid, gatewayUrl }).gatewayUrl, gatewayUrl)
  }
  for (const gatewayUrl of ['http://example.com:8899', 'http://[2001:db8::1]:8899', 'http://[::]:8899',
    'https://[::1]:8899', 'http://[::1]:8899/private', 'http://[::1]:8899/?scope=other', 'http://user:synthetic-password@[::1]:8899']) {
    assert.throws(() => parseGatewayRuntimeCredential({ ...valid, gatewayUrl }), /loopback HTTP origin/u)
  }
  output({ operation: 'loopback-credential-origins', accepted: 3, rejected: 7 })
} finally {
  const results = await Promise.allSettled(contexts.reverse().map(ctx => ctx.fiber.dispose()))
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length) throw new AggregateError(failures, 'Credential fixture cleanup failed')
}
