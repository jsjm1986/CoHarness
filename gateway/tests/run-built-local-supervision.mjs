/** Keyless acceptance of the compiled local launcher, with an exact stable transcript. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../lib/config.js'
import { LocalLauncher } from '../lib/launcher.js'
import { LocalRuntimeControl } from '../lib/local-runtime-control.js'
import { LocalRuntimeOwnerStore } from '../lib/local-runtime-owner.js'
import { randomUUID } from 'node:crypto'
import { collectDeploymentData } from '../lib/postgres/deployment-data.js'

assert.ok(['darwin', 'linux'].includes(process.platform), 'local supervision acceptance requires POSIX flock')
const root = await mkdtemp(join(tmpdir(), 'hgw-built-local-'))
const cfg = loadConfig({ HGW_STATE_ROOT: join(root, 'state') })
cfg.dshRepoRoot = fileURLToPath(new URL('../../', import.meta.url))
cfg.dshCommand = [process.execPath, fileURLToPath(new URL('./fixtures/local-runtime-server.mjs', import.meta.url)), join(root, 'ready.json')]
const runtime = { kind: 'project', ownerId: 7, username: 'fixture', runtimeKey: 'project-7', systemUser: 'fixture',
  port: 0, homePath: root, dshHome: root, generation: 2, credentialHash: 'a'.repeat(64) }
const launcher = new LocalLauncher(cfg), owner = launcher.attach(runtime)
const handles = [owner], transcript = []
const gateway = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/local-runtime-built-gateway.mjs', import.meta.url))], {
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
    ...process.env, LOCAL_RUNTIME_FIXTURE_ROOT: root,
    HGW_DATABASE_URL: 'postgres://synthetic.invalid/fixture', DATABASE_URL: 'postgres://synthetic.invalid/fixture', CLOUD_CREDENTIALS: 'synthetic-secret',
    NODE_OPTIONS: undefined, NODE_PATH: undefined, TSX_TSCONFIG_PATH: undefined,
  },
})
let diagnostics = ''; gateway.stderr.on('data', chunk => { diagnostics += String(chunk) })
try {
  await new Promise((resolve, reject) => {
    gateway.once('message', resolve)
    gateway.once('error', reject)
    gateway.once('exit', () => reject(new Error(`compiled fixture exited: ${diagnostics}`)))
  })
  const deadline = performance.now() + 30_000
  let ready
  while (ready === undefined) {
    try { ready = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT' || performance.now() > deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  assert.deepEqual(ready.credential, { fixture: true })
  transcript.push('Compiled Runtime starts with its private credential.')
  assert.deepEqual(ready.deploymentEnvironment, { HGW_DATABASE_URL: false, DATABASE_URL: false, CLOUD_CREDENTIALS: false })
  transcript.push('Gateway database and credential variables stay outside the Runtime environment.')
  const context = { organizationId: 'fixture', nodeId: 'fixture', pool: { query: async sql => ({
    rows: sql.includes('count(*)::text FROM harness.organizations') ? [{ organizations: '1', nodes: '1' }] : [],
  }) } }
  await assert.rejects(collectDeploymentData(context, { ...cfg, runtimeCredentialDir: cfg.stateRoot }), /managed-data-root-overlaps-runtime-control/u)
  transcript.push('Application backups refuse roots that overlap node execution control.')
  const exited = once(gateway, 'exit'); gateway.kill('SIGKILL'); await exited
  assert.equal(await (await fetch(`http://127.0.0.1:${ready.port}`)).text(), 'owned-runtime')
  transcript.push('Gateway SIGKILL leaves the independently owned Runtime available.')
  assert.equal(await owner.isAlive(), true)
  transcript.push('A replacement Gateway authenticates the exact runtime generation.')
  await assert.rejects(launcher.attach({ ...runtime, credentialHash: 'b'.repeat(64) }).terminate(0), /evidence is missing/u)
  assert.equal(await owner.isAlive(), true)
  transcript.push('A different credential cannot stop the active generation.')
  await owner.terminate(1000)
  assert.equal(await owner.isAlive(), false)
  assert.equal(await readFile(join(root, 'logs/runtime.log'), 'utf8'), 'runtime-ready\n')
  transcript.push('Confirmed stop joins the owned process range and retained runtime output.')
  const store = launcher.attach(runtime).store, record = await store.read(), nativeKill = process.kill
  let permanent = false, denied = 0
  process.kill = (pid, signal) => {
    if (pid === -record.groupPid && signal === 0 && (permanent || denied === 0)) {
      denied++
      throw Object.assign(new Error('Group observation denied'), { code: 'EPERM' })
    }
    return nativeKill(pid, signal)
  }
  try {
    // Native slice records run a real systemctl round trip per poll; a cold
    // user manager on a loaded runner exceeds a 200ms command budget, so the
    // control deadline must fit the platform probe, not just the POSIX path.
    await new LocalRuntimeControl(store, 2_000).terminate(0)
    assert.equal(denied, 1)
    transcript.push('A transient denied group observation waits for confirmed absence.')
    permanent = true
    const uncertain = new LocalRuntimeControl(store, 2_000)
    await assert.rejects(uncertain.terminate(0), /capacity remains occupied/u)
    assert.equal(uncertain.hasExited(), false)
    transcript.push('Persistent denied group observations retain uncertain occupancy.')
  } finally { process.kill = nativeKill }
  await assert.rejects(launcher.start({ ...runtime, gatewayCredential: '{}' }), /fenced/u)
  transcript.push('A stopped credential generation cannot allocate again.')
  const replacement = await launcher.start({ ...runtime, credentialHash: 'c'.repeat(64), gatewayCredential: '{}' }); handles.push(replacement)
  await owner.terminate(0)
  assert.equal(await replacement.isAlive(), true)
  transcript.push('A fresh credential survives a repeated stop from the older handle.')
  const rebootStore = new LocalRuntimeOwnerStore(join(root, 'reboot-owners'), { ...store.identity, generation: 3 })
  const rebootLease = await rebootStore.acquire()
  let rebootRecord
  try {
    const reserved = await rebootLease.create(randomUUID())
    const starting = await rebootLease.publish({ ...reserved, phase: 'starting', groupPid: process.pid, url: 'http://127.0.0.1:9/' })
    rebootRecord = await rebootLease.publish({ ...starting, phase: 'running' })
  } finally { await rebootLease.close() }
  await writeFile(rebootStore.recordPath, JSON.stringify({ ...rebootRecord, lock: {
    ...rebootRecord.lock, device: String(BigInt(rebootRecord.lock.device) + 1n),
  } }), { mode: 0o600 })
  assert.equal(await new LocalRuntimeControl(rebootStore, 200).isAlive(), false)
  assert.equal((await rebootStore.read()).phase, 'stopped')
  assert.equal(await replacement.isAlive(), true)
  transcript.push('A different kernel boot retires a remounted-device generation without contacting or signalling its saved process.')
  const cancellation = new AbortController()
  const cancelled = new LocalLauncher(cfg).start({ ...runtime, credentialHash: 'd'.repeat(64), gatewayCredential: '{}',
    signal: cancellation.signal, beforeAllocation: async () => { cancellation.abort() },
  }).then(handle => { handles.push(handle); return handle })
  await assert.rejects(cancelled, { reason: 'cancelled' })
  assert.equal(await replacement.isAlive(), true)
  transcript.push('Cancellation after preparation prevents independent runtime allocation.')
  const actual = transcript.join('\n') + '\n'
  assert.equal(actual, await readFile(new URL('./expected/local-runtime-supervision.expected.md', import.meta.url), 'utf8'))
  process.stdout.write(actual)
} finally {
  if (gateway.exitCode === null && gateway.signalCode === null) { const exited = once(gateway, 'exit'); gateway.kill('SIGKILL'); await exited }
  for (const handle of handles.reverse()) await handle.terminate(0)
  await rm(root, { recursive: true, force: true })
}
