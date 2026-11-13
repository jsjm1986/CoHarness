/** Native Windows proof with synthetic Ed25519 keys. All output is numeric timing or test metadata. */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

assert.equal(process.platform, 'win32', 'Run this native clock check on Windows')
const signerModule = process.env.HGW_TEST_CLOCK_SIGNER
  ? pathToFileURL(process.env.HGW_TEST_CLOCK_SIGNER) : new URL('../lib/principal.js', import.meta.url)
const runtimeModule = process.env.HGW_TEST_CLOCK_VERIFIER
  ? pathToFileURL(process.env.HGW_TEST_CLOCK_VERIFIER) : new URL('../../packages/context/gateway-runtime/lib/index.js', import.meta.url)
const leasesModule = process.env.HGW_TEST_CLOCK_LEASES
  ? pathToFileURL(process.env.HGW_TEST_CLOCK_LEASES) : new URL('../lib/stream-principal-leases.js', import.meta.url)
const { GatewayPrincipalSigner } = await import(signerModule)
const { verifyGatewayPrincipal } = await import(runtimeModule)
const { StreamPrincipalLeases } = await import(leasesModule)
const organization = 'synthetic-clock-control'
const runtime = { kind: 'user', id: 7, generation: 52, runtimeId: '11111111-1111-4111-8111-111111111111' }
const credential = { organization, runtime }
const ttlMs = 15 * 60_000

if (process.argv.includes('--verify')) {
  let key
  process.on('message', (request) => {
    if (request.publicKey) {
      key = createPublicKey(request.publicKey)
      process.send({ ready: true })
      return
    }
    const now = Date.now()
    const verify = (assertion, time, target = credential) => verifyGatewayPrincipal(assertion, target, key, time)
    const actual = verify(request.candidate, now)
    assert.equal(actual.issuedAt, request.at - 16)
    assert.equal(actual.expiresAt, request.at - 16 + ttlMs)
    assert.doesNotThrow(() => verify(request.candidate, request.at - 16))
    assert.doesNotThrow(() => verify(request.candidate, request.at - 16 + ttlMs - 1))
    assert.throws(() => verify(request.candidate, request.at - 17))
    assert.throws(() => verify(request.candidate, request.at - 16 + ttlMs))
    assert.throws(() => verify(request.candidate, request.at - 16 + ttlMs + 1))
    assert.throws(() => verify(request.forged, now))
    assert.throws(() => verify(request.candidate, now, { organization: 'another-organization', runtime }))
    assert.throws(() => verify(request.candidate, now, { organization, runtime: { ...runtime, generation: 51 } }))
    assert.throws(() => verify(request.candidate, now, { organization, runtime: { ...runtime, runtimeId: 'another-runtime' } }))
    process.send({ offsetMs: now - request.at })
  })
} else {
  const soakMs = Number(process.env.HGW_TEST_CLOCK_SOAK_MS ?? 2000)
  assert(Number.isSafeInteger(soakMs) && soakMs >= 1000 && soakMs <= 180_000)
  const key = generateKeyPairSync('ed25519')
  const valid = new GatewayPrincipalSigner(key.privateKey, organization, ttlMs)
  const forged = new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, organization, ttlMs)
  const caller = { user: { id: 7, username: 'qa-clock', displayName: 'QA', role: 'user', status: 'active', homePath: 'C:\\qa\\home', mustChangePassword: false, autoReviewEligible: false }, scope: { kind: 'personal' }, runtime }
  const started = new Date().toISOString()
  const end = performance.now() + soakMs
  // The event-connection register rejects assertions whose declared lifetime
  // exceeds 30 s; the Windows clock-tick backdate must not inflate it.
  const streamContext = { user: caller.user, scope: caller.scope, runtime }
  const stream = new StreamPrincipalLeases({
    signer: valid, maxBatchSize: 2,
    synchronize: async () => {},
    qualify: async (token, context) => context === streamContext
      ? { user: caller.user, expiresAt: Date.now() + 60_000, scope: caller.scope }
      : null,
  })
  {
    const assertion = valid.issueStream(caller, Date.now() + 60_000)
    const claims = valid.verify(assertion)
    assert(claims.expiresAt - claims.issuedAt <= 30_000, 'stream principal document must stay inside the 30 s register window')
    const signal = new AbortController()
    stream.register({ assertion, token: 'synthetic-login', context: streamContext, signal: signal.signal, cancel: () => {} })
    signal.abort()
  }
  stream.close()
  async function check(offset) {
    await delay(offset)
    const child = fork(fileURLToPath(import.meta.url), ['--verify'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    const exit = once(child, 'exit')
    const exited = exit.then(() => { throw new Error('Isolated clock verifier exited before answering') })
    void exited.catch(() => {})
    async function exchange(packet) {
      const reply = once(child, 'message')
      child.send(packet)
      return (await Promise.race([reply, exited]))[0]
    }
    let samples = 0, negative = 0, minimumAge = Infinity
    try {
      const ready = await exchange({ publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }) })
      assert(ready.ready)
      do {
        const at = Date.now()
        const { offsetMs } = await exchange({ at, candidate: valid.issue({ ...caller, now: at }), forged: forged.issue({ ...caller, now: at }) })
        assert(Number.isInteger(offsetMs))
        samples++
        if (offsetMs < 0) negative++
        minimumAge = Math.min(minimumAge, offsetMs)
        await delay(140)
      } while (performance.now() < end)
    } finally {
      child.kill()
      await exit
    }
    return { offset, samples, negative, minimumAge }
  }
  const offsets = soakMs < 40_000 ? [0, 200] : [0, 5_000, 17_000, 31_000]
  const results = await Promise.all(offsets.map(check))
  console.log(JSON.stringify({ platform: process.platform, node: process.version, started, completed: new Date().toISOString(), ttlMs, results }))
}
