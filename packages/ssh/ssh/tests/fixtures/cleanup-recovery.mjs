/** Loader-owned native helper requests retain cleanup evidence and retry across the actual wire protocol. */
import assert from 'node:assert/strict'
import { access, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const repository = new URL('../../../../../', import.meta.url)
const entry = path => new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, repository).href
const ssh = artifactRoot === undefined ? fileURLToPath(new URL('packages/ssh/ssh/', repository)) : artifactRoot
const protocol = pathToFileURL(join(ssh, mode === 'src' ? 'src/protocol.ts' : 'lib/protocol.js')).href
const schemas = pathToFileURL(join(ssh, mode === 'src' ? 'src/schemas.ts' : 'lib/schemas.js')).href
const helper = join(ssh, mode === 'src' ? 'src/helper-entry.ts' : 'lib/helper.js')
const { SshRpcPeer } = await import(protocol)
const { helloSchema, preparedSchema } = await import(schemas)
const { boot } = await import(entry('boot/app-boot'))
const { z } = await import('zod')
const workspace = process.cwd(), home = join(workspace, '.dsh'), config = join(workspace, 'cordis.yml')
await writeFile(config, JSON.stringify([
  { name: entry('credentials/credentials-local'), config: { path: join(home, 'credentials.yaml'), dshHome: home, watch: false } },
  { name: entry('fs/fs-local'), config: { cwd: workspace } },
  { name: entry('subprocess/subprocess-local') },
]))
const ctx = await boot('ssh-helper-cleanup-recovery', config)
let active, handle, peer
try {
  ctx.effect(() => ctx.provide('resourceBudgetRequired', true))
  ctx.effect(() => ctx.provide('resourceBudget', { async acquire(request) {
    assert.equal(request.kind, 'process'); assert.equal(request.origin, 'infrastructure')
    const owner = active
    owner.admissions++
    let settled = false
    return { signal: new AbortController().signal,
      release: async () => { if (!settled) { settled = true; owner.releases++ } },
      uncertain: async () => { owner.uncertainties++ } }
  } }))
  for (const phase of ['reservation', 'root']) {
    active = { admissions: 0, releases: 0, uncertainties: 0 }
    const marker = join(workspace, `fault-${phase}`)
    await writeFile(marker, '')
    handle = await ctx.subprocess.spawn({
      argv: [process.execPath,
        ...mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : [],
        '--import', new URL('./cleanup-fault.mjs', import.meta.url).href, helper],
      cwd: workspace, env: { ...process.env, DSH_TEST_SSH_CLEANUP_TARGET: marker },
      resourceOrigin: 'infrastructure', graceMs: 1000,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 16_384 } },
    })
    peer = new SshRpcPeer(handle.stdout, handle.stdin, 64 * 1024 * 1024, 128)
    const request = (method, body, schema) => peer.request(method, body, schema, AbortSignal.timeout(20_000))
    const facts = await request('hello', { protocol: 2, workspace, leaseMs: 30_000 }, helloSchema)
    assert.match(facts.root, /^\/tmp\/dsh-ssh-[^/]+$/u)
    const prepared = await request('process.prepare', { argv: [process.execPath], cwd: workspace, graceMs: 50,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } }, preparedSchema)
    const selected = phase === 'reservation' ? join(facts.root, prepared.id) : facts.root
    await writeFile(marker, selected)
    const first = await request('close', {}, z.null()).then(() => ({ failed: false }), error => ({ failed: true, message: error.message }))
    assert.equal(first.failed, true)
    const retained = await access(selected).then(() => true, () => false)
    const denied = await request('heartbeat', {}, z.null()).then(() => false, error => error.message.includes('not accepting'))
    const retry = await request('close', {}, z.null()).then(() => true, () => false)
    const repeat = await request('close', {}, z.null()).then(() => true, () => false)
    const removed = await access(facts.root).then(() => false, () => true)
    const heldUntilNativeExit = active.releases === 0
    handle.stdin.end()
    const result = await handle.done
    const exited = await handle.waitForExit(AbortSignal.timeout(10_000))
    console.log(JSON.stringify({ phase, firstFailed: first.failed, retained, newWorkDenied: denied,
      retryAcknowledged: retry, repeatAcknowledged: repeat, removed, heldUntilNativeExit,
      nativeExitCode: result.exitCode, nativeRangeEmpty: exited, ...active }))
    if (exited && !removed) await rm(facts.root, { recursive: true, force: true })
    peer.close(); peer = undefined; handle = undefined
  }
} finally {
  peer?.close()
  if (handle !== undefined) { handle.terminate(); await handle.waitForExit(AbortSignal.timeout(10_000)) }
  await ctx.fiber.dispose()
}
