import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager, RuntimeLeaseUnavailableError } from '../src/instances.ts'
import type { InstanceRepository, RuntimeTarget } from '../src/instances.ts'
import { UserService } from '../src/users.ts'

const FAKE_DSH = `const fs=require('fs'),crypto=require('crypto'),http=require('http');const c=JSON.parse(fs.readFileSync(3,'utf8'));const material=(kind,nonce)=>'dsh-gateway-readiness-v1\\0'+kind+'\\0'+nonce+'\\0'+c.runtime.kind+'\\0'+String(c.runtime.id)+'\\0'+String(c.runtime.generation);const proof=(kind,nonce)=>crypto.createHmac('sha256',c.token).update(material(kind,nonce)).digest('base64url');http.createServer((q,s)=>{if(q.url==='/exit'){s.end('bye');process.exit(0);return}if(q.url==='/api/internal/gateway/readiness'){const nonce=q.headers['x-dsh-gateway-readiness-nonce'];const request=q.headers['x-dsh-gateway-readiness-request'];if(typeof nonce!=='string'||request!==proof('request',nonce)){s.statusCode=403;s.end();return}s.setHeader('content-type','application/json');s.end(JSON.stringify({version:1,runtime:c.runtime,proof:proof('response',nonce)}));return}s.end('ok')}).listen(Number(process.argv[1]),'127.0.0.1')`

let manager: InstanceManager | undefined
afterEach(async () => { await manager?.stopAll() })

async function setup(extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  // A stand-in guard plugin package: the default guardPatch derives from
  // HGW_DSH_REPO_ROOT, and starting fails loud when the patch is absent.
  const guardDir = join(root, 'plugins', 'dsh-directory-guard')
  mkdirSync(guardDir, { recursive: true })
  writeFileSync(join(guardDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-directory-guard',
    type: 'module',
    main: 'lib/index.js',
  }))
  mkdirSync(join(guardDir, 'lib'), { recursive: true })
  writeFileSync(join(guardDir, 'lib', 'index.js'), [
    "import peer from '@deepseek-ai/dsh-profile-peer'",
    'export default `guard:${peer}`',
    '',
  ].join('\n'))
  mkdirSync(join(guardDir, 'src'), { recursive: true })
  writeFileSync(join(guardDir, 'src', 'not-runtime.ts'), 'export const sourceOnly = true\n')
  writeFileSync(join(guardDir, 'cordis.patch.yml'), '- insert: []\n')
  writeFileSync(join(guardDir, 'cordis.admin.patch.yml'), '- id: permission\n  config:\n    presets:\n      danger-full-access:\n        sandbox: danger-full-access\n        approval: never\n')
  const governanceDir = join(root, 'plugins', 'dsh-model-governance')
  mkdirSync(governanceDir, { recursive: true })
  writeFileSync(join(governanceDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-model-governance',
    type: 'module',
    main: 'lib/index.js',
  }))
  mkdirSync(join(governanceDir, 'lib'), { recursive: true })
  writeFileSync(join(governanceDir, 'lib', 'index.js'), [
    "import peer from '@deepseek-ai/dsh-profile-peer'",
    'export default `governance:${peer}`',
    '',
  ].join('\n'))
  mkdirSync(join(governanceDir, 'tests'), { recursive: true })
  writeFileSync(join(governanceDir, 'tests', 'not-runtime.test.js'), 'export const testOnly = true\n')
  writeFileSync(join(governanceDir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: gateway-runtime',
    "      name: '@deepseek-ai/dsh-gateway-runtime'",
    '    - id: governance',
    '',
  ].join('\n'))
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = loadConfig({
    HGW_USERS_ROOT: join(root, 'users'),
    HGW_PROJECT_RUNTIMES_ROOT: join(root, 'project-runtimes'),
    HGW_DSH_REPO_ROOT: root,
    HGW_READINESS_TIMEOUT_MS: '10000',
    HGW_INSTANCE_PORT_BASE: '43100',
    ...extraEnv,
  })
  cfg.dshCommand = [process.execPath, '-e', FAKE_DSH, '{port}']
  const users = new UserService(db, cfg)
  const alice = await users.create({ username: 'alice', password: 'pw-123456' })
  manager = new InstanceManager(db, cfg)
  return { root, db, cfg, users, alice, manager }
}

class ProjectRepository implements InstanceRepository {
  private state = 'stopped'
  private generation = 0

  constructor(private readonly projectPath: string, private readonly port: number) {}

  initialize(): Promise<void> { return Promise.resolve() }
  portOf(_target: RuntimeTarget): Promise<number> { return Promise.resolve(this.port) }
  stateOf(_target: RuntimeTarget): Promise<string> { return Promise.resolve(this.state) }
  generationOf(_target: RuntimeTarget): Promise<number> { return Promise.resolve(this.generation) }
  touch(_target: RuntimeTarget, _at: number): Promise<void> { return Promise.resolve() }
  beginStart(_target: RuntimeTarget, _at: number, _runtimeTokenHash: Buffer): Promise<number> {
    this.state = 'starting'
    this.generation += 1
    return Promise.resolve(this.generation)
  }
  markReady(_target: RuntimeTarget, _generation: number): Promise<void> {
    this.state = 'ready'
    return Promise.resolve()
  }
  idleTargets(_cutoff: number): Promise<RuntimeTarget[]> { return Promise.resolve([]) }
  markStopping(_target: RuntimeTarget): Promise<void> {
    this.state = 'stopping'
    return Promise.resolve()
  }
  markStopped(_target: RuntimeTarget): Promise<void> {
    this.state = 'stopped'
    return Promise.resolve()
  }
  owner(_target: RuntimeTarget): Promise<{
    kind: 'project'
    id: number
    username: string
    homePath: string
    name: string
  }> {
    return Promise.resolve({
      kind: 'project',
      id: 41,
      username: 'project-41',
      homePath: this.projectPath,
      name: 'Compiler',
    })
  }
}

describe('InstanceManager', () => {
  it('spawns, reports ready, and dedupes concurrent starts', async () => {
    const { alice, manager } = await setup()
    const [a, b] = await Promise.all([manager.ensureRunning(alice), manager.ensureRunning(alice)])
    expect(a.port).toBe(43100)
    expect(b.port).toBe(43100)
    expect(await manager.stateOf(alice.id)).toBe('ready')
    const response = await fetch(`http://127.0.0.1:${a.port}/`)
    expect(response.status).toBe(200)
  })

  it('reaps idle instances but keeps active ones', async () => {
    const { db, alice, manager } = await setup({ HGW_IDLE_TIMEOUT_MS: '50' })
    await manager.ensureRunning(alice)
    await manager.wsRef(alice.id, 1)
    await new Promise(r => setTimeout(r, 120))
    expect(await manager.reapIdle()).toBe(0)
    await manager.wsRef(alice.id, -1)
    db.prepare(`UPDATE instances SET last_activity_at = ? WHERE user_id = ?`).run(Date.now() - 60_000, alice.id)
    expect(await manager.reapIdle()).toBe(1)
    expect(await manager.stateOf(alice.id)).toBe('stopped')
  })

  it('treats a crashed ready child as not live and respawns through ensureRunning', async () => {
    const { alice, manager } = await setup({ HGW_INSTANCE_PORT_BASE: '43120' })
    const { port } = await manager.ensureRunning(alice)
    expect(await manager.isLive(alice.id)).toBe(true)
    await fetch(`http://127.0.0.1:${port}/exit`)
    await new Promise(r => setTimeout(r, 50))
    expect(await manager.stateOf(alice.id)).toBe('ready')
    expect(await manager.isLive(alice.id)).toBe(false)
    await manager.ensureRunning(alice)
    expect(await manager.isLive(alice.id)).toBe(true)
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200)
  })

  it('stop terminates the child process', async () => {
    const { alice, manager } = await setup()
    const { port } = await manager.ensureRunning(alice)
    await manager.stop(alice.id)
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
  })

  it('materializes policy packages so profile peers resolve from the compiled runtime', async () => {
    const { root, alice, manager } = await setup()
    const dshHome = join(root, 'users', 'alice', 'dsh')
    const modules = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
    mkdirSync(modules, { recursive: true })
    for (const plugin of ['dsh-directory-guard', 'dsh-model-governance']) {
      symlinkSync(join(root, 'plugins', plugin), join(modules, plugin), 'dir')
    }
    const peerDir = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-profile-peer')
    mkdirSync(peerDir, { recursive: true })
    writeFileSync(join(peerDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-profile-peer',
      type: 'module',
      main: 'index.js',
    }))
    writeFileSync(join(peerDir, 'index.js'), "export default 'profile-peer'\n")

    await manager.ensureRunning(alice)
    // The bundle patch becomes the instance's home-level user layer, applied
    // by dsh over every profile without touching the launch argv.
    expect(readFileSync(join(dshHome, 'cordis.patch.yml'), 'utf8')).toBe(
      '- insert:\n    - id: gateway-runtime\n      name: \'@deepseek-ai/dsh-gateway-runtime\'\n'
      + '    - id: governance\n- insert: []\n',
    )
    for (const plugin of ['dsh-directory-guard', 'dsh-model-governance']) {
      const installed = join(modules, plugin)
      expect(lstatSync(installed).isSymbolicLink()).toBe(false)
      expect(lstatSync(installed).isDirectory()).toBe(true)
      expect(existsSync(join(installed, 'package.json'))).toBe(true)
      expect(existsSync(join(installed, 'lib', 'index.js'))).toBe(true)
      expect(existsSync(join(installed, 'src'))).toBe(false)
      expect(existsSync(join(installed, 'tests'))).toBe(false)
    }
    const guard = await import(`${pathToFileURL(join(modules, 'dsh-directory-guard', 'lib', 'index.js')).href}?guard`)
    const governance = await import(`${pathToFileURL(join(modules, 'dsh-model-governance', 'lib', 'index.js')).href}?governance`)
    expect(guard.default).toBe('guard:profile-peer')
    expect(governance.default).toBe('governance:profile-peer')

    writeFileSync(join(root, 'plugins', 'dsh-model-governance', 'lib', 'index.js'), 'export default \'refreshed\'\n')
    await manager.stop(alice.id)
    await manager.ensureRunning(alice)
    expect(readFileSync(join(modules, 'dsh-model-governance', 'lib', 'index.js'), 'utf8')).toBe(
      "export default 'refreshed'\n",
    )
  })

  it('appends the administrator permission overlay after the restricted guard patch', async () => {
    const { root, users, manager } = await setup({ HGW_INSTANCE_PORT_BASE: '43130' })
    const admin = await users.create({ username: 'admin', password: 'pw-123456', role: 'admin' })
    await manager.ensureRunning(admin)
    const patch = readFileSync(join(root, 'users', 'admin', 'dsh', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- insert: []\n- id: permission\n')
    expect(patch).toContain('danger-full-access:\n        sandbox: danger-full-access\n        approval: never\n')
  })

  it('refuses an administrator start when the configured guard has no admin overlay', async () => {
    const { root, users, manager } = await setup({ HGW_INSTANCE_PORT_BASE: '43150' })
    rmSync(join(root, 'plugins', 'dsh-directory-guard', 'cordis.admin.patch.yml'))
    const admin = await users.create({ username: 'admin', password: 'pw-123456', role: 'admin' })
    await expect(manager.ensureRunning(admin)).rejects.toThrow(/directory-guard admin patch not found/)
    expect(await manager.stateOf(admin.id)).not.toBe('ready')
  })

  it('HGW_GUARD_PATCH=off disables only the directory guard and keeps model governance', async () => {
    const { root, alice, manager } = await setup({ HGW_GUARD_PATCH: 'off', HGW_INSTANCE_PORT_BASE: '43140' })
    await manager.ensureRunning(alice)
    const dshHome = join(root, 'users', 'alice', 'dsh')
    expect(readFileSync(join(dshHome, 'cordis.patch.yml'), 'utf8')).toContain(
      "name: '@deepseek-ai/dsh-gateway-runtime'",
    )
    const modules = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
    expect(lstatSync(join(modules, 'dsh-model-governance')).isSymbolicLink()).toBe(false)
    expect(lstatSync(join(modules, 'dsh-model-governance')).isDirectory()).toBe(true)
    expect(existsSync(join(modules, 'dsh-directory-guard'))).toBe(false)
  })

  it('seeds the company default env into $DSH_HOME/.env on every start', async () => {
    const { root, alice, manager, cfg } = await setup({ HGW_INSTANCE_PORT_BASE: '43180' })
    const seed = join(root, 'company.env')
    writeFileSync(seed, 'DEEPSEEK_API_KEY=company-key\n')
    cfg.defaultEnvFile = seed
    await manager.ensureRunning(alice)
    const target = join(root, 'users', 'alice', 'dsh', '.env')
    expect(readFileSync(target, 'utf8')).toBe('DEEPSEEK_API_KEY=company-key\n')
    // Rotation: a changed company file reaches the instance on its next start.
    writeFileSync(seed, 'DEEPSEEK_API_KEY=rotated\n')
    await manager.stop(alice.id)
    await manager.ensureRunning(alice)
    expect(readFileSync(target, 'utf8')).toBe('DEEPSEEK_API_KEY=rotated\n')
  })

  it('mounts shared persistence and collaboration plugins for project runtimes only', async () => {
    const { root, cfg } = await setup({ HGW_INSTANCE_PORT_BASE: '43190' })
    const projectPath = join(root, 'shared-project')
    mkdirSync(projectPath, { recursive: true })
    const dshHome = join(root, 'project-runtimes', '41', 'dsh')
    mkdirSync(dshHome, { recursive: true })
    writeFileSync(join(dshHome, '.credentials.yaml'), 'DEEPSEEK_API_KEY: personal\n')
    const seed = join(root, 'company.env')
    writeFileSync(seed, 'DEEPSEEK_API_KEY=company-key\n')
    cfg.defaultEnvFile = seed
    manager = new InstanceManager(new ProjectRepository(projectPath, 43190), cfg)

    await manager.ensureRunning({ kind: 'project', id: 41, name: 'Compiler', path: projectPath })

    const patch = readFileSync(join(dshHome, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- id: session-persistence-jsonl\n  disabled: true\n')
    expect(patch).toContain('danger-full-access:\n        sandbox: danger-full-access\n        approval: never\n')
    for (const plugin of [
      '@deepseek-ai/dsh-gateway-runtime',
      '@deepseek-ai/dsh-collaboration-gateway',
      '@deepseek-ai/dsh-collaboration-context',
      '@deepseek-ai/dsh-session-persistence-gateway',
    ]) expect(patch).toContain(`name: '${plugin}'`)
    expect(existsSync(join(dshHome, '.credentials.yaml'))).toBe(false)
    expect(readFileSync(join(dshHome, '.env'), 'utf8')).toBe('DEEPSEEK_API_KEY=company-key\n')
  })

  it('refuses to start when the configured guard patch is missing (fail loud, not unguarded)', async () => {
    const { alice, manager } = await setup({ HGW_GUARD_PATCH: '/nowhere/guard.yml', HGW_INSTANCE_PORT_BASE: '43160' })
    await expect(manager.ensureRunning(alice)).rejects.toThrow(/directory-guard patch not found/)
    expect(await manager.stateOf(alice.id)).not.toBe('ready')
  })

  it('serializes concurrent stop and ensureRunning so state and process stay consistent (no orphan)', async () => {
    const { alice, manager } = await setup()
    await manager.ensureRunning(alice)
    const port = await manager.portOf(alice.id)

    // stop enqueued before ensureRunning: final state is ready, and it is reachable.
    await Promise.all([manager.stop(alice.id), manager.ensureRunning(alice)])
    expect(await manager.stateOf(alice.id)).toBe('ready')
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200)

    // ensureRunning enqueued before stop: final state is stopped, and NOTHING
    // is left listening (the fix's core invariant — no orphaned process).
    await Promise.all([manager.ensureRunning(alice), manager.stop(alice.id)])
    expect(await manager.stateOf(alice.id)).toBe('stopped')
    await expect(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
  })

  it('keeps a runtime stopped until destructive work releases its operation slot', async () => {
    const { root, cfg } = await setup({ HGW_INSTANCE_PORT_BASE: '43210' })
    const projectPath = join(root, 'shared-delete')
    mkdirSync(projectPath, { recursive: true })
    const project = { kind: 'project' as const, id: 41, name: 'Compiler', path: projectPath }
    const target = { kind: 'project' as const, id: project.id }
    manager = new InstanceManager(new ProjectRepository(projectPath, 43210), cfg)
    await manager.ensureRunning(project)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const destructive = manager.withStopped(target, async () => {
      enter()
      expect(await manager!.stateOf(target)).toBe('stopped')
      await held
      return 'deleted'
    })
    await entered

    let restarted = false
    const restart = manager.ensureRunning(project).then((result) => {
      restarted = true
      return result
    })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(restarted).toBe(false)

    release()
    await expect(destructive).resolves.toBe('deleted')
    await expect(restart).resolves.toMatchObject({ port: 43210 })
    expect(await manager.stateOf(target)).toBe('ready')
  })

  it('serializes idle reaping with lease admission and rejects a lease after stop wins', async () => {
    const { db, alice, manager } = await setup({ HGW_IDLE_TIMEOUT_MS: '50', HGW_INSTANCE_PORT_BASE: '43230' })
    await manager.ensureRunning(alice)
    db.prepare(`UPDATE instances SET last_activity_at = ? WHERE user_id = ?`).run(Date.now() - 60_000, alice.id)

    const lease = manager.operationRef(alice.id, 1)
    const reap = manager.reapIdle()
    const [leaseResult, reapResult] = await Promise.allSettled([lease, reap])
    if (leaseResult.status === 'fulfilled') {
      expect(reapResult).toEqual({ status: 'fulfilled', value: 0 })
      await manager.operationRef(alice.id, -1)
      expect(await manager.stateOf(alice.id)).toBe('ready')
    } else {
      expect(leaseResult.reason).toBeInstanceOf(RuntimeLeaseUnavailableError)
      expect(reapResult).toEqual({ status: 'fulfilled', value: 1 })
      expect(await manager.stateOf(alice.id)).toBe('stopped')
    }
  })

  it('keeps release from an old generation from dropping a new operation lease', async () => {
    const { root, cfg, manager: initialManager } = await setup({ HGW_INSTANCE_PORT_BASE: '43240' })
    const projectPath = join(root, 'generation-project')
    mkdirSync(projectPath, { recursive: true })
    const project = { kind: 'project' as const, id: 41, name: 'Generation', path: projectPath }
    const target = { kind: 'project' as const, id: project.id }
    const projectManager = new InstanceManager(new ProjectRepository(projectPath, 43240), cfg)
    manager = projectManager
    const first = await projectManager.ensureRunning(project)
    await projectManager.operationRef(target, 1, first.generation)
    await projectManager.stop(target)
    const second = await projectManager.ensureRunning(project)
    expect(second.generation).toBeGreaterThan(first.generation)
    await projectManager.operationRef(target, 1, second.generation)
    await projectManager.operationRef(target, -1, first.generation)
    const refs = (projectManager as unknown as { operationRefs: Map<string, number> }).operationRefs
    expect([...refs.values()]).toEqual([1])
    await projectManager.operationRef(target, -1, second.generation)
    expect(refs.size).toBe(0)
    // Keep the original setup manager from retaining an unused process map in
    // case the fixture changes its default cleanup order later.
    await initialManager.stopAll()
  })
})
