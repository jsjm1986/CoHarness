/** Real process, socket and kernel-lease evidence for the recoverable local launcher. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { LocalLauncher, RuntimeLaunchCleanupError, type InstanceProc } from '../src/launcher.ts'
import { LocalRuntimeOwnerLease, LocalRuntimeOwnerStore } from '../src/local-runtime-owner.ts'
import { LocalRuntimeControl } from '../src/local-runtime-control.ts'

const roots: string[] = [], handles: InstanceProc[] = []
afterEach(async () => {
  try { for (const handle of handles.splice(0)) await handle.terminate(0) }
  finally { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) }
}, 30_000)
const identity = { kind: 'project' as const, ownerId: 7, username: 'fixture', runtimeKey: 'project-7', systemUser: 'fixture',
  port: 0, generation: 2, credentialHash: 'a'.repeat(64) }

async function fixture(mode = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'hgw-local-launch-')); roots.push(root)
  const cfg = loadConfig({ HGW_STATE_ROOT: join(root, 'state') })
  cfg.dshRepoRoot = fileURLToPath(new URL('../../', import.meta.url))
  cfg.dshCommand = [process.execPath, fileURLToPath(new URL('./fixtures/local-runtime-server.mjs', import.meta.url)), join(root, 'ready.json'), mode]
  const runtime = { ...identity, homePath: root, dshHome: root }
  const store = new LocalRuntimeOwnerStore(join(cfg.stateRoot, 'local-runtime-supervisors'), {
    node: cfg.computeNodeName, kind: runtime.kind, ownerId: runtime.ownerId, runtimeKey: runtime.runtimeKey,
    generation: runtime.generation, credentialHash: runtime.credentialHash,
  })
  return { root, cfg, runtime, store, launcher: new LocalLauncher(cfg) }
}
async function start(f: Awaited<ReturnType<typeof fixture>>) {
  try {
    const handle = await f.launcher.start({ ...f.runtime, gatewayCredential: '{"fixture":true}' })
    handles.push(handle); return handle
  } catch (error) { if (error instanceof RuntimeLaunchCleanupError) handles.push(error.process); throw error }
}
async function ready(root: string): Promise<{ pid: number; port: number; credential: unknown; descendant?: number }> {
  let result: { pid: number; port: number; credential: unknown; descendant?: number } | undefined
  await vi.waitFor(async () => { result = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')) as typeof result; expect(result).toBeDefined() }, { timeout: 30_000 })
  return result!
}
async function absent(pid: number): Promise<void> {
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 30_000 })
}

describe.skipIf(process.platform === 'win32')('recoverable LocalLauncher', () => {
  it('keeps Gateway database and credential variables out of the actual Runtime environment', async () => {
    const f = await fixture()
    const output = join(f.root, 'environment.json')
    f.cfg.dshCommand = [process.execPath, '-e', `
      const fs=require('node:fs');fs.readFileSync(3);
      fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify(Object.fromEntries(
        ['HGW_DATABASE_URL','HGW_TEST_DATABASE_URL','HGW_USERS_ROOT','DATABASE_URL','CLOUD_CREDENTIALS','PATH']
          .map(name=>[name,process.env[name]===undefined?'absent':name==='PATH'?'operating-system':'present']))));
      fs.writeFileSync(${JSON.stringify(output + '.grants')}, process.env.DSH_DIRECTORY_GRANTS ?? 'absent');
      setInterval(()=>{},1000);
    `]
    for (const name of ['HGW_DATABASE_URL', 'HGW_TEST_DATABASE_URL', 'DATABASE_URL']) vi.stubEnv(name, 'postgres://synthetic.invalid/fixture')
    vi.stubEnv('HGW_USERS_ROOT', '/fixture/gateway-only-users')
    vi.stubEnv('CLOUD_CREDENTIALS', 'synthetic-secret')
    try {
      await start(f)
      let value: unknown
      await vi.waitFor(async () => { value = JSON.parse(await readFile(output, 'utf8')) }, { timeout: 30_000 })
      expect(value).toEqual({ HGW_DATABASE_URL: 'absent', HGW_TEST_DATABASE_URL: 'absent', HGW_USERS_ROOT: 'absent',
        DATABASE_URL: 'absent', CLOUD_CREDENTIALS: 'absent', PATH: 'operating-system' })
      expect(await readFile(output + '.grants', 'utf8')).toBe(join(f.root, 'directory-grants.json'))
    } finally { vi.unstubAllEnvs() }
  })
  it('delivers credentials privately, retains bounded logs, reattaches and confirms the exact generation stopped', async () => {
    const f = await fixture(), handle = await start(f), runtime = await ready(f.root)
    expect(runtime.credential).toEqual({ fixture: true })
    expect(await handle.isAlive?.()).toBe(true)
    expect(await (await fetch(`http://127.0.0.1:${runtime.port}`)).text()).toBe('owned-runtime')
    const attached = new LocalLauncher(f.cfg).attach(f.runtime); handles.push(attached)
    expect(await attached.isAlive?.()).toBe(true)
    await attached.terminate(1000)
    await absent(runtime.pid)
    expect((await f.store.read())?.phase).toBe('stopped')
    expect(await readFile(join(f.root, 'logs/runtime.log'), 'utf8')).toBe('runtime-ready\n')
    await expect(f.launcher.start({ ...f.runtime, gatewayCredential: '{}' })).rejects.toThrow('fenced')
    expect(await handle.isAlive?.()).toBe(false)
  })

  it.each(['ready', 'ack-dropped', 'spec-held'])('recovers exact ownership after Gateway SIGKILL at %s', async stage => {
    const f = await fixture()
    const gateway = spawn(process.execPath, [
      ...(stage === 'ready' ? [] : ['--import', fileURLToPath(new URL('./fixtures/local-runtime-drop-ack.mjs', import.meta.url))]),
      '--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./fixtures/local-runtime-gateway.ts', import.meta.url)),
    ], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
        ...process.env, LOCAL_RUNTIME_FIXTURE_ROOT: f.root, LOCAL_RUNTIME_FIXTURE_DROP: stage === 'spec-held' ? 'spec' : 'ack',
        TSX_TSCONFIG_PATH: fileURLToPath(new URL('../tsconfig.run.json', import.meta.url)),
      },
    })
    let stderr = ''; gateway.stderr!.on('data', chunk => { stderr += String(chunk) })
    const started = new Promise<void>((resolve, reject) => {
      gateway.once('message', message => {
        try { expect(message).toMatchObject({ kind: stage }); resolve() } catch (error) { reject(error) }
      })
      gateway.once('exit', () => reject(new Error(`Disposable Gateway exited: ${stderr}`)))
      gateway.once('error', reject)
    })
    const attached = f.launcher.attach(f.runtime); handles.push(attached)
    try {
      await started
      const runtime = stage === 'spec-held' ? undefined : await ready(f.root)
      const exited = once(gateway, 'exit'); gateway.kill('SIGKILL'); await exited
      if (runtime !== undefined) {
        expect(await (await fetch(`http://127.0.0.1:${runtime.port}`)).text()).toBe('owned-runtime')
        expect(await attached.isAlive?.()).toBe(true)
      } else await expect(readFile(join(f.root, 'ready.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      await attached.terminate(1000)
      if (runtime !== undefined) await absent(runtime.pid)
      expect((await f.store.read())?.phase).toBe('stopped')
    } finally {
      if (gateway.exitCode === null && gateway.signalCode === null) { const exited = once(gateway, 'exit'); gateway.kill('SIGKILL'); await exited }
    }
  })

  it('escalates an uncooperative runtime and shares concurrent stop settlement', async () => {
    const f = await fixture('ignore-term'), handle = await start(f), runtime = await ready(f.root)
    await Promise.all([handle.terminate(25), handle.terminate(25)])
    await absent(runtime.pid)
    expect((await f.store.read())?.phase).toBe('stopped')
  })

  it('reports an exited recovered Runtime as dead only after kernel and group confirmation', async () => {
    const f = await fixture('controlled-exit')
    await start(f); const runtime = await ready(f.root)
    const recovered = new LocalLauncher(f.cfg).attach(f.runtime); handles.push(recovered)
    expect(await recovered.isAlive?.()).toBe(true)
    await (await fetch(`http://127.0.0.1:${runtime.port}/exit`)).arrayBuffer()
    await vi.waitFor(async () => {
      expect(await recovered.isAlive?.()).toBe(false)
      expect((await f.store.read())?.phase).toBe('stopped')
    }, { timeout: 30_000 })
  })

  it('reaps a descendant after its direct runtime exits while leaving inherited output pipes open', async () => {
    const f = await fixture('descendant'), handle = await start(f), runtime = await ready(f.root)
    await handle.terminate(0)
    await absent(runtime.descendant!)
    expect((await f.store.read())?.phase).toBe('stopped')
  })

  it('does not use another credential generation or missing legacy metadata as stop evidence', async () => {
    const f = await fixture(), handle = await start(f)
    const stale = f.launcher.attach({ ...f.runtime, credentialHash: 'b'.repeat(64) })
    await expect(stale.terminate(0)).rejects.toThrow('evidence is missing')
    expect(await handle.isAlive?.()).toBe(true)
    expect(() => f.launcher.attach({ ...f.runtime, credentialHash: null })).toThrow('Legacy')
  })

  it.each(['running', 'stopped'])('retains uncertain occupancy when an unavailable owner record says %s', async phase => {
    const f = await fixture(), handle = await start(f), runtime = await ready(f.root)
    const original = await readFile(f.store.recordPath, 'utf8')
    const record = JSON.parse(original) as { url: string }
    // Port 0 cannot name an allocated listener; no unrelated host port is acquired.
    // The record claims process-group containment: a native slice claim would hand
    // termination a kernel-authoritative path that needs no reachable endpoint.
    await writeFile(f.store.recordPath, JSON.stringify({ ...record, phase, url: 'http://127.0.0.1:0/', nativeRange: undefined }))
    try {
      await expect(new LocalRuntimeControl(f.store, 100).terminate(0)).rejects.toThrow('capacity remains occupied')
      expect(await (await fetch(`http://127.0.0.1:${runtime.port}`)).text()).toBe('owned-runtime')
    } finally { await writeFile(f.store.recordPath, original) }
    await handle.terminate(0)
  })

  it.each(['transient', 'persistent'] as const)('retains occupancy through %s permission-denied group observations', async mode => {
    const f = await fixture(), handle = await start(f), runtime = await ready(f.root)
    await handle.terminate(0)
    await absent(runtime.pid)
    const record = (await f.store.read())!
    // The scenario exercises process-group containment: strip the native slice
    // claim so stop evidence cannot take the kernel-authoritative systemctl path.
    await writeFile(f.store.recordPath, JSON.stringify({ ...record, nativeRange: undefined }))
    const recovered = new LocalRuntimeControl(f.store, 200)
    const original = process.kill
    let denied = 0
    const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -record.groupPid! && signal === 0 && (mode === 'persistent' || denied === 0)) {
        denied += 1
        throw Object.assign(new Error('Group observation denied'), { code: 'EPERM' })
      }
      return original(pid, signal)
    })
    try {
      if (mode === 'transient') {
        await recovered.terminate(0)
        expect(recovered.hasExited()).toBe(true)
      } else {
        await expect(recovered.terminate(0)).rejects.toThrow('capacity remains occupied')
        expect(recovered.hasExited()).toBe(false)
        await expect(recovered.isAlive()).rejects.toThrow('stop evidence is still occupied')
      }
      expect(denied).toBeGreaterThan(0)
    } finally { probe.mockRestore() }
  })

  it('fences a queued allocation when stop intent arrives before its admission resolves', async () => {
    const f = await fixture()
    let release!: () => void, entered!: () => void
    const admitted = new Promise<void>(resolve => { entered = resolve })
    const admission = new Promise<void>(resolve => { release = resolve })
    const pending = f.launcher.start({ ...f.runtime, gatewayCredential: '{}', beforeAllocation: async () => { entered(); await admission } })
      .then(handle => { handles.push(handle); return 'allocated' }, error => error)
    await admitted
    const stopped = f.launcher.attach(f.runtime).terminate(0).then(() => undefined, error => error)
    try {
      await vi.waitFor(async () => expect(await f.store.cancelled()).toBe(true), { timeout: 30_000 })
      release()
      expect(await pending).toMatchObject({ reason: 'cancelled' })
      expect(await stopped).toBeUndefined()
    } finally { release(); await pending; await stopped }
    await expect(readFile(join(f.root, 'ready.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.store.read())?.phase).toBe('stopped')
  })

  it('keeps a fresh credential generation running when a restored old handle stops again', async () => {
    const f = await fixture(), old = await start(f)
    await ready(f.root); await old.terminate(0)
    const runtime = { ...f.runtime, credentialHash: 'b'.repeat(64) }
    const replacement = await new LocalLauncher(f.cfg).start({ ...runtime, gatewayCredential: '{}' }); handles.push(replacement)
    expect(await replacement.isAlive?.()).toBe(true)
    await f.launcher.attach(f.runtime).terminate(0)
    expect(await replacement.isAlive?.()).toBe(true)
  })

  it('refuses unauthenticated and malformed control without changing the owned runtime', async () => {
    const f = await fixture(), handle = await start(f)
    const record = (await f.store.read())!
    const body = JSON.stringify({ nonce: record.nonce, operation: 'stop', graceMs: 0 })
    expect((await fetch(record.url!, { method: 'POST', body })).status).toBe(403)
    for (const invalid of ['null', '{', JSON.stringify({ nonce: 'wrong', operation: 'stop', graceMs: 0 })]) {
      expect((await fetch(record.url!, { method: 'POST', headers: { authorization: `Bearer ${record.token}` }, body: invalid })).status).toBe(400)
    }
    expect(await handle.isAlive?.()).toBe(true)
  })

  it('does not allocate when cancellation arrives after the durable reservation', async () => {
    const f = await fixture(), controller = new AbortController()
    const original = LocalRuntimeOwnerLease.prototype.create
    const reservation = vi.spyOn(LocalRuntimeOwnerLease.prototype, 'create').mockImplementation(async function (this: LocalRuntimeOwnerLease, bootId) {
      const record = await original.call(this, bootId); controller.abort(); return record
    })
    try {
      const request = { ...f.runtime, gatewayCredential: '{}', signal: controller.signal }
      const allocation = f.launcher.start(request).then(handle => { handles.push(handle); return handle })
      await expect(allocation).rejects.toMatchObject({ reason: 'cancelled' })
      await expect(readFile(join(f.root, 'ready.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await f.store.read())?.groupPid).toBeUndefined()
    } finally { reservation.mockRestore() }
  })

  it('confirms owned cleanup before rejecting a lost descriptor-close acknowledgement', async () => {
    const f = await fixture(), original = LocalRuntimeOwnerLease.prototype.close
    const lostAck = new Error('descriptor close acknowledgement lost')
    let injected = false
    const close = vi.spyOn(LocalRuntimeOwnerLease.prototype, 'close').mockImplementation(async function (this: LocalRuntimeOwnerLease) {
      await original.call(this)
      if (!injected) { injected = true; throw lostAck }
    })
    try {
      const started = f.launcher.start({ ...f.runtime, gatewayCredential: '{}' }).then(handle => { handles.push(handle); return handle })
      await expect(started).rejects.toBe(lostAck)
      expect((await f.store.read())?.phase).toBe('stopped')
    } finally {
      close.mockRestore()
      if (await f.store.read() !== undefined) handles.push(f.launcher.attach(f.runtime))
    }
  })
})
