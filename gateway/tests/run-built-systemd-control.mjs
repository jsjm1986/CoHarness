/** Keyless compiled-launcher acceptance using inert native CLI clients, without a host system manager. */
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SystemdLauncher, RuntimeLaunchCleanupError } from '../lib/launcher.js'
import { loadConfig } from '../lib/config.js'

assert.notEqual(process.platform, 'win32', 'systemd control acceptance requires POSIX executable fixtures')
const originalPath = process.env.PATH, originalDatabase = process.env.HGW_DATABASE_URL
const transcript = []
async function bounded(request, timeoutMs) {
  let timer
  try { return await Promise.race([request, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Control acceptance deadline exceeded')), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}
async function endpoint(marker, release = false) {
  try { return await (await fetch(`${marker.url}/${release ? 'release/' : ''}${marker.token}`, { headers: { connection: 'close' } })).text() }
  catch (error) { if (['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code)) return undefined; throw error }
}
async function scenario(hold, verify, ignoreTerm = false) {
  const root = await mkdtemp(join(tmpdir(), 'hgw-built-systemctl-'))
  let marker, pending
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(root, 'fixture.json'), JSON.stringify({ hold, ignoreTerm }))
    const binary = join(root, 'systemctl')
    await writeFile(binary, `#!${process.execPath}\n${await readFile(new URL('./fixtures/systemctl-client.mjs', import.meta.url), 'utf8')}`)
    await chmod(binary, 0o700)
    await writeFile(join(root, 'id'), '#!/bin/sh\nprintf "1001\\n"\n')
    await chmod(join(root, 'id'), 0o700)
    process.env.PATH = `${root}:${originalPath ?? ''}`
    process.env.HGW_DATABASE_URL = 'postgres://synthetic.invalid/not-a-credential'
    const launcher = new SystemdLauncher({
      systemd: { usersRoot: join(root, 'users'), projectRuntimesRoot: join(root, 'runtimes'), projectPathRoots: [root],
        execStart: '/usr/bin/false', gatewayDir: join(root, 'gateway'), memoryMax: '1G', cpuQuota: '100%' },
      grantsProvider: () => [], credentialDir: join(root, 'credentials'), unitDir: root, commandTimeoutMs: 5000,
    })
    const runtime = { kind: 'user', ownerId: 1, username: 'fixture', runtimeKey: 'fixture', systemUser: 'harness-fixture',
      port: 42001, homePath: join(root, 'users/fixture/home'), dshHome: join(root, 'users/fixture/dsh'),
      generation: 1, credentialHash: 'a'.repeat(64), gatewayCredential: '{}' }
    const launch = request => { pending = request.then(value => ({ value }), error => ({ error })); return pending }
    const witness = async () => {
      const deadline = performance.now() + 20000
      while (marker === undefined) {
        try { marker = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')) }
        catch (error) { if (error.code !== 'ENOENT' || performance.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 10)) }
      }
      assert.equal(await endpoint(marker), marker.token)
    }
    await verify({ launcher, runtime, root, launch, witness, closed: async () => assert.equal(await endpoint(marker), undefined) })
  } finally {
    if (marker !== undefined) await endpoint(marker, true)
    if (pending !== undefined) {
      const result = await pending
      if (result.value?.terminate !== undefined) await result.value.terminate(0)
      else if (result.error instanceof RuntimeLaunchCleanupError) await result.error.process.terminate(0)
    }
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath
    if (originalDatabase === undefined) delete process.env.HGW_DATABASE_URL; else process.env.HGW_DATABASE_URL = originalDatabase
    await rm(root, { recursive: true, force: true })
  }
}
assert.equal(loadConfig({}).systemdCommandTimeoutMs, 120000)
await scenario('none', async ({ launcher, runtime, root, launch }) => {
  await writeFile(join(root, 'id'), '#!/bin/sh\nexit 1\n')
  const result = await launch(launcher.start(runtime))
  assert.match(result.error?.message ?? '', /account.*not provisioned/u)
  assert.ok(!(result.error instanceof RuntimeLaunchCleanupError))
  await assert.rejects(readFile(join(root, 'calls.jsonl')), { code: 'ENOENT' })
  transcript.push('Missing runtime accounts are reported before credential creation or process allocation.')
})
await scenario('none', async ({ launcher, runtime, root, launch }) => {
  const result = await launch(launcher.start(runtime))
  assert.ok(result.value)
  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(calls.length > 0 && calls.every(call => !call.databasePresent && call.locale === 'C' && call.args.includes('--no-ask-password') && call.args.includes('--no-pager')))
  transcript.push('Native control clients exclude Gateway database variables and disable prompts.')
  const unit = await readFile(join(root, `harness-fixture@1-${runtime.credentialHash}.service`), 'utf8')
  assert.ok(unit.includes('Type=exec'))
  const source = /^LoadCredential=dsh-gateway:(.+)$/m.exec(unit)[1]
  assert.equal(await readFile(source, 'utf8'), '{}')
  await result.value.terminate(0)
  await assert.rejects(readFile(source), { code: 'ENOENT' })
  transcript.push('Generation credentials survive startup and remain private until the supervisor confirms stopped.')
})
for (const operation of ['daemon-reload', 'restart']) await scenario(operation, async ({ launcher, runtime, launch, witness, closed }) => {
  const controller = new AbortController(), request = launch(launcher.start({ ...runtime, signal: controller.signal }))
  await witness(); controller.abort()
  const result = await bounded(request, 2000)
  assert.ok(result.error)
  await closed()
  if (operation === 'restart') assert.ok(result.error instanceof RuntimeLaunchCleanupError)
  transcript.push(operation === 'restart'
    ? 'Cancellation closes the restart client and retains the generation cleanup handle.'
    : 'Cancellation closes the daemon-reload client before startup settles.')
})
await scenario('daemon-reload', async ({ launcher, runtime, launch, witness, closed }) => {
  const controller = new AbortController(), request = launch(launcher.start({ ...runtime, signal: controller.signal }))
  await witness(); controller.abort()
  assert.ok((await bounded(request, 2000)).error)
  await closed()
  transcript.push('Cancellation force-kills an uncooperative native client before startup settles.')
}, true)
for (const operation of ['is-active', 'stop']) await scenario(operation, async ({ launcher, runtime, launch, witness, closed }) => {
  const handle = launcher.attach(runtime)
  const request = launch(operation === 'stop' ? handle.terminate(0) : handle.isAlive())
  await witness()
  assert.ok((await bounded(request, 7000)).error)
  assert.equal(handle.hasExited(), false)
  await closed()
  transcript.push(operation === 'stop' ? 'A stalled stop client times out without releasing service ownership.' : 'A stalled liveness client times out without proving unit exit.')
})
const actual = transcript.join('\n') + '\n'
assert.equal(actual, await readFile(new URL('./expected/systemd-control.expected.md', import.meta.url), 'utf8'))
process.stdout.write(actual)
