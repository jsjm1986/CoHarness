import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testConfig } from './test-config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager, INSTANCE_PROFILE, RuntimeLeaseUnavailableError, RuntimeStartBlockedError } from '../src/instances.ts'
import { computeLaunchStamps } from '../src/launch-stamp.ts'
import type { InstanceRepository, RuntimeInstanceSnapshot, RuntimeTarget, RuntimeStopReason, RuntimeStartIntent } from '../src/instances.ts'
import { LocalLauncher, RuntimeLaunchCleanupError, type InstanceProc } from '../src/launcher.ts'
import { CollaborationDeniedError } from '../src/collaboration.ts'
import { RUNTIME_PORT_PUBLISHER, runtimeRelay } from './runtime-relay.ts'
import { UserService } from '../src/users.ts'

const FAKE_DSH = `const fs=require('fs'),crypto=require('crypto'),http=require('http');const c=JSON.parse(fs.readFileSync(3,'utf8'));const material=(kind,nonce)=>'dsh-gateway-readiness-v1\\0'+kind+'\\0'+nonce+'\\0'+c.runtime.kind+'\\0'+String(c.runtime.id)+'\\0'+String(c.runtime.generation);const proof=(kind,nonce)=>crypto.createHmac('sha256',c.token).update(material(kind,nonce)).digest('base64url');http.createServer((q,s)=>{if(q.url==='/exit'){s.end('bye');process.exit(0);return}if(q.url==='/api/internal/gateway/readiness'){const nonce=q.headers['x-dsh-gateway-readiness-nonce'];const request=q.headers['x-dsh-gateway-readiness-request'];if(typeof nonce!=='string'||request!==proof('request',nonce)){s.statusCode=403;s.end();return}s.setHeader('content-type','application/json');const file=process.env.DSH_HOME+'/idle-state.json';const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{policy:'on-demand',canStop:true};const idle=state.legacy?undefined:{...state,proof:state.forged?'invalid':crypto.createHmac('sha256',c.token).update(['dsh-gateway-idle-v1',nonce,c.runtime.kind,String(c.runtime.id),String(c.runtime.generation),state.policy,String(state.canStop)].join('\\0')).digest('base64url')};s.end(JSON.stringify({version:1,runtime:c.runtime,proof:proof('response',nonce),idle}));return}s.end('ok')}).listen(0,'127.0.0.1',function(){${RUNTIME_PORT_PUBLISHER}(process.env.DSH_HOME+'/child-port',this.address().port)})`

let manager: InstanceManager | undefined
const isolatedCleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  try { await manager?.stopAll() } catch (error) { failures.push(error) }
  for (const cleanup of isolatedCleanup.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Instance fixture cleanup failed')
})

// Hold an OS-assigned relay port that forwards to the listener a fixture
// child publishes into its own $DSH_HOME/child-port. The durable port is
// allocated atomically by the kernel; children bind ephemeral listeners, so
// no fixture port is a fixed literal that concurrent processes can claim.
async function claimRuntimePort(dshHome: string): Promise<number> {
  return runtimeRelay(join(dshHome, 'child-port'), dispose => { isolatedCleanup.push(dispose) })
}

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
  isolatedCleanup.push(() => rmSync(root, { recursive: true, force: true }))
  isolatedCleanup.push(() => { db.close() })
  const cfg = testConfig(root, {
    HGW_USERS_ROOT: join(root, 'users'),
    HGW_PROJECT_RUNTIMES_ROOT: join(root, 'project-runtimes'),
    HGW_DSH_REPO_ROOT: root,
    HGW_READINESS_TIMEOUT_MS: '30000',
    HGW_INSTANCE_PORT_BASE: '43100',
    ...extraEnv,
  })
  cfg.dshCommand = [process.execPath, '-e', FAKE_DSH]
  const users = new UserService(db, cfg)
  const realCreate = users.create.bind(users)
  users.create = async (input) => {
    const row = await realCreate(input)
    const port = await claimRuntimePort(join(cfg.usersRoot, input.username, 'dsh'))
    db.prepare('UPDATE instances SET port=? WHERE user_id=?').run(port, row.id)
    return row
  }
  const alice = await users.create({ username: 'alice', password: 'pw-123456' })
  manager = new InstanceManager(db, cfg)
  return { root, db, cfg, users, alice, manager }
}

/** One stamp the build under test mints; fixtures carrying it stay re-attachable. */
const mintedLaunchStamp = (cfg: Parameters<typeof computeLaunchStamps>[0]): string =>
  [...computeLaunchStamps(cfg, '', INSTANCE_PROFILE).stamps][0]!

async function admitFixtureLease(repository: InstanceRepository, target: RuntimeTarget, at: number, generation?: number): Promise<boolean> {
  if (await repository.startEligibility(target) === null || await repository.stateOf(target) !== 'ready'
    || generation !== undefined && await repository.generationOf(target) !== generation) return false
  await repository.touch(target, at)
  return true
}

async function fixtureSnapshot(repository: InstanceRepository, target: RuntimeTarget): Promise<RuntimeInstanceSnapshot> {
  const generation = await repository.generationOf(target)
  return {
    target, state: await repository.stateOf(target), port: await repository.portOf(target), generation,
    launchStamp: await repository.launchStampOf(target, generation),
  }
}

class ProjectRepository implements InstanceRepository {
  private state = 'stopped'
  private generation = 0
  private reason: RuntimeStopReason | null = null
  launchStamp: string | null = null

  constructor(private readonly projectPath: string, private readonly port: number) {}

  initialize(): Promise<void> { return Promise.resolve() }
  snapshotOf(target: RuntimeTarget): Promise<RuntimeInstanceSnapshot> { return fixtureSnapshot(this, target) }
  markExpiredConnectionStopping(): Promise<boolean> { return Promise.resolve(false) }
  personalPolicy(): Promise<null> { return Promise.resolve(null) }
  authorizeAdministrator(): Promise<void> { return Promise.reject(new CollaborationDeniedError('forbidden')) }
  markControlStopping(): Promise<boolean> { return Promise.reject(new CollaborationDeniedError('forbidden')) }
  activeTargets(): Promise<RuntimeTarget[]> { return Promise.resolve([]) }
  portOf(_target: RuntimeTarget): Promise<number> { return Promise.resolve(this.port) }
  stateOf(_target: RuntimeTarget): Promise<string> { return Promise.resolve(this.state) }
  stopReasonOf(_target: RuntimeTarget): Promise<RuntimeStopReason | null> { return Promise.resolve(this.reason) }
  startEligibility(_target: RuntimeTarget): Promise<{ stopReason: RuntimeStopReason | null }> { return Promise.resolve({ stopReason: this.reason }) }
  generationOf(_target: RuntimeTarget): Promise<number> { return Promise.resolve(this.generation) }
  credentialHashOf(): Promise<null> { return Promise.resolve(null) }
  launchStampOf(_target: RuntimeTarget, _generation: number): Promise<string | null> { return Promise.resolve(this.launchStamp) }
  touch(_target: RuntimeTarget, _at: number): Promise<void> { return Promise.resolve() }
  admitLease(target: RuntimeTarget, at: number, generation?: number): Promise<boolean> { return admitFixtureLease(this, target, at, generation) }
  beginStart(_target: RuntimeTarget, _at: number, _runtimeTokenHash: Buffer, _intent?: RuntimeStartIntent, _administratorUserId?: number, _recordActivity?: boolean, launchStamp?: string): Promise<number> {
    this.state = 'starting'
    this.reason = null
    this.generation += 1
    this.launchStamp = launchStamp ?? null
    return Promise.resolve(this.generation)
  }
  markReady(_target: RuntimeTarget, _generation: number): Promise<void> {
    this.state = 'ready'
    return Promise.resolve()
  }
  idleTargets(_cutoff: number): Promise<RuntimeTarget[]> { return Promise.resolve([]) }
  idleTarget(_target: RuntimeTarget, _cutoff: number): Promise<boolean> { return Promise.resolve(false) }
  markStopping(_target: RuntimeTarget, _generation: number, reason: RuntimeStopReason = 'manual'): Promise<boolean> {
    this.reason = reason
    this.state = 'stopping'
    return Promise.resolve(true)
  }
  markStopped(_target: RuntimeTarget): Promise<boolean> {
    this.state = 'stopped'
    return Promise.resolve(true)
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

class SurvivorRepository implements InstanceRepository {
  state = 'ready'
  generation = 7
  launchStamp: string | null
  reason: RuntimeStopReason | null = null

  constructor(private readonly projectPath: string, private readonly port: number, launchStamp: string | null = null) {
    this.launchStamp = launchStamp
  }

  initialize(): Promise<void> { return Promise.resolve() }
  snapshotOf(target: RuntimeTarget): Promise<RuntimeInstanceSnapshot> { return fixtureSnapshot(this, target) }
  markExpiredConnectionStopping(): Promise<boolean> { return Promise.resolve(false) }
  personalPolicy(): Promise<null> { return Promise.resolve(null) }
  authorizeAdministrator(): Promise<void> { return Promise.reject(new CollaborationDeniedError('forbidden')) }
  markControlStopping(): Promise<boolean> { return Promise.reject(new CollaborationDeniedError('forbidden')) }
  activeTargets(): Promise<RuntimeTarget[]> { return Promise.resolve([{ kind: 'project', id: 41 }]) }
  portOf(_target: RuntimeTarget): Promise<number> { return Promise.resolve(this.port) }
  stateOf(_target: RuntimeTarget): Promise<string> { return Promise.resolve(this.state) }
  stopReasonOf(_target: RuntimeTarget): Promise<RuntimeStopReason | null> { return Promise.resolve(this.reason) }
  startEligibility(_target: RuntimeTarget): Promise<{ stopReason: null }> { return Promise.resolve({ stopReason: null }) }
  generationOf(_target: RuntimeTarget): Promise<number> { return Promise.resolve(this.generation) }
  credentialHashOf(): Promise<null> { return Promise.resolve(null) }
  launchStampOf(_target: RuntimeTarget, _generation: number): Promise<string | null> { return Promise.resolve(this.launchStamp) }
  touch(_target: RuntimeTarget, _at: number): Promise<void> { return Promise.resolve() }
  admitLease(target: RuntimeTarget, at: number, generation?: number): Promise<boolean> { return admitFixtureLease(this, target, at, generation) }
  beginStart(_target: RuntimeTarget, _at: number, _runtimeTokenHash: Buffer): Promise<number> {
    throw new Error('survivor should be reattached, not started')
  }
  markReady(_target: RuntimeTarget, _generation: number): Promise<void> { return Promise.resolve() }
  idleTargets(_cutoff: number): Promise<RuntimeTarget[]> { return Promise.resolve([]) }
  idleTarget(_target: RuntimeTarget, _cutoff: number): Promise<boolean> { return Promise.resolve(false) }
  markStopping(_target: RuntimeTarget, _generation: number, reason?: RuntimeStopReason): Promise<boolean> {
    this.reason = reason ?? null
    return Promise.resolve(true)
  }
  markStopped(_target: RuntimeTarget, _generation: number): Promise<boolean> {
    this.state = 'stopped'
    return Promise.resolve(true)
  }
  owner(_target: RuntimeTarget): Promise<{
    kind: 'project'
    id: number
    username: string
    homePath: string
    name: string
  }> {
    return Promise.resolve({
      kind: 'project', id: 41, username: 'project-41', homePath: this.projectPath, name: 'Compiler',
    })
  }
}

class FailingStopRepository implements InstanceRepository {
  readonly attempts: RuntimeTarget[] = []
  launchStamp: string | null = null

  constructor(private readonly failIds: ReadonlySet<number>) {}

  initialize(): Promise<void> { return Promise.resolve() }
  snapshotOf(target: RuntimeTarget): Promise<RuntimeInstanceSnapshot> { return fixtureSnapshot(this, target) }
  markExpiredConnectionStopping(): Promise<boolean> { return Promise.resolve(false) }
  personalPolicy(): Promise<null> { return Promise.resolve(null) }
  authorizeAdministrator(): Promise<void> { return Promise.reject(new CollaborationDeniedError('forbidden')) }
  markControlStopping(): Promise<boolean> { return Promise.reject(new CollaborationDeniedError('forbidden')) }
  activeTargets(): Promise<RuntimeTarget[]> { return Promise.resolve([]) }
  portOf(_target: RuntimeTarget): Promise<number> { return Promise.resolve(43100) }
  stateOf(_target: RuntimeTarget): Promise<string> { return Promise.resolve('ready') }
  stopReasonOf(_target: RuntimeTarget): Promise<RuntimeStopReason | null> { return Promise.resolve(null) }
  startEligibility(_target: RuntimeTarget): Promise<null> { return Promise.resolve(null) }
  generationOf(_target: RuntimeTarget): Promise<number> { return Promise.resolve(1) }
  credentialHashOf(): Promise<null> { return Promise.resolve(null) }
  launchStampOf(): Promise<null> { return Promise.resolve(null) }
  touch(_target: RuntimeTarget, _at: number): Promise<void> { return Promise.resolve() }
  admitLease(target: RuntimeTarget, at: number, generation?: number): Promise<boolean> { return admitFixtureLease(this, target, at, generation) }
  beginStart(): Promise<number> { throw new Error('stopAll regression never starts runtimes') }
  markReady(): Promise<void> { return Promise.resolve() }
  idleTargets(): Promise<RuntimeTarget[]> { return Promise.resolve([]) }
  idleTarget(): Promise<boolean> { return Promise.resolve(false) }
  markStopping(target: RuntimeTarget): Promise<boolean> {
    this.attempts.push(target)
    if (this.failIds.has(target.id)) throw new Error('database unavailable')
    return Promise.resolve(true)
  }
  markStopped(): Promise<boolean> { return Promise.resolve(true) }
  owner(): Promise<null> { return Promise.resolve(null) }
}

describe('InstanceManager', () => {
  it('authorizes destructive cancellation before interrupting a queued project start', async () => {
    const { root, cfg } = await setup({ HGW_RUNTIME_MAX_RESIDENT: '1', HGW_RUNTIME_MAX_STARTING: '1' })
    const repository: InstanceRepository = new ProjectRepository(join(root, 'project'), 43100)
    vi.spyOn(repository, 'activeTargets').mockResolvedValue([{ kind: 'project', id: 42 }])
    const currentState = repository.stateOf.bind(repository)
    vi.spyOn(repository, 'stateOf').mockImplementation(target => target.id === 42 ? Promise.resolve('ready') : currentState(target))
    vi.spyOn(repository, 'owner').mockImplementation(async target => ({
      kind: 'project', id: target.id, username: `project-${String(target.id)}`, homePath: root, name: 'Capacity owner',
    }))
    const markStopping = repository.markStopping.bind(repository)
    let authorized = false
    vi.spyOn(repository, 'markStopping').mockImplementation(async (target, generation, reason, actor) => {
      if (actor !== undefined) {
        if (actor !== 7) throw new CollaborationDeniedError('forbidden')
        authorized = true
      }
      return markStopping(target, generation, reason)
    })
    const start = vi.fn(async () => { throw new Error('The cancelled project must not allocate a process') })
    const owner = new InstanceManager(repository, cfg, {
      instancesOutliveGateway: false, start,
      attach: input => {
        if (input.ownerId !== 42) throw new Error('A cold cancelled assignment must not attach a process')
        return { hasExited: () => true, isAlive: async () => false, terminate: async () => {} }
      },
    })
    manager = owner
    const target = { kind: 'project' as const, id: 41 }
    const starting = owner.ensureRunning({ ...target, name: 'Queued project', path: join(root, 'project') }, 'explicit')
      .catch((error: unknown) => error)
    let removing: Promise<unknown> | undefined
    try {
      await expect.poll(() => owner.capacitySnapshot().queued).toBe(1)
      await expect(owner.withStopped(target, async () => 'removed', 8)).rejects.toMatchObject({ code: 'forbidden' })
      expect(owner.capacitySnapshot().queued).toBe(1)
      removing = owner.withStopped(target, async () => 'removed', 7).catch((error: unknown) => error)
      await expect.poll(() => owner.capacitySnapshot().queued).toBe(0)
      expect(authorized).toBe(true)
      expect(await starting).toMatchObject({ reason: 'cancelled' })
      expect(await removing).toBe('removed')
      expect(start).not.toHaveBeenCalled()
    } finally {
      await owner.stopAll()
      await Promise.all([starting, removing])
    }
  })

  it('preserves an active legacy assignment without inventing its missing recovery credential', async () => {
    const { alice, manager: owner, db, cfg } = await setup()
    await owner.ensureRunning(alice)
    const other = new InstanceManager(db, cfg)
    expect(await other.stateOf(alice.id)).toBe('ready')
    expect(other.capacitySnapshot().resident).toBe(1)
    await expect(other.ensureRunning(alice)).rejects.toMatchObject({ reason: 'unavailable' })
    expect(await owner.isLive(alice.id)).toBe(true)
    await owner.stop(alice.id)
    expect(await owner.stateOf(alice.id)).toBe('stopped')
    await expect(other.stopAll()).rejects.toThrow('Legacy local runtime ownership')
    expect(other.capacitySnapshot().resident).toBe(1)
  })

  it('keeps warm runtimes usable while cold starts wait, merges retries and cancels a queued target on stop', async () => {
    const { alice, manager, users } = await setup({ HGW_RUNTIME_MAX_STARTING: '1', HGW_RUNTIME_MAX_RESIDENT: '2', HGW_RUNTIME_MAX_QUEUED: '1' })
    const bob = await users.create({ username: 'bob', password: 'pw-123456' })
    const cara = await users.create({ username: 'cara', password: 'pw-123456' })
    const dan = await users.create({ username: 'dan', password: 'pw-123456' })
    await manager.ensureRunning(alice)
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    manager.beforeStart = async runtime => { if (runtime.ownerId === bob.id) await barrier }
    try {
      const starting = manager.ensureRunning(bob)
      expect(manager.ensureRunning(bob)).toBe(starting)
      await vi.waitFor(() => { expect(manager.capacitySnapshot().starting).toBe(1) })
      const queued = manager.ensureRunning(cara)
      const cancelled = expect(queued).rejects.toMatchObject({ code: 'INSTANCE_CAPACITY', reason: 'cancelled' })
      await vi.waitFor(() => { expect(manager.capacitySnapshot().queued).toBe(1) })
      await expect(manager.ensureRunning(dan)).rejects.toMatchObject({ reason: 'queue-full' })
      await expect(manager.ensureRunning(alice)).resolves.toHaveProperty('port')
      await manager.stop(cara.id)
      await cancelled
      expect(manager.capacitySnapshot()).toMatchObject({ resident: 2, queued: 0, rejected: 1, cancelled: 1 })
      release()
      await starting
      expect(await manager.isLive(cara.id)).toBe(false)
      expect(await manager.isLive(bob.id)).toBe(true)
      await manager.stop(bob.id)
      expect(manager.capacitySnapshot()).toMatchObject({ resident: 1, starting: 0 })
    } finally { release() }
  })

  it('retains a failed start reservation until process termination succeeds', async () => {
    const { alice, cfg, db } = await setup({ HGW_RUNTIME_MAX_STARTING: '1', HGW_RUNTIME_MAX_RESIDENT: '1' })
    const terminate = vi.fn().mockRejectedValueOnce(new Error('process tree still running')).mockResolvedValue(undefined)
    const proc: InstanceProc = { hasExited: () => true, terminate }
    manager = new InstanceManager(db, cfg, { instancesOutliveGateway: false, start: async () => proc })
    await expect(manager.ensureRunning(alice)).rejects.toThrow('failed to become ready')
    expect(manager.capacitySnapshot()).toMatchObject({ resident: 1, starting: 1 })
    await manager.stop(alice.id)
    expect(terminate).toHaveBeenCalledTimes(2)
    expect(manager.capacitySnapshot()).toMatchObject({ resident: 0, starting: 0 })
  })

  it('refuses an accepted start reaching its operation after shutdown begins', async () => {
    const { alice, root, manager } = await setup()
    const starting = manager.ensureRunning(alice)
    manager.beginShutdown()
    await expect(starting).rejects.toMatchObject({ reason: 'cancelled' })
    expect(manager.capacitySnapshot()).toMatchObject({ resident: 0, starting: 0, queued: 0 })
    expect(existsSync(join(root, 'users', alice.username, 'dsh', 'profiles', 'web'))).toBe(false)
  })

  it('closes start admission before writer draining while retaining ready processes', async () => {
    const { alice, manager, users } = await setup({ HGW_RUNTIME_MAX_STARTING: '1', HGW_RUNTIME_MAX_RESIDENT: '3' })
    const bob = await users.create({ username: 'bob', password: 'pw-123456' })
    const cara = await users.create({ username: 'cara', password: 'pw-123456' })
    await manager.ensureRunning(alice)
    let entered!: () => void, release!: () => void
    const entry = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    manager.beforeStart = async () => { entered(); await barrier }
    const starting = manager.ensureRunning(bob).then(() => undefined, (error: unknown) => error)
    await entry
    const queued = manager.ensureRunning(cara).then(() => undefined, (error: unknown) => error)
    try {
      await vi.waitFor(() => { expect(manager.capacitySnapshot().queued).toBe(1) })
      manager.beginShutdown()
      manager.beginShutdown()
      expect(await queued).toMatchObject({ reason: 'closed' })
      await expect(manager.ensureRunning(alice)).rejects.toMatchObject({ reason: 'closed' })
      await expect(manager.ensureRunning(bob)).rejects.toMatchObject({ reason: 'closed' })
      const refused = manager.startRequest(cara, 'explicit')
      await expect(refused.admission).rejects.toMatchObject({ reason: 'closed' })
      await expect(refused.completion).rejects.toMatchObject({ reason: 'closed' })
      expect(await manager.isLive(alice.id)).toBe(true)
      expect(manager.capacitySnapshot()).toMatchObject({ resident: 2, queued: 0 })
    } finally { release() }
    expect(await starting).toMatchObject({ reason: 'cancelled' })
    await manager.stopAll()
    expect(manager.capacitySnapshot()).toMatchObject({ resident: 0, starting: 0, queued: 0 })
    expect(await manager.isLive(alice.id)).toBe(false)
  })

  it('shutdown waits for a cancelled cold start to settle before returning', async () => {
    const { alice, manager } = await setup()
    let entered!: () => void, release!: () => void
    const entry = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    manager.beforeStart = async () => { entered(); await barrier }
    const starting = manager.ensureRunning(alice)
    const cancelled = expect(starting).rejects.toMatchObject({ reason: 'cancelled' })
    await entry
    let stopped = false
    const shutdown = manager.stopAll().then(() => { stopped = true })
    try {
      await Promise.resolve()
      expect(stopped).toBe(false)
    } finally { release() }
    await cancelled
    await shutdown
    expect(manager.capacitySnapshot()).toMatchObject({ resident: 0, starting: 0, queued: 0 })
    expect(await manager.isLive(alice.id)).toBe(false)
  })

  it('keeps a driver-owned launch failure counted when its process cannot be stopped', async () => {
    const { alice, cfg, db } = await setup({ HGW_RUNTIME_MAX_STARTING: '1', HGW_RUNTIME_MAX_RESIDENT: '1' })
    const terminate = vi.fn().mockRejectedValueOnce(new Error('termination pending')).mockResolvedValue(undefined)
    const proc: InstanceProc = { hasExited: () => false, terminate }
    manager = new InstanceManager(db, cfg, {
      instancesOutliveGateway: false,
      start: async () => { throw new RuntimeLaunchCleanupError(proc, new Error('credential delivery failed')) },
    })
    await expect(manager.ensureRunning(alice)).rejects.toBeInstanceOf(RuntimeLaunchCleanupError)
    expect(manager.capacitySnapshot()).toMatchObject({ resident: 1, starting: 1 })
    await manager.stop(alice.id)
    expect(manager.capacitySnapshot().resident).toBe(0)
  })

  it('reclaims resource accounting only after the owned process range has stopped', async () => {
    const { alice, cfg, db } = await setup()
    let enter!: () => void, exit!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const exited = new Promise<void>(resolve => { exit = resolve })
    const terminate = vi.fn().mockRejectedValueOnce(new Error('termination pending')).mockImplementation(async () => {
      enter()
      await exited
    })
    const proc: InstanceProc = { hasExited: () => false, terminate }
    const stopped = vi.fn(async () => {})
    manager = new InstanceManager(db, cfg, {
      instancesOutliveGateway: false,
      start: async () => { throw new RuntimeLaunchCleanupError(proc, new Error('credential delivery failed')) },
    }, { principalPublicKey: '' }, { stopped, registered: async () => true, admitRuntimeStart: async () => {} })
    await expect(manager.ensureRunning(alice)).rejects.toBeInstanceOf(RuntimeLaunchCleanupError)
    expect(stopped).not.toHaveBeenCalled()
    const stopping = manager.stop(alice.id)
    try {
      await entered
      expect(stopped).not.toHaveBeenCalled()
      expect(manager.capacitySnapshot().resident).toBe(1)
    } finally { exit() }
    await stopping
    expect(stopped.mock.calls).toEqual([[{ kind: 'user', id: alice.id }, 1, 'retain'], [{ kind: 'user', id: alice.id }, 1]])
    expect(manager.capacitySnapshot().resident).toBe(0)
  })

  it('retries captured accounting after a generation change and retains capacity for an unowned replacement', async () => {
    const { root, cfg } = await setup()
    const projectPath = join(root, 'accounting-project')
    mkdirSync(projectPath)
    const repository = new ProjectRepository(projectPath, 43100)
    const proc: InstanceProc = { hasExited: () => false, terminate: vi.fn(async () => {}) }
    const stopped = vi.fn().mockRejectedValueOnce(new Error('accounting unavailable')).mockResolvedValue(undefined)
    manager = new InstanceManager(repository, cfg, {
      instancesOutliveGateway: false,
      start: async () => { throw new RuntimeLaunchCleanupError(proc, new Error('credential delivery failed')) },
    }, { principalPublicKey: '' }, { stopped, registered: async () => true, admitRuntimeStart: async () => {} })
    await expect(manager.ensureRunning({ kind: 'project', id: 41, name: 'Compiler', path: projectPath }))
      .rejects.toBeInstanceOf(RuntimeLaunchCleanupError)
    expect(manager.capacitySnapshot().resident).toBe(1)
    vi.spyOn(repository, 'generationOf').mockResolvedValue(9)
    await expect(manager.stop({ kind: 'project', id: 41 })).rejects.toThrow('termination cannot be confirmed')
    expect(stopped.mock.calls).toEqual([[{ kind: 'project', id: 41 }, 1, 'retain'], [{ kind: 'project', id: 41 }, 1]])
    expect(manager.capacitySnapshot().resident).toBe(1)
    await expect(manager.stopAll()).rejects.toThrow('termination cannot be confirmed')
    manager = undefined
  })

  it('keeps a supervisor survivor counted when attachment cannot confirm its process', async () => {
    const { root, cfg } = await setup()
    const projectPath = join(root, 'uncertain-project')
    mkdirSync(projectPath)
    const start = vi.fn()
    const survivor = new InstanceManager(new SurvivorRepository(projectPath, 43100, mintedLaunchStamp(cfg)), cfg, {
      instancesOutliveGateway: true, start,
      attach: () => { throw new Error('supervisor unavailable') },
    })
    try {
      await expect(survivor.ensureRunning({ kind: 'project', id: 41, name: 'Compiler', path: projectPath }))
        .rejects.toThrow('unconfirmed existing process')
      expect(start).not.toHaveBeenCalled()
      expect(survivor.capacitySnapshot()).toMatchObject({ resident: 1, starting: 0 })
      await expect(survivor.stop({ kind: 'project', id: 41 })).rejects.toThrow('supervisor unavailable')
      expect(survivor.capacitySnapshot().resident).toBe(1)
    } finally { await survivor.stopAll() }
  })

  it.each(['starting', 'stopping'])('requires a confirmed stop before replacing a %s supervisor survivor', async state => {
    const { root, cfg } = await setup({ HGW_RUNTIME_MAX_STARTING: '1', HGW_RUNTIME_MAX_RESIDENT: '1' })
    const projectPath = join(root, `incomplete-${state}`)
    mkdirSync(projectPath)
    const repository = new SurvivorRepository(projectPath, 43100, mintedLaunchStamp(cfg))
    repository.stateOf = async () => state
    const terminate = vi.fn(async () => {})
    const start = vi.fn()
    const survivor = new InstanceManager(repository, cfg, {
      instancesOutliveGateway: true, start,
      attach: () => ({ hasExited: () => false, terminate }),
    })
    try {
      await expect(survivor.ensureRunning({ kind: 'project', id: 41, name: 'Compiler', path: projectPath }, 'explicit'))
        .rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE', message: expect.stringContaining('incomplete start or stop') })
      expect(start).not.toHaveBeenCalled()
      expect(survivor.capacitySnapshot()).toMatchObject({ resident: 1, queued: 0, admitted: 0 })
      await survivor.stop({ kind: 'project', id: 41 })
      expect(terminate).toHaveBeenCalledOnce()
      expect(survivor.capacitySnapshot().resident).toBe(0)
    } finally { await survivor.stopAll() }
  })

  it('spawns, reports ready, and dedupes concurrent starts', async () => {
    const { alice, manager } = await setup()
    const [a, b] = await Promise.all([manager.ensureRunning(alice), manager.ensureRunning(alice)])
    expect(a.port).toBe(await manager.portOf(alice.id))
    expect(b.port).toBe(a.port)
    expect(await manager.stateOf(alice.id)).toBe('ready')
    const response = await fetch(`http://127.0.0.1:${a.port}/`)
    expect(response.status).toBe(200)
  })

  it('cancels before local allocation even when node admission resolves after stop', async () => {
    const { alice, cfg, db } = await setup()
    let entered!: () => void, grant!: () => void
    const admissionEntered = new Promise<void>(resolve => { entered = resolve })
    const admitted = new Promise<void>(resolve => { grant = resolve })
    let captured: { kind: string; id: number; generation: number; signal: AbortSignal } | undefined
    const local = new LocalLauncher(cfg)
    let allocations = 0
    manager = new InstanceManager(db, cfg, {
      instancesOutliveGateway: false,
      start: async (runtime) => {
        const { beforeAllocation, ...allocated } = runtime
        await beforeAllocation?.()
        allocations += 1
        return local.start(allocated)
      },
    }, { principalPublicKey: '' }, {
      stopped: async () => {}, registered: async () => true,
      admitRuntimeStart: async (target, generation, signal) => {
        captured = { ...target, generation, signal }
        entered()
        await admitted
      },
    })
    const pending = manager.ensureRunning(alice)
    const refused = expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
    try {
      expect(await Promise.race([admissionEntered.then(() => 'waiting'), pending.then(() => 'allocated')])).toBe('waiting')
      expect(captured).toMatchObject({ kind: 'user', id: alice.id, generation: 1 })
      expect(existsSync(join(cfg.usersRoot, alice.username, 'dsh', 'child-port'))).toBe(false)
      const stopped = manager.stop(alice.id)
      expect(captured!.signal.aborted).toBe(true)
      grant()
      await refused
      await stopped
      expect(existsSync(join(cfg.usersRoot, alice.username, 'dsh', 'child-port'))).toBe(false)
      expect(allocations).toBe(0)
      expect(manager.capacitySnapshot().resident).toBe(0)
    } finally { grant(); await pending.catch(() => {}) }
  })

  it('waits for accounting registration after the Runtime answers its readiness proof', async () => {
    const { alice, cfg, db } = await setup()
    let observed!: () => void, accept!: () => void
    const checking = new Promise<void>(resolve => { observed = resolve })
    const registration = new Promise<void>(resolve => { accept = resolve })
    manager = new InstanceManager(db, cfg, undefined, { principalPublicKey: '' }, {
      stopped: async () => {}, registered: async () => { observed(); await registration; return true }, admitRuntimeStart: async () => {},
    })
    const starting = manager.ensureRunning(alice)
    try {
      await checking
      expect(await manager.stateOf(alice.id)).toBe('starting')
    } finally { accept() }
    await starting
    expect(await manager.stateOf(alice.id)).toBe('ready')
  })

  it('refuses warm proxy reuse of an unregistered supervisor survivor without stopping it', async () => {
    const { root, cfg } = await setup()
    const projectPath = join(root, 'unregistered-project')
    mkdirSync(projectPath)
    const terminate = vi.fn(async () => {})
    const survivor = new InstanceManager(new SurvivorRepository(projectPath, 43100, mintedLaunchStamp(cfg)), cfg, {
      instancesOutliveGateway: true, start: async () => { throw new Error('unexpected start') },
      attach: () => ({ hasExited: () => false, terminate }),
    }, { principalPublicKey: '' }, { stopped: async () => {}, registered: async () => false, admitRuntimeStart: async () => {} })
    try {
      await expect(survivor.ensureRunning({ kind: 'project', id: 41, name: 'Compiler', path: projectPath }))
        .rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE', message: expect.stringContaining('resource admission') })
      expect(await survivor.isLive({ kind: 'project', id: 41 })).toBe(false)
      expect(terminate).not.toHaveBeenCalled()
    } finally { await survivor.stopAll() }
  })

  it('reattaches a healthy supervisor survivor after a Gateway restart', async () => {
    const { root, cfg } = await setup({ HGW_GUARD_PATCH: 'off' })
    const projectPath = join(root, 'survivor-project')
    mkdirSync(projectPath, { recursive: true })
    const attached = {
      hasExited: () => false,
      isAlive: async () => true,
      terminate: vi.fn(async () => {}),
    }
    const launcher = {
      instancesOutliveGateway: true,
      start: async () => { throw new Error('unexpected survivor start') },
      attach: () => attached,
    }
    const survivorManager = new InstanceManager(
      new SurvivorRepository(projectPath, 43250, mintedLaunchStamp(cfg)),
      cfg,
      launcher,
      { principalPublicKey: '' },
    )
    manager = survivorManager
    const result = await survivorManager.ensureRunning({ kind: 'project', id: 41, name: 'Compiler', path: projectPath })
    expect(result).toEqual({ port: 43250, generation: 7 })
    expect(await survivorManager.isLive({ kind: 'project', id: 41 })).toBe(true)
    await survivorManager.stopAll()
    expect(attached.terminate).not.toHaveBeenCalled()
  })

  it('refuses direct survivor reuse when its liveness query fails without terminating it', async () => {
    const { root, cfg } = await setup(), projectPath = join(root, 'unavailable-survivor')
    mkdirSync(projectPath)
    const terminate = vi.fn(async () => {}), start = vi.fn()
    const local = new InstanceManager(new SurvivorRepository(projectPath, 43250, mintedLaunchStamp(cfg)), cfg, {
      instancesOutliveGateway: false, start,
      attach: () => ({ hasExited: () => false, isAlive: async () => { throw new Error('control endpoint unavailable') }, terminate }),
    })
    try {
      await expect(local.ensureRunning({ kind: 'project', id: 41, name: 'Compiler', path: projectPath }))
        .rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE', reason: 'unavailable' })
      expect(terminate).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled()
      expect(local.capacitySnapshot().resident).toBe(1)
    } finally { await local.stopAll() }
  })

  it.each(['unread', 'isLive', 'ensureRunning'])('recovers and drains local survivors on shutdown after %s', async read => {
    const { root, cfg } = await setup({ HGW_GUARD_PATCH: 'off' })
    const projectPath = join(root, 'local-survivor'); mkdirSync(projectPath)
    const terminate = vi.fn(async () => {})
    const attach = vi.fn(() => ({ hasExited: () => false, isAlive: async () => true, terminate }))
    const local = new InstanceManager(new SurvivorRepository(projectPath, 43250, mintedLaunchStamp(cfg)), cfg, {
      instancesOutliveGateway: false, attach, start: async () => { throw new Error('unexpected replacement') },
    })
    const target = { kind: 'project' as const, id: 41 }
    if (read === 'isLive') expect(await local.isLive(target)).toBe(true)
    if (read === 'ensureRunning') expect(await local.ensureRunning({ ...target, name: 'Compiler', path: projectPath })).toEqual({ port: 43250, generation: 7 })
    await local.stopAll()
    expect(attach).toHaveBeenCalledOnce()
    expect(terminate).toHaveBeenCalledOnce()
    expect(local.capacitySnapshot().resident).toBe(0)
  })

  it.each(['unread', 'isLive'])('retires adopted survivors whose launch stamp is no longer minted despite %s', async read => {
    const { root, cfg } = await setup({ HGW_GUARD_PATCH: 'off' })
    const projectPath = join(root, 'drained-survivor'); mkdirSync(projectPath)
    const terminate = vi.fn(async () => {})
    const attach = vi.fn(() => ({ hasExited: () => false, isAlive: async () => true, terminate }))
    const repository = new SurvivorRepository(projectPath, 43250, 'superseded-stamp')
    const local = new InstanceManager(repository, cfg, {
      instancesOutliveGateway: false, attach, start: async () => { throw new Error('unexpected replacement') },
    })
    const target = { kind: 'project' as const, id: 41 }
    if (read === 'isLive') {
      // A fenced survivor reads as absent without attaching to it.
      expect(await local.isLive(target)).toBe(false)
      expect(attach).not.toHaveBeenCalled()
    }
    const { retired, kept } = await local.retireIncompatibleSurvivors()
    expect(retired).toBe(1)
    expect(kept).toBe(0)
    expect(attach).toHaveBeenCalledOnce()
    expect(terminate).toHaveBeenCalledOnce()
    expect(repository.state).toBe('stopped')
    expect(repository.reason).toBe('shutdown')
  })

  it('keeps an adopted survivor whose launch stamp this build still mints', async () => {
    const { root, cfg } = await setup({ HGW_GUARD_PATCH: 'off' })
    const projectPath = join(root, 'compatible-survivor'); mkdirSync(projectPath)
    const terminate = vi.fn(async () => {})
    const attach = vi.fn(() => ({ hasExited: () => false, isAlive: async () => true, terminate }))
    const repository = new SurvivorRepository(projectPath, 43250, mintedLaunchStamp(cfg))
    const local = new InstanceManager(repository, cfg, {
      instancesOutliveGateway: false, attach, start: async () => { throw new Error('unexpected replacement') },
    })
    const { retired, kept } = await local.retireIncompatibleSurvivors()
    expect(retired).toBe(0)
    expect(kept).toBe(1)
    expect(terminate).not.toHaveBeenCalled()
    expect(await local.isLive({ kind: 'project', id: 41 })).toBe(true)
    expect(await local.ensureRunning({ kind: 'project', id: 41, name: 'Compiler', path: projectPath }))
      .toEqual({ port: 43250, generation: 7 })
    await local.stopAll()
  })

  it('retires a warm survivor with an unminted stamp and falls through to a fresh start', async () => {
    const { root, cfg } = await setup({ HGW_GUARD_PATCH: 'off' })
    const projectPath = join(root, 'stale-survivor'); mkdirSync(projectPath)
    const terminate = vi.fn(async () => {})
    const attach = vi.fn(() => ({ hasExited: () => false, isAlive: async () => true, terminate }))
    const repository = new SurvivorRepository(projectPath, 43250, 'superseded-stamp')
    const start = vi.fn(async () => { throw new Error('replacement is not exercised') })
    const local = new InstanceManager(repository, cfg, { instancesOutliveGateway: false, attach, start })
    await expect(local.ensureRunning({ kind: 'project', id: 41, name: 'Compiler', path: projectPath }))
      .rejects.toThrow('survivor should be reattached')
    // The retire settled the stale generation under `shutdown` before the
    // fresh claim ran into the fixture's own start refusal.
    expect(attach).toHaveBeenCalledOnce()
    expect(terminate).toHaveBeenCalledOnce()
    expect(repository.state).toBe('stopped')
    expect(repository.reason).toBe('shutdown')
    expect(start).not.toHaveBeenCalled()
  })

  it('records the minted launch stamp with the claimed generation', async () => {
    const { alice, manager, db, cfg } = await setup()
    await manager.ensureRunning(alice)
    const row = db.prepare('SELECT launch_stamp FROM instances WHERE user_id=?').get(alice.id) as { launch_stamp: string | null }
    expect(row.launch_stamp).toBe(mintedLaunchStamp(cfg))
  })

  it('reconcile retires a ready row whose launch stamp is no longer minted', async () => {
    const { root, cfg } = await setup({ HGW_GUARD_PATCH: 'off' })
    const projectPath = join(root, 'retired-probe'); mkdirSync(projectPath)
    const repository = new SurvivorRepository(projectPath, 43250, 'superseded-stamp')
    const terminate = vi.fn(async () => {})
    const attach = vi.fn(() => ({ hasExited: () => false, isAlive: async () => true, terminate }))
    const local = new InstanceManager(repository, cfg, {
      instancesOutliveGateway: false, attach, start: async () => { throw new Error('probe path attaches only') },
    })
    const summary = await local.reconcile()
    // The stamp fence runs before any liveness probe: the generation is
    // fenced, terminated and settled under `shutdown`, never counted failed.
    expect(summary.failed).toBe(0)
    expect(attach).toHaveBeenCalledOnce()
    expect(terminate).toHaveBeenCalledOnce()
    expect(repository.state).toBe('stopped')
    expect(repository.reason).toBe('shutdown')
  })

  it('keeps an owned runtime serving across a retaining shutdown', async () => {
    const { db, cfg, alice, manager } = await setup()
    const { port } = await manager.ensureRunning(alice)
    await manager.stopAll(true)
    expect(await manager.stateOf(alice.id)).toBe('ready')
    await expect(fetch(`http://127.0.0.1:${port}/`).then(response => response.text())).resolves.toBe('ok')
    const next = new InstanceManager(db, cfg)
    try {
      expect(await next.stateOf(alice.id)).toBe('ready')
      expect(next.capacitySnapshot().resident).toBe(1)
    } finally { await manager.stopAll() }
    expect(await manager.stateOf(alice.id)).toBe('stopped')
    // The next-boot manager keeps the adopted lease counted until termination
    // is confirmed; the fixture's legacy row carries no recovery credential.
    await expect(next.stopAll()).rejects.toThrow('Legacy local runtime ownership')
  })

  it('warms a shutdown-stopped runtime but never a manual or access-change stop', async () => {
    const { alice, manager, users } = await setup()
    await manager.ensureRunning(alice)
    await manager.stop(alice.id, 'shutdown')
    const first = await manager.reconcile()
    expect(first.warmed).toBe(1)
    expect(await manager.stateOf(alice.id)).toBe('ready')
    const bob = await users.create({ username: 'bob', password: 'pw-123456' })
    await manager.ensureRunning(bob)
    await manager.stop(bob.id, 'manual')
    const cara = await users.create({ username: 'cara', password: 'pw-123456' })
    await manager.ensureRunning(cara)
    await manager.stop(cara.id, 'access-change')
    const second = await manager.reconcile()
    expect(second.warmed).toBe(0)
    expect(await manager.stateOf(bob.id)).toBe('stopped')
    expect(await manager.stateOf(cara.id)).toBe('stopped')
  })

  it('publishes a crashed runtime failed and warms it back ready', async () => {
    const { alice, manager } = await setup()
    const { port } = await manager.ensureRunning(alice)
    await fetch(`http://127.0.0.1:${port}/exit`)
    await expect.poll(() => manager.stateOf(alice.id)).toBe('stopped')
    expect(await manager.stopReasonOf(alice.id)).toBe('failed')
    const summary = await manager.reconcile()
    expect(summary.warmed).toBe(1)
    expect(await manager.stateOf(alice.id)).toBe('ready')
  })

  it('publishes failed for a ready survivor whose process no longer answers', async () => {
    const { root, cfg } = await setup({ HGW_GUARD_PATCH: 'off' })
    const projectPath = join(root, 'dead-survivor'); mkdirSync(projectPath)
    const repository = new SurvivorRepository(projectPath, 43250, mintedLaunchStamp(cfg))
    const markStopping = vi.spyOn(repository, 'markStopping')
    const local = new InstanceManager(repository, cfg, {
      instancesOutliveGateway: false,
      attach: () => ({ hasExited: () => true, isAlive: async () => false, terminate: vi.fn(async () => {}) }),
      start: async () => { throw new Error('probe path attaches only') },
    })
    manager = local
    const summary = await local.reconcile()
    expect(summary.failed).toBe(1)
    expect(markStopping.mock.calls[0]?.[2]).toBe('failed')
  })

  it('reassigns an instance port held by a foreign listener instead of looping EADDRINUSE', async () => {
    const { alice, manager, cfg, db } = await setup()
    const dshHome = join(cfg.usersRoot, 'alice', 'dsh')
    mkdirSync(dshHome, { recursive: true })
    const portFile = join(dshHome, 'child-port')
    const held = new Set<Socket>()
    const squatter = createServer(socket => { held.add(socket); socket.on('close', () => held.delete(socket)) })
    await new Promise<void>(resolve => squatter.listen(0, '127.0.0.1', resolve))
    try {
      writeFileSync(portFile, String((squatter.address() as AddressInfo).port))
      const repository = Reflect.get(manager, 'repository') as InstanceRepository
      const reassign = vi.spyOn(repository, 'reassignPort').mockImplementation(async () => {
        const claimed = await claimRuntimePort(dshHome)
        db.prepare(`UPDATE instances SET port=? WHERE user_id=?`).run(claimed, alice.id)
        rmSync(portFile, { force: true })
        return claimed
      })
      const endpoint = await manager.ensureRunning(alice)
      expect(reassign).toHaveBeenCalledTimes(1)
      const assigned = (db.prepare(`SELECT port FROM instances WHERE user_id=?`).get(alice.id) as { port: number }).port
      expect(endpoint.port).toBe(assigned)
      expect(await manager.stateOf(alice.id)).toBe('ready')
      await expect(fetch(`http://127.0.0.1:${String(endpoint.port)}/`)).resolves.toMatchObject({ status: 200 })
    } finally {
      if (squatter.listening) squatter.close()
      for (const socket of held) socket.destroy()
    }
  })

  it('fails the start loudly when an occupied port cannot be reassigned', async () => {
    const { alice, manager, cfg } = await setup()
    const dshHome = join(cfg.usersRoot, 'alice', 'dsh')
    mkdirSync(dshHome, { recursive: true })
    const portFile = join(dshHome, 'child-port')
    const squatter = createServer(socket => socket.on('error', () => {}))
    await new Promise<void>(resolve => squatter.listen(0, '127.0.0.1', resolve))
    try {
      writeFileSync(portFile, String((squatter.address() as AddressInfo).port))
      const repository = Reflect.get(manager, 'repository') as InstanceRepository
      vi.spyOn(repository, 'reassignPort').mockResolvedValue(undefined)
      await expect(manager.ensureRunning(alice)).rejects.toThrow('cannot be reassigned')
      expect(await manager.stateOf(alice.id)).toBe('stopped')
    } finally { if (squatter.listening) squatter.close() }
  })

  it('finishes an abandoned stopping row under its recorded reason', async () => {
    const { root, cfg } = await setup({ HGW_GUARD_PATCH: 'off' })
    const projectPath = join(root, 'wedged-stopping'); mkdirSync(projectPath)
    const repository = new SurvivorRepository(projectPath, 43250, mintedLaunchStamp(cfg))
    repository.state = 'stopping'
    const markStopping = vi.spyOn(repository, 'markStopping')
    const markStopped = vi.spyOn(repository, 'markStopped')
    const terminate = vi.fn(async () => {})
    const local = new InstanceManager(repository, cfg, {
      instancesOutliveGateway: false,
      attach: () => ({ hasExited: () => true, isAlive: async () => false, terminate } satisfies InstanceProc),
      start: async () => { throw new Error('stop completion attaches only') },
    })
    manager = local
    const summary = await local.reconcile()
    expect(summary.failed).toBe(1)
    expect(terminate).toHaveBeenCalled()
    expect(markStopping.mock.calls[0]?.[2]).toBe('failed')
    expect(markStopped).toHaveBeenCalled()
  })

  it('never warms an idle-stopped runtime — on-demand release stays stopped', async () => {
    const { alice, manager, db } = await setup()
    await manager.ensureRunning(alice)
    await manager.stop(alice.id, 'shutdown')
    db.prepare(`UPDATE instances SET stop_reason='idle' WHERE user_id=?`).run(alice.id)
    const summary = await manager.reconcile()
    expect(summary.warmed).toBe(0)
    expect(await manager.stateOf(alice.id)).toBe('stopped')
  })

  it('does not refresh last activity for a reconcile-warmed start', async () => {
    const { alice, manager, db } = await setup()
    await manager.ensureRunning(alice)
    await manager.stop(alice.id, 'shutdown')
    const stale = Date.now() - 60_000
    db.prepare(`UPDATE instances SET last_activity_at=? WHERE user_id=?`).run(stale, alice.id)
    const summary = await manager.reconcile()
    expect(summary.warmed).toBe(1)
    expect(await manager.stateOf(alice.id)).toBe('ready')
    const row = db.prepare(`SELECT last_activity_at FROM instances WHERE user_id=?`).get(alice.id) as { last_activity_at: number }
    expect(row.last_activity_at).toBe(stale)
  })

  it('skips the dead-stop when the row moved past the observed generation', async () => {
    const { root, cfg } = await setup({ HGW_GUARD_PATCH: 'off' })
    const projectPath = join(root, 'moving-survivor'); mkdirSync(projectPath)
    const repository = new class extends SurvivorRepository {
      override async snapshotOf(target: RuntimeTarget): Promise<RuntimeInstanceSnapshot> {
        const snapshot = await super.snapshotOf(target)
        // Every read after the reconcile probe reports the replacement a
        // racing start already committed.
        this.state = 'starting'
        this.generation = 8
        return snapshot
      }
    }(projectPath, 43250, mintedLaunchStamp(cfg))
    const terminate = vi.fn(async () => {})
    const local = new InstanceManager(repository, cfg, {
      instancesOutliveGateway: false,
      attach: () => ({ hasExited: () => true, isAlive: async () => false, terminate }),
      start: async () => { throw new Error('probe path attaches only') },
    })
    manager = local
    const summary = await local.reconcile()
    expect(summary.failed).toBe(0)
    expect(terminate).not.toHaveBeenCalled()
  })

  it('defers warm retries behind consecutive launch failures instead of a boot budget', async () => {
    const { alice, manager } = await setup({ HGW_RECONCILE_BACKOFF_BASE_MS: '80' })
    await manager.ensureRunning(alice)
    manager.beforeStart = () => Promise.reject(new Error('launch always fails'))
    await manager.stop(alice.id, 'failed')
    const first = await manager.reconcile()
    expect(first.warmed).toBe(0)
    expect(first.deferred).toBe(0)
    const second = await manager.reconcile()
    expect(second.warmed).toBe(0)
    expect(second.deferred).toBe(1)
    await new Promise(r => setTimeout(r, 110))
    const third = await manager.reconcile()
    expect(third.warmed).toBe(0)
    const fourth = await manager.reconcile()
    expect(fourth.deferred).toBe(1)
    // The deferral grows exponentially: after the second failure the row stays
    // deferred inside the doubled interval.
    await new Promise(r => setTimeout(r, 110))
    expect((await manager.reconcile()).deferred).toBe(1)
    manager.beforeStart = undefined
    await new Promise(r => setTimeout(r, 120))
    const recovered = await manager.reconcile()
    expect(recovered.warmed).toBe(1)
    expect(await manager.stateOf(alice.id)).toBe('ready')
  })

  it('clears a reconcile failure streak after the runtime stays ready', async () => {
    const { alice, manager } = await setup({ HGW_RECONCILE_BACKOFF_BASE_MS: '80', HGW_RECONCILE_STABLE_MS: '50' })
    await manager.ensureRunning(alice)
    manager.beforeStart = () => Promise.reject(new Error('boom'))
    await manager.stop(alice.id, 'failed')
    await manager.reconcile()
    manager.beforeStart = undefined
    await new Promise(r => setTimeout(r, 110))
    expect((await manager.reconcile()).warmed).toBe(1)
    // The streak closes only after ready observations spanning the stable
    // window: the first probe stamps liveness, a later one clears the entry.
    await new Promise(r => setTimeout(r, 80))
    await manager.reconcile()
    await new Promise(r => setTimeout(r, 80))
    await manager.reconcile()
    manager.beforeStart = () => Promise.reject(new Error('boom'))
    await manager.stop(alice.id, 'failed')
    await manager.reconcile()
    manager.beforeStart = undefined
    // A cleared streak restarts at the base interval — 110ms clears the 80ms
    // deferral a retained entry would have doubled past.
    await new Promise(r => setTimeout(r, 110))
    expect((await manager.reconcile()).warmed).toBe(1)
    expect(await manager.stateOf(alice.id)).toBe('ready')
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

  it.each([
    { policy: 'resident', canStop: false },
    { policy: 'resident', canStop: true },
    { policy: 'on-demand', canStop: false },
    { policy: 'on-demand', canStop: true, forged: true },
    { legacy: true },
  ])('retains an idle Runtime without an authenticated safe on-demand decision: %j', async state => {
    const { db, alice, manager, root } = await setup()
    const running = await manager.ensureRunning(alice)
    writeFileSync(join(root, 'users', alice.username, 'dsh', 'idle-state.json'), JSON.stringify(state))
    db.prepare('UPDATE instances SET last_activity_at=0 WHERE user_id=?').run(alice.id)
    expect(await manager.reapIdle()).toBe(0)
    expect(await manager.stateOf(alice.id)).toBe('ready')
    expect((await fetch(`http://127.0.0.1:${String(running.port)}/`)).status).toBe(200)
  })

  it('treats a crashed ready child as not live and respawns through ensureRunning', async () => {
    const { alice, manager } = await setup({ HGW_INSTANCE_PORT_BASE: '43120' })
    const { port } = await manager.ensureRunning(alice)
    expect(await manager.isLive(alice.id)).toBe(true)
    await fetch(`http://127.0.0.1:${port}/exit`)
    await vi.waitFor(async () => { expect(await manager.stateOf(alice.id)).toBe('stopped') })
    expect(manager.capacitySnapshot().resident).toBe(0)
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

  it.each([{ failedIds: [] }, { failedIds: [1] }, { failedIds: [1, 2, 3, 4, 5, 6, 7, 8] }])('stopAll drains tracked runtimes with failed targets $failedIds', async ({ failedIds }) => {
    const { cfg } = await setup({ HGW_GUARD_PATCH: 'off' })
    const repository = new FailingStopRepository(new Set(failedIds))
    const stopManager = new InstanceManager(repository, cfg)
    manager = stopManager
    // stopAll drains the tracked-process map; seed the post-start state
    // directly instead of launching nine real runtimes for one ordering
    // regression.
    const procs: unknown = Reflect.get(stopManager, 'procs')
    const generations: unknown = Reflect.get(stopManager, 'procGenerations')
    if (!(procs instanceof Map) || !(generations instanceof WeakMap)) {
      throw new Error('stopAll fixture requires the manager process and generation registries')
    }
    for (let id = 1; id <= 9; id += 1) {
      const proc = { hasExited: () => true, terminate: async () => {} }
      procs.set(`user:${String(id)}`, proc)
      generations.set(proc, 1)
    }
    try {
      if (failedIds.length > 0) await expect(stopManager.stopAll()).rejects.toThrow('database unavailable')
      else await expect(stopManager.stopAll()).resolves.toBeUndefined()
      expect(repository.attempts.map(target => target.id).sort((a, b) => a - b))
        .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    } finally {
      procs.clear()
    }
  })

  it('projects node-specific resource transport limits into the managed plugin configuration', async () => {
    const { root, alice, manager } = await setup({ HGW_RUNTIME_REQUEST_TIMEOUT_MS: '60000', HGW_RUNTIME_CLEANUP_TIMEOUT_MS: '120000',
      HGW_RUNTIME_BROWSER_READY_TIMEOUT_MS: '120000', HGW_RUNTIME_BROWSER_STREAM_TIMEOUT_MS: '60000', HGW_RUNTIME_BROWSER_RPC_TIMEOUT_MS: '120000' })
    await manager.ensureRunning(alice, 'explicit')
    const patch = readFileSync(join(root, 'users', 'alice', 'dsh', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- id: gateway-resource-budget\n  config:\n    requestTimeoutMs: 60000\n    cleanupTimeoutMs: 120000\n')
    expect(patch).toContain('- id: connection\n  config:\n    rpcTimeoutMs: 120000\n    recovery:\n      streamOpenTimeoutMs: 60000\n      generationReadyTimeoutMs: 120000\n')
  })

  it('publishes readable policy code from restrictive release directories while keeping Runtime data private', async () => {
    const { root, alice, manager } = await setup()
    const dshHome = join(root, 'users', 'alice', 'dsh')
    mkdirSync(dshHome, { recursive: true, mode: 0o700 })
    chmodSync(dshHome, 0o700)
    for (const name of ['dsh-directory-guard', 'dsh-model-governance']) {
      const source = join(root, 'plugins', name)
      chmodSync(join(source, 'lib'), 0o770)
      chmodSync(join(source, 'lib', 'index.js'), 0o640)
      mkdirSync(join(source, 'lib', 'nested'), { mode: 0o700 })
      writeFileSync(join(source, 'lib', 'nested', 'worker.js'), 'export {}\n', { mode: 0o600 })
      writeFileSync(join(source, 'lib', 'helper'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
      mkdirSync(join(source, 'locale'), { mode: 0o700 })
      writeFileSync(join(source, 'locale', 'en.json'), '{}\n', { mode: 0o600 })
    }
    await manager.ensureRunning(alice, 'explicit')
    for (const name of ['dsh-directory-guard', 'dsh-model-governance']) {
      const target = join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', name)
      for (const directory of ['', 'lib', 'lib/nested', 'locale']) {
        expect(lstatSync(join(target, directory)).mode & 0o777).toBe(0o755)
      }
      for (const file of ['package.json', 'lib/index.js', 'lib/nested/worker.js', 'locale/en.json', 'cordis.patch.yml']) {
        expect(lstatSync(join(target, file)).mode & 0o777).toBe(0o644)
      }
      expect(lstatSync(join(target, 'lib', 'helper')).mode & 0o777).toBe(0o755)
      expect(lstatSync(join(root, 'plugins', name, 'lib')).mode & 0o777).toBe(0o770)
    }
    expect(lstatSync(dshHome).mode & 0o077).toBe(0)
  })

  it('materializes policy packages so profile peers resolve from the compiled runtime', async () => {
    const { root, alice, manager } = await setup()
    const dshHome = join(root, 'users', 'alice', 'dsh')
    const modules = join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai')
    mkdirSync(modules, { recursive: true })
    for (const plugin of ['dsh-directory-guard', 'dsh-model-governance']) {
      symlinkSync(join(root, 'plugins', plugin), join(modules, plugin), 'dir')
    }
    const peerDir = join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-profile-peer')
    mkdirSync(peerDir, { recursive: true })
    writeFileSync(join(peerDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-profile-peer',
      type: 'module',
      main: 'index.js',
    }))
    writeFileSync(join(peerDir, 'index.js'), "export default 'profile-peer'\n")

    await manager.ensureRunning(alice, 'explicit')
    // The bundle patch becomes the instance's home-level user layer, applied
    // by dsh over every profile without touching the launch argv.
    expect(readFileSync(join(dshHome, 'cordis.patch.yml'), 'utf8')).toBe(
      '- insert:\n    - id: gateway-runtime\n      name: \'@deepseek-ai/dsh-gateway-runtime\'\n'
      + '    - id: governance\n'
      + '- id: gateway-runtime\n  config:\n    requiredPlugins: ["model-governance","gateway-execution","desktop-availability","directory-guard"]\n'
      + '- id: gateway-resource-budget\n  config:\n    requestTimeoutMs: 5000\n    cleanupTimeoutMs: 30000\n'
      + '- id: connection\n  config:\n    rpcTimeoutMs: 30000\n    recovery:\n      streamOpenTimeoutMs: 3000\n      generationReadyTimeoutMs: 15000\n'
      + '- insert: []\n'
      + '- id: plugin-manager\n  inject: [pluginManagementAuthorization]\n  config:\n    authorization: required\n'
      + '- id: api-gateway\n  inject: [executionAuthority]\n'
      + '- id: connection\n  config:\n    serverTiming: true\n'
      + `- id: office-to-pdf\n  config:\n    fontMetadataCacheDirectory: ${JSON.stringify(join(root, 'state', 'cache', 'office-font-metadata'))}\n`
      + "- insert:\n    - id: desktop-availability\n      name: '@deepseek-ai/dsh-gateway-execution/desktop-availability'\n"
      + `- id: remote-desktop-vnc\n  config:\n    endpointsFile: ${JSON.stringify(join(root, 'state', 'remote-desktop', 'endpoints.json'))}\n`
      + `    grantsFile: ${JSON.stringify(join(root, 'state', 'remote-desktop', 'grants.jsonl'))}\n`
      + `    auditFile: ${JSON.stringify(join(root, 'state', 'remote-desktop', 'audit.jsonl'))}\n`
      + `    recordingDir: ${JSON.stringify(join(root, 'state', 'remote-desktop', 'recordings'))}\n`,
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
    await manager.ensureRunning(alice, 'explicit')
    expect(readFileSync(join(modules, 'dsh-model-governance', 'lib', 'index.js'), 'utf8')).toBe(
      "export default 'refreshed'\n",
    )
  })

  it('retains runtime-local font caches when shared metadata is disabled', async () => {
    const { root, alice, manager } = await setup({ HGW_OFFICE_FONT_METADATA_CACHE_DIR: 'off' })
    await manager.ensureRunning(alice, 'explicit')
    expect(readFileSync(join(root, 'users', 'alice', 'dsh', 'cordis.patch.yml'), 'utf8'))
      .not.toContain('fontMetadataCacheDirectory')
  })

  it('disables runtime response timing with node performance observation', async () => {
    const { root, alice, manager } = await setup({ HGW_PERFORMANCE_ENABLED: 'false' })
    await manager.ensureRunning(alice, 'explicit')
    expect(readFileSync(join(root, 'users', 'alice', 'dsh', 'cordis.patch.yml'), 'utf8'))
      .toContain('- id: connection\n  config:\n    serverTiming: false\n')
  })

  it('appends the administrator permission overlay after the restricted guard patch', async () => {
    const { root, users, manager } = await setup({ HGW_INSTANCE_PORT_BASE: '43130' })
    const admin = await users.create({ username: 'admin', password: 'pw-123456', role: 'admin' })
    await manager.ensureRunning(admin)
    const patch = readFileSync(join(root, 'users', 'admin', 'dsh', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- insert: []\n- id: permission\n')
    expect(patch).toContain('danger-full-access:\n        sandbox: danger-full-access\n        approval: never\n')
    expect(patch).toContain('- id: plugin-manager\n  inject: [pluginManagementAuthorization]\n  config:\n    authorization: required\n')
  })

  it('uses the current account role after a personal start waits for resident capacity', async () => {
    const { root, alice, manager, users } = await setup({ HGW_RUNTIME_MAX_RESIDENT: '1', HGW_RUNTIME_MAX_STARTING: '1' })
    const administrator = await users.create({ username: 'queued-admin', password: 'pw-123456', role: 'admin' })
    await users.create({ username: 'keeper-admin', password: 'pw-123456', role: 'admin' })
    await manager.ensureRunning(alice)
    let captured: { role: 'admin' | 'user' | undefined; privileged: boolean | undefined } | undefined
    const refused = new Error('Observed launch policy before allocation')
    manager.beforeStart = runtime => {
      if (runtime.ownerId === administrator.id) {
        captured = { role: runtime.user?.role, privileged: runtime.privileged }
        throw refused
      }
    }
    const queued = manager.ensureRunning(administrator, 'explicit').catch((error: unknown) => error)
    try {
      await expect.poll(() => manager.capacitySnapshot().queued).toBe(1)
      users.setRole(administrator.id, 'user')
      await manager.stop(alice.id)
      expect(await queued).toBe(refused)
      expect(captured).toEqual({ role: 'user', privileged: false })
      expect(readFileSync(join(root, 'users', administrator.username, 'dsh', 'cordis.patch.yml'), 'utf8')).not.toContain('danger-full-access:')
    } finally { await manager.stopAll(); await queued }
  })

  it.each(['role', 'password-reset'] as const)('refuses administrator %s withdrawal during a resident-capacity wait', async change => {
    const { root, alice, manager, users } = await setup({ HGW_RUNTIME_MAX_RESIDENT: '1', HGW_RUNTIME_MAX_STARTING: '1' })
    const target = await users.create({ username: 'controlled-user', password: 'pw-123456' })
    const actor = await users.create({ username: 'acting-admin', password: 'pw-123456', role: 'admin' })
    await users.changeOwnPassword(actor.id, 'pw-123456')
    await users.create({ username: 'keeper-admin', password: 'pw-123456', role: 'admin' })
    await manager.ensureRunning(alice)
    const pending = manager.ensureRunning(target, 'explicit', actor.id).catch((error: unknown) => error)
    try {
      await expect.poll(() => manager.capacitySnapshot().queued).toBe(1)
      if (change === 'role') users.setRole(actor.id, 'user')
      else await users.resetPassword(actor.id, 'pw-replacement')
      await manager.stop(alice.id)
      expect(await pending).toMatchObject({ code: 'forbidden' })
      expect(await manager.stateOf(target.id)).toBe('stopped')
      expect(existsSync(join(root, 'users', target.username, 'dsh', 'child-port'))).toBe(false)
    } finally { await manager.stopAll(); await pending }
  })

  it('refuses administrator authority revoked during policy preparation before allocation', async () => {
    const { root, alice, manager, users } = await setup()
    const actor = await users.create({ username: 'acting-admin', password: 'pw-123456', role: 'admin' })
    await users.changeOwnPassword(actor.id, 'pw-123456')
    await users.create({ username: 'keeper-admin', password: 'pw-123456', role: 'admin' })
    manager.beforeStart = () => { users.setRole(actor.id, 'user') }
    await expect(manager.ensureRunning(alice, 'explicit', actor.id)).rejects.toMatchObject({ code: 'forbidden' })
    expect(await manager.stateOf(alice.id)).toBe('stopped')
    expect(existsSync(join(root, 'users', alice.username, 'dsh', 'child-port'))).toBe(false)
  })

  it.each(['role', 'password-reset'] as const)('rechecks administrator %s qualification inside the final personal policy read', async change => {
    const { root, alice, manager, users } = await setup()
    const actor = await users.create({ username: 'acting-admin', password: 'pw-123456', role: 'admin' })
    await users.changeOwnPassword(actor.id, 'pw-123456')
    await users.create({ username: 'keeper-admin', password: 'pw-123456', role: 'admin' })
    const repository = Reflect.get(manager, 'repository') as InstanceRepository
    const read = repository.personalPolicy.bind(repository)
    let entered!: () => void, release!: () => void
    const observed = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const check = vi.spyOn(repository, 'personalPolicy').mockImplementation(async (id, administratorId) => {
      if (administratorId === actor.id) { entered(); await gate }
      return read(id, administratorId)
    })
    const pending = manager.ensureRunning(alice, 'explicit', actor.id).catch((error: unknown) => error)
    try {
      await observed
      if (change === 'role') users.setRole(actor.id, 'user')
      else await users.resetPassword(actor.id, 'pw-replacement')
      release()
      expect(await pending).toMatchObject({ code: 'forbidden' })
      expect(existsSync(join(root, 'users', alice.username, 'dsh', 'child-port'))).toBe(false)
      expect(await manager.stateOf(alice.id)).toBe('stopped')
    } finally { release(); await pending; check.mockRestore(); await manager.stopAll() }
  })

  it('refuses administrator warm handoff when the owner becomes inactive during refresh', async () => {
    const { alice, manager, users } = await setup()
    const actor = await users.create({ username: 'acting-admin', password: 'pw-123456', role: 'admin' })
    await users.changeOwnPassword(actor.id, 'pw-123456')
    await manager.ensureRunning(alice)
    manager.beforeUse = () => { users.setStatus(alice.id, 'disabled') }
    await expect(manager.ensureRunning(alice, 'explicit', actor.id)).rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
  })

  it('separates pending starts from different initiating administrators', async () => {
    const { alice, manager, users } = await setup()
    const actor = await users.create({ username: 'acting-admin', password: 'pw-123456', role: 'admin' })
    await users.changeOwnPassword(actor.id, 'pw-123456')
    const keeper = await users.create({ username: 'keeper-admin', password: 'pw-123456', role: 'admin' })
    await users.changeOwnPassword(keeper.id, 'pw-123456')
    let entered!: () => void, release!: () => void
    const observed = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    manager.beforeStart = async () => { entered(); await gate }
    const valid = manager.ensureRunning(alice, 'explicit', keeper.id)
    let refused: Promise<unknown> | undefined
    try {
      await observed
      const request = manager.ensureRunning(alice, 'explicit', actor.id)
      refused = request.catch((error: unknown) => error)
      expect(request).not.toBe(valid)
      users.setRole(actor.id, 'user'); release()
      await valid
      expect(await refused).toMatchObject({ code: 'forbidden' })
      expect(await manager.isLive(alice.id)).toBe(true)
    } finally { release(); await Promise.allSettled([valid, refused]); await manager.stopAll() }
  })

  it('refuses an unauthorized stop before cancelling another queued start', async () => {
    const { alice, manager, users } = await setup({ HGW_RUNTIME_MAX_RESIDENT: '1', HGW_RUNTIME_MAX_STARTING: '1' })
    const target = await users.create({ username: 'controlled-user', password: 'pw-123456' })
    const actor = await users.create({ username: 'acting-admin', password: 'pw-123456', role: 'admin' })
    await users.changeOwnPassword(actor.id, 'pw-123456')
    await users.create({ username: 'keeper-admin', password: 'pw-123456', role: 'admin' })
    await manager.ensureRunning(alice)
    const pending = manager.ensureRunning(target)
    try {
      await expect.poll(() => manager.capacitySnapshot().queued).toBe(1)
      users.setRole(actor.id, 'user')
      await expect(manager.stop(target.id, 'manual', actor.id)).rejects.toMatchObject({ code: 'forbidden' })
      expect(manager.capacitySnapshot().queued).toBe(1)
      await manager.stop(alice.id); await pending
      expect(await manager.isLive(target.id)).toBe(true)
    } finally { await manager.stopAll(); await pending.catch(() => {}) }
  })

  it.each(['role', 'password-reset'] as const)('rechecks administrator %s qualification after lifecycle serialization before stopping', async change => {
    const { alice, manager, users } = await setup()
    const actor = await users.create({ username: 'acting-admin', password: 'pw-123456', role: 'admin' })
    await users.changeOwnPassword(actor.id, 'pw-123456')
    await users.create({ username: 'keeper-admin', password: 'pw-123456', role: 'admin' })
    await manager.ensureRunning(alice)
    let entered!: () => void, release!: () => void, admitted!: () => void
    const observed = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const admission = new Promise<void>(resolve => { admitted = resolve })
    manager.beforeUse = async () => { entered(); await gate }
    const repository = Reflect.get(manager, 'repository') as InstanceRepository
    const authorize = repository.authorizeAdministrator.bind(repository)
    const check = vi.spyOn(repository, 'authorizeAdministrator').mockImplementation(async id => { await authorize(id); admitted() })
    const warm = manager.ensureRunning(alice)
    let stopping: Promise<unknown> | undefined
    try {
      await observed
      stopping = manager.stop(alice.id, 'manual', actor.id).catch((error: unknown) => error)
      await admission
      if (change === 'role') users.setRole(actor.id, 'user')
      else await users.resetPassword(actor.id, 'pw-replacement')
      release()
      await warm
      expect(await stopping).toMatchObject({ code: 'forbidden' })
      expect(await manager.isLive(alice.id)).toBe(true)
    } finally { release(); await Promise.allSettled([warm, stopping]); check.mockRestore(); await manager.stopAll() }
  })

  it('refuses warm administrator reuse after its policy callback outlives authority', async () => {
    const { alice, manager, users } = await setup()
    const actor = await users.create({ username: 'acting-admin', password: 'pw-123456', role: 'admin' })
    await users.changeOwnPassword(actor.id, 'pw-123456')
    await users.create({ username: 'keeper-admin', password: 'pw-123456', role: 'admin' })
    await manager.ensureRunning(alice)
    manager.beforeUse = () => { users.setRole(actor.id, 'user') }
    await expect(manager.ensureRunning(alice, 'explicit', actor.id)).rejects.toMatchObject({ code: 'forbidden' })
    expect(await manager.isLive(alice.id)).toBe(true)
  })

  it('retains an older process handle when administrator authority expires during generation lookup', async () => {
    const { alice, manager, users } = await setup()
    const actor = await users.create({ username: 'acting-admin', password: 'pw-123456', role: 'admin' })
    await users.changeOwnPassword(actor.id, 'pw-123456')
    await users.create({ username: 'keeper-admin', password: 'pw-123456', role: 'admin' })
    const running = await manager.ensureRunning(alice)
    const repository = Reflect.get(manager, 'repository') as InstanceRepository
    const read = vi.spyOn(repository, 'generationOf').mockImplementation(async () => {
      users.setRole(actor.id, 'user')
      return running.generation + 1
    })
    try {
      await expect(manager.stop(alice.id, 'manual', actor.id)).rejects.toMatchObject({ code: 'forbidden' })
      const response = await fetch(`http://127.0.0.1:${String(running.port)}`, { signal: AbortSignal.timeout(1000) })
        .then(result => result.text(), () => 'unreachable')
      expect(response).toBe('ok')
    } finally { read.mockRestore(); await manager.stopAll() }
  })

  it('refuses allocation when the personal account role changes during policy preparation', async () => {
    const { root, manager, users } = await setup()
    const administrator = await users.create({ username: 'preparing-admin', password: 'pw-123456', role: 'admin' })
    await users.create({ username: 'keeper-admin', password: 'pw-123456', role: 'admin' })
    manager.beforeStart = runtime => { if (runtime.ownerId === administrator.id) users.setRole(administrator.id, 'user') }
    const result = await manager.ensureRunning(administrator, 'explicit').catch((error: unknown) => error)
    expect(result).toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
    expect(await manager.stateOf(administrator.id)).toBe('stopped')
    expect(existsSync(join(root, 'users', administrator.username, 'dsh', 'child-port'))).toBe(false)
  })

  it('passes the current role to warm policy refresh and refuses an inactive warm owner', async () => {
    const { manager, users } = await setup()
    const administrator = await users.create({ username: 'warm-admin', password: 'pw-123456', role: 'admin' })
    await users.create({ username: 'keeper-admin', password: 'pw-123456', role: 'admin' })
    const first = await manager.ensureRunning(administrator)
    users.setRole(administrator.id, 'user')
    const seen: Array<'admin' | 'user'> = []
    manager.beforeUse = subject => { if ('username' in subject) seen.push(subject.role) }
    expect(await manager.ensureRunning(administrator)).toEqual(first)
    expect(seen).toEqual(['user'])
    users.setStatus(administrator.id, 'disabled')
    await expect(manager.ensureRunning(administrator)).rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
    expect(seen).toEqual(['user'])
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
    const modules = join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai')
    expect(lstatSync(join(modules, 'dsh-model-governance')).isSymbolicLink()).toBe(false)
    expect(lstatSync(join(modules, 'dsh-model-governance')).isDirectory()).toBe(true)
    expect(existsSync(join(modules, 'dsh-directory-guard'))).toBe(false)
    expect(readFileSync(join(dshHome, 'cordis.patch.yml'), 'utf8')).toContain(
      'requiredPlugins: ["model-governance","gateway-execution","desktop-availability"]',
    )
  })

  it('mounts the provisioned desktop driver and managed policy when the node declares a desktop', async () => {
    const driverDir = mkdtempSync(join(tmpdir(), 'hgw-driver-'))
    writeFileSync(join(driverDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp',
      type: 'module',
      main: 'lib/index.js',
    }))
    mkdirSync(join(driverDir, 'lib'), { recursive: true })
    writeFileSync(join(driverDir, 'lib', 'index.js'), 'export default 1\n')
    const { root, alice, manager } = await setup({
      HGW_DESKTOP_ID: 'display-0',
      HGW_DESKTOP_DRIVER_PACKAGE: driverDir,
      HGW_DESKTOP_DRIVER_COMMAND: '/opt/cua/bin/cua-driver',
      HGW_DESKTOP_DRIVER_ARGS: '["mcp","--direct"]',
      HGW_INSTANCE_PORT_BASE: '43400',
    })

    await manager.ensureRunning(alice)

    const dshHome = join(root, 'users', 'alice', 'dsh')
    const patch = readFileSync(join(dshHome, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- id: gateway-execution\n  config:\n    desktop: "display-0"\n')
    expect(patch).toContain("- id: computer-use\n      name: '@deepseek-ai/dsh-computer-use'\n")
    expect(patch).toContain(
      "- id: computer-use-cua-driver-mcp\n      name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'"
      + '\n      config:\n        command: "/opt/cua/bin/cua-driver"\n        args: ["mcp","--direct"]\n',
    )
    const installed = join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-experimental-computer-use-cua-driver-mcp')
    expect(lstatSync(installed).isSymbolicLink()).toBe(false)
    expect(lstatSync(installed).isDirectory()).toBe(true)
    expect(existsSync(join(installed, 'package.json'))).toBe(true)
    expect(existsSync(join(installed, 'lib', 'index.js'))).toBe(true)
  })

  it('mounts the desktop driver without process overrides by default', async () => {
    const driverDir = mkdtempSync(join(tmpdir(), 'hgw-driver-'))
    writeFileSync(join(driverDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp',
      type: 'module',
      main: 'lib/index.js',
    }))
    mkdirSync(join(driverDir, 'lib'), { recursive: true })
    writeFileSync(join(driverDir, 'lib', 'index.js'), 'export default 1\n')
    const { root, alice, manager } = await setup({
      HGW_DESKTOP_ID: 'seat-1',
      HGW_DESKTOP_DRIVER_PACKAGE: driverDir,
      HGW_INSTANCE_PORT_BASE: '43410',
    })

    await manager.ensureRunning(alice)

    const patch = readFileSync(join(root, 'users', 'alice', 'dsh', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- id: gateway-execution\n  config:\n    desktop: "seat-1"\n')
    expect(patch).toContain("- id: computer-use-cua-driver-mcp\n      name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'\n")
    expect(patch).not.toContain('      config:\n        command:')
  })

  it('refuses a managed-desktop start when the provisioned driver package is incomplete', async () => {
    const { alice, manager } = await setup({
      HGW_DESKTOP_ID: 'display-0',
      HGW_DESKTOP_DRIVER_PACKAGE: join(tmpdir(), 'hgw-missing-driver-package'),
      HGW_INSTANCE_PORT_BASE: '43420',
    })
    await expect(manager.ensureRunning(alice)).rejects.toThrow(/policy bundle mount failed/)
    expect(await manager.stateOf(alice.id)).not.toBe('ready')
  })

  it('seeds the company default env into $DSH_HOME/.env on every start', async () => {
    const { root, alice, manager, cfg } = await setup({ HGW_INSTANCE_PORT_BASE: '43180' })
    const seed = join(root, 'company.env')
    writeFileSync(seed, 'DEEPSEEK_API_KEY=company-key\n')
    cfg.defaultEnvFile = seed
    await manager.ensureRunning(alice, 'explicit')
    const target = join(root, 'users', 'alice', 'dsh', '.env')
    expect(readFileSync(target, 'utf8')).toBe('DEEPSEEK_API_KEY=company-key\n')
    // Rotation: a changed company file reaches the instance on its next start.
    writeFileSync(seed, 'DEEPSEEK_API_KEY=rotated\n')
    await manager.stop(alice.id)
    await manager.ensureRunning(alice, 'explicit')
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
    manager = new InstanceManager(new ProjectRepository(projectPath, await claimRuntimePort(dshHome)), cfg)

    await manager.ensureRunning({ kind: 'project', id: 41, name: 'Compiler', path: projectPath })

    const patch = readFileSync(join(dshHome, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- id: session-persistence-jsonl\n  disabled: true\n')
    expect(patch).toContain('requiredPlugins: ["model-governance","gateway-execution","desktop-availability","directory-guard"]')
    expect(patch).toContain('danger-full-access:\n        sandbox: danger-full-access\n        approval: never\n')
    expect(patch).toContain('- id: memory\n  config:\n    space: project\n')
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

  it('preserves a manual stop across manager reconstruction and permits only an explicit start', async () => {
    const { alice, db, cfg, manager: first } = await setup()
    await first.ensureRunning(alice)
    await first.stop(alice.id)
    manager = new InstanceManager(db, cfg)
    await manager.stop(alice.id, 'access-change')
    expect(await manager.stopReasonOf(alice.id)).toBe('manual')
    await expect(manager.ensureRunning(alice)).rejects.toBeInstanceOf(RuntimeStartBlockedError)
    await expect(manager.ensureRunning(alice, 'webhook')).rejects.toBeInstanceOf(RuntimeStartBlockedError)
    expect(await manager.isLive(alice.id)).toBe(false)
    await manager.ensureRunning(alice, 'explicit')
    expect(await manager.isLive(alice.id)).toBe(true)
    expect(await manager.stopReasonOf(alice.id)).toBeNull()
  })

  it('records idle reaping and allows an authorized webhook start', async () => {
    const { alice, db, manager } = await setup()
    await manager.ensureRunning(alice)
    db.prepare('UPDATE instances SET last_activity_at=0 WHERE user_id=?').run(alice.id)
    expect(await manager.reapIdle()).toBe(1)
    expect(await manager.stopReasonOf(alice.id)).toBe('idle')
    await manager.ensureRunning(alice, 'webhook')
    expect(await manager.isLive(alice.id)).toBe(true)
    await manager.stop(alice.id, 'shutdown')
    await expect(manager.ensureRunning(alice, 'webhook')).rejects.toBeInstanceOf(RuntimeStartBlockedError)
  })

  it('refuses maintenance admission before generating or spawning a runtime', async () => {
    const { alice, manager } = await setup()
    manager.startAdmission = async () => { throw new RuntimeStartBlockedError('maintenance') }
    await expect(manager.ensureRunning(alice, 'explicit')).rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
    expect(await manager.stateOf(alice.id)).toBe('stopped')
    expect(await manager.isLive(alice.id)).toBe(false)
  })

  it.each(['disabled', 'deleted'] as const)('does not offer an explicit-start bypass for a %s SQLite owner', async state => {
    const { alice, db, manager } = await setup()
    if (state === 'disabled') db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(alice.id)
    else db.prepare('UPDATE users SET deleted_at=? WHERE id=?').run(Date.now(), alice.id)
    for (const intent of ['passive', 'explicit'] as const) {
      await expect(manager.ensureRunning(alice, intent)).rejects.toMatchObject({
        code: 'INSTANCE_UNAVAILABLE', reason: 'unavailable',
      })
      expect(await manager.stateOf(alice.id)).toBe('stopped')
      expect(await manager.isLive(alice.id)).toBe(false)
    }
  })

  it('classifies a disabled manual-stop owner from current rows before touching its runtime files', async () => {
    const { alice, db, root, manager } = await setup()
    await manager.stop(alice.id, 'manual')
    db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(alice.id)
    expect(alice.status).toBe('active')
    for (const intent of ['passive', 'webhook'] as const) {
      await expect(manager.ensureRunning(alice, intent)).rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE', reason: 'unavailable' })
      expect(await manager.isLive(alice.id)).toBe(false)
    }
    expect(existsSync(join(root, 'users', alice.username, 'dsh', 'profiles', 'web'))).toBe(false)
    expect(await manager.stopReasonOf(alice.id)).toBe('manual')
  })

  it('serializes concurrent stop and ensureRunning so state and process stay consistent (no orphan)', async () => {
    const { alice, manager } = await setup()
    await manager.ensureRunning(alice)
    const port = await manager.portOf(alice.id)

    // stop enqueued before ensureRunning: final state is ready, and it is reachable.
    await Promise.all([manager.stop(alice.id), manager.ensureRunning(alice, 'explicit')])
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
    const port = await claimRuntimePort(join(root, 'project-runtimes', '41', 'dsh'))
    manager = new InstanceManager(new ProjectRepository(projectPath, port), cfg)
    await manager.ensureRunning(project)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const destructive = manager.withStopped(target, async () => {
      enter()
      expect(await manager!.stateOf(target)).toBe('stopping')
      await held
      return 'deleted'
    })
    await entered

    let restarted = false
    const restart = manager.ensureRunning(project, 'explicit').then((result) => {
      restarted = true
      return result
    })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(restarted).toBe(false)

    release()
    await expect(destructive).resolves.toBe('deleted')
    await expect(restart).resolves.toMatchObject({ port })
    expect(await manager.stateOf(target)).toBe('ready')
  })

  it('publishes a confirmed stop after a destructive callback throws synchronously', async () => {
    const { alice, manager } = await setup()
    await manager.ensureRunning(alice)
    const port = await manager.portOf(alice.id)
    const failure = new Error('destructive callback refused')
    await expect(manager.withStopped(alice.id, () => { throw failure })).rejects.toBe(failure)
    expect(await manager.stateOf(alice.id)).toBe('stopped')
    expect(await manager.isLive(alice.id)).toBe(false)
    await expect(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
  })

  it('retains both failures when destructive work and stopped publication fail', async () => {
    const { alice, manager, db } = await setup()
    await manager.ensureRunning(alice)
    const port = await manager.portOf(alice.id)
    const operationFailure = new Error('destructive callback refused'), publicationFailure = new Error('stopped publication refused')
    const prepare = db.prepare.bind(db)
    const interception = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith("UPDATE instances SET state = 'stopped'")) throw publicationFailure
      return prepare(sql)
    })
    try {
      const result = await manager.withStopped(alice.id, async () => { throw operationFailure }).catch((error: unknown) => error)
      expect(result).toBeInstanceOf(AggregateError)
      expect((result as AggregateError).errors).toEqual([operationFailure, publicationFailure])
      expect(await manager.stateOf(alice.id)).toBe('stopping')
      expect(await manager.isLive(alice.id)).toBe(false)
      await expect(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
    } finally { interception.mockRestore() }
  })

  it('reports final accounting failure after destructive work without undoing confirmed termination', async () => {
    const { alice, db, cfg } = await setup()
    const accountingFailure = new Error('final accounting unavailable')
    const stopped = vi.fn(async (_target: RuntimeTarget, _generation: number, registration?: 'remove' | 'retain') => {
      if (registration !== 'retain') throw accountingFailure
    })
    const owner = new InstanceManager(db, cfg, undefined, { principalPublicKey: '' }, {
      stopped, registered: async () => true, admitRuntimeStart: async () => {},
    })
    manager = owner
    await owner.ensureRunning(alice)
    const port = await owner.portOf(alice.id)
    let committed = false
    await expect(owner.withStopped(alice.id, async () => { committed = true })).rejects
      .toMatchObject({ code: 'INSTANCE_STOP_FAILED', cause: accountingFailure })
    expect(committed).toBe(true)
    expect(await owner.stateOf(alice.id)).toBe('stopped')
    expect(owner.capacitySnapshot().resident).toBe(0)
    await expect(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
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

  it.each([false, true])('recovers an expired node binding only after its native process is confirmed stopped (stop failure=%s)', async failStop => {
    const { root, cfg, manager: unused } = await setup()
    const projectPath = join(root, 'renewed-connection')
    mkdirSync(projectPath)
    const retainedFile = join(projectPath, 'retained.txt')
    writeFileSync(retainedFile, 'connection recovery preserves workspace\n')
    const project = { kind: 'project' as const, id: 41, name: 'Renewed connection', path: projectPath }
    const target = { kind: 'project' as const, id: 41 }
    const port = await claimRuntimePort(join(root, 'project-runtimes', '41', 'dsh'))
    const repository: InstanceRepository = new ProjectRepository(projectPath, port)
    let currentBinding = true
    const eligibility = repository.startEligibility.bind(repository), beginStart = repository.beginStart.bind(repository)
    repository.startEligibility = async selected => !currentBinding && await repository.stateOf(selected) !== 'stopped' ? null : eligibility(selected)
    repository.beginStart = async (...args) => { const generation = await beginStart(...args); currentBinding = true; return generation }
    repository.markExpiredConnectionStopping = async (selected, generation) => {
      if (currentBinding || await repository.generationOf(selected) !== generation || await repository.stateOf(selected) === 'stopped') return false
      return repository.markStopping(selected, generation, 'access-change')
    }
    const launcher = new LocalLauncher(cfg), starts = vi.spyOn(launcher, 'start')
    const owned = new InstanceManager(repository, cfg, launcher)
    manager = owned
    const first = await owned.ensureRunning(project, 'explicit')
    const oldProcess = await starts.mock.results[0]!.value
    await owned.operationRef(target, 1, first.generation)
    currentBinding = false
    if (failStop) {
      const stopping = vi.spyOn(oldProcess, 'terminate').mockRejectedValueOnce(new Error('termination not confirmed'))
      try {
        await expect(owned.ensureRunning(project)).rejects.toThrow('termination not confirmed')
        expect(await repository.stateOf(target)).toBe('stopping')
        expect(starts).toHaveBeenCalledOnce()
        expect(await oldProcess.isAlive!()).toBe(true)
      } finally { stopping.mockRestore() }
    }
    const renewed = await owned.ensureRunning(project)
    expect(renewed.generation).toBe(first.generation + 1)
    expect(await oldProcess.isAlive!()).toBe(false)
    expect(await owned.isLive(target)).toBe(true)
    expect(readFileSync(retainedFile, 'utf8')).toBe('connection recovery preserves workspace\n')
    expect(starts).toHaveBeenCalledTimes(2)
    await expect(owned.operationRef(target, 1, first.generation)).rejects.toBeInstanceOf(RuntimeLeaseUnavailableError)
    await unused.stopAll()
  })

  it('keeps release from an old generation from dropping a new operation lease', async () => {
    const { root, cfg, manager: initialManager } = await setup({ HGW_INSTANCE_PORT_BASE: '43240' })
    const projectPath = join(root, 'generation-project')
    mkdirSync(projectPath, { recursive: true })
    const project = { kind: 'project' as const, id: 41, name: 'Generation', path: projectPath }
    const target = { kind: 'project' as const, id: project.id }
    const projectPort = await claimRuntimePort(join(root, 'project-runtimes', '41', 'dsh'))
    const projectManager = new InstanceManager(new ProjectRepository(projectPath, projectPort), cfg)
    manager = projectManager
    const first = await projectManager.ensureRunning(project, 'explicit')
    await projectManager.operationRef(target, 1, first.generation)
    await projectManager.stop(target)
    const second = await projectManager.ensureRunning(project, 'explicit')
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

  it('returns one current endpoint while retaining supervisor and accounting checks on every warm read', async () => {
    const { root, cfg } = await setup({ HGW_GUARD_PATCH: 'off' })
    const projectPath = join(root, 'coherent-endpoint')
    mkdirSync(projectPath, { recursive: true })
    const target = { kind: 'project' as const, id: 41 }
    const snapshot = { target, state: 'ready', port: 43267, generation: 7, launchStamp: mintedLaunchStamp(cfg) }
    const repository = new SurvivorRepository(projectPath, snapshot.port, snapshot.launchStamp)
    repository.snapshotOf = vi.fn(async () => ({ ...snapshot }))
    const attached = { hasExited: () => false, isAlive: vi.fn(async () => true), terminate: vi.fn(async () => {}) }
    const launcher = { instancesOutliveGateway: true, start: vi.fn(async () => { throw new Error('Observation cannot start') }), attach: vi.fn(() => attached) }
    const resources = { registered: vi.fn(async () => true), stopped: vi.fn(async () => {}),
      admitRuntimeStart: vi.fn(async () => { throw new Error('Observation cannot allocate') }) }
    const liveManager = new InstanceManager(repository, cfg, launcher, { principalPublicKey: '' }, resources)
    manager = liveManager
    const expected = { target, port: snapshot.port, generation: snapshot.generation }
    expect(await liveManager.liveEndpoint(target)).toEqual(expected)
    expect(repository.snapshotOf).toHaveBeenCalledTimes(2)
    expect(await liveManager.liveEndpoint(target)).toEqual(expected)
    expect(repository.snapshotOf).toHaveBeenCalledTimes(3)
    expect(resources.registered).toHaveBeenCalledTimes(2)
    expect(resources.registered).toHaveBeenLastCalledWith(target, 7)
    expect(attached.isAlive).toHaveBeenCalledTimes(2)
    resources.registered.mockResolvedValueOnce(false)
    expect(await liveManager.liveEndpoint(target)).toBeNull()
    expect(attached.isAlive).toHaveBeenCalledTimes(2)
    snapshot.generation = 8
    expect(await liveManager.liveEndpoint(target)).toBeNull()
    expect(resources.registered).toHaveBeenCalledTimes(3)
    expect(launcher.start).not.toHaveBeenCalled()
    expect(resources.admitRuntimeStart).not.toHaveBeenCalled()
  })

  it('never combines a retained supervisor from an old generation with the replacement endpoint', async () => {
    const { root, cfg } = await setup({ HGW_GUARD_PATCH: 'off' })
    const projectPath = join(root, 'replaced-endpoint')
    mkdirSync(projectPath, { recursive: true })
    const target = { kind: 'project' as const, id: 41 }
    let generation = 7
    const repository = new SurvivorRepository(projectPath, 43268, mintedLaunchStamp(cfg))
    repository.snapshotOf = async () => ({ target, state: 'ready', port: 43268, generation, launchStamp: repository.launchStamp })
    repository.generationOf = async () => generation
    const attached = { hasExited: () => false, isAlive: vi.fn(async () => true), terminate: vi.fn(async () => {}) }
    const launcher = { instancesOutliveGateway: true, start: vi.fn(async () => { throw new Error('Observation cannot start') }), attach: vi.fn(() => attached) }
    const liveManager = new InstanceManager(repository, cfg, launcher, { principalPublicKey: '' })
    manager = liveManager
    expect(await liveManager.liveEndpoint(target)).toMatchObject({ generation: 7, port: 43268 })
    generation = 8
    expect(await liveManager.liveEndpoint(target)).toBeNull()
    expect(attached.isAlive).toHaveBeenCalledOnce()
    await expect(liveManager.ensureRunning({ ...target, kind: 'project', name: 'Replacement', path: projectPath }))
      .rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE', reason: 'unavailable' })
    expect(launcher.attach).toHaveBeenCalledOnce()
    expect(launcher.start).not.toHaveBeenCalled()
  })

  it('reattaches a supervisor-owned ready runtime in isLive without launching it', async () => {
    const { root, cfg } = await setup({ HGW_GUARD_PATCH: 'off' })
    const projectPath = join(root, 'live-survivor')
    mkdirSync(projectPath, { recursive: true })
    const attached = {
      hasExited: () => false,
      isAlive: vi.fn(async () => true),
      terminate: vi.fn(async () => {}),
    }
    const launcher = {
      instancesOutliveGateway: true,
      start: async () => { throw new Error('isLive must never launch a new generation') },
      attach: vi.fn(() => attached),
    }
    const liveManager = new InstanceManager(
      new SurvivorRepository(projectPath, 43260, mintedLaunchStamp(cfg)),
      cfg,
      launcher,
      { principalPublicKey: '' },
    )
    manager = liveManager
    expect(await liveManager.isLive({ kind: 'project', id: 41 })).toBe(true)
    expect(launcher.attach).toHaveBeenCalledTimes(1)
    expect(attached.isAlive).toHaveBeenCalled()
    expect(await liveManager.isLive({ kind: 'project', id: 41 })).toBe(true)
    expect(launcher.attach).toHaveBeenCalledTimes(1)
    await liveManager.stopAll()
    expect(attached.terminate).not.toHaveBeenCalled()
  })

  it.each(['owner-read', 'attach', 'probe'] as const)('preserves unavailable survivor %s as uncertainty and retains its resident occupation', async phase => {
    const { root, cfg } = await setup({ HGW_GUARD_PATCH: 'off' })
    const projectPath = join(root, 'uncertain-survivor')
    mkdirSync(projectPath, { recursive: true })
    let unavailable = true
    const repository = new (class extends SurvivorRepository {
      override async owner(target: RuntimeTarget) {
        if (unavailable && phase === 'owner-read') throw new Error('owner storage unavailable')
        return super.owner(target)
      }
    })(projectPath, 43263, mintedLaunchStamp(cfg))
    const attached = {
      hasExited: () => false,
      isAlive: vi.fn(async () => { if (unavailable && phase === 'probe') throw new Error('supervisor unavailable'); return true }),
      terminate: vi.fn(async () => {}),
    }
    const launcher = {
      instancesOutliveGateway: true,
      start: vi.fn(async () => { throw new Error('read-only liveness cannot launch') }),
      attach: vi.fn(() => { if (unavailable && phase === 'attach') throw new Error('owner attachment unavailable'); return attached }),
    }
    const resources = { registered: vi.fn(async () => true), stopped: vi.fn(async () => {}),
      admitRuntimeStart: vi.fn(async () => { throw new Error('read-only liveness cannot allocate') }) }
    const liveManager = new InstanceManager(repository, cfg, launcher, { principalPublicKey: '' }, resources)
    manager = liveManager
    const target = { kind: 'project' as const, id: 41 }
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await liveManager.stateOf(target)).toBe('ready')
      expect(liveManager.capacitySnapshot().resident).toBe(1)
      await expect(liveManager.isLive(target)).rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE', reason: 'unavailable' })
      expect(await liveManager.stateOf(target)).toBe('ready')
      expect(await liveManager.generationOf(target)).toBe(7)
      expect(liveManager.capacitySnapshot().resident).toBe(1)
      expect(resources.stopped).not.toHaveBeenCalled()
      unavailable = false
      expect(await liveManager.isLive(target)).toBe(true)
      expect(await liveManager.generationOf(target)).toBe(7)
      expect(launcher.start).not.toHaveBeenCalled()
      expect(attached.terminate).not.toHaveBeenCalled()
      expect(resources.admitRuntimeStart).not.toHaveBeenCalled()
      expect(liveManager.capacitySnapshot().resident).toBe(1)
    } finally { diagnostics.mockRestore() }
  })

  it('does not publish a supervisor handle whose durable state moved on during attach', async () => {
    const { root, cfg } = await setup({ HGW_GUARD_PATCH: 'off' })
    const projectPath = join(root, 'moving-survivor')
    mkdirSync(projectPath, { recursive: true })
    let state = 'ready'
    const repository = new (class extends SurvivorRepository {
      override stateOf(): Promise<string> { return Promise.resolve(state) }
    })(projectPath, 43261, mintedLaunchStamp(cfg))
    const attached = {
      hasExited: () => false,
      isAlive: vi.fn(async () => true),
      terminate: vi.fn(async () => {}),
    }
    const launcher = {
      instancesOutliveGateway: true,
      start: async () => { throw new Error('isLive must never launch a new generation') },
      attach: () => {
        state = 'stopping'
        return attached
      },
    }
    const liveManager = new InstanceManager(repository, cfg, launcher, { principalPublicKey: '' })
    manager = liveManager
    expect(await liveManager.isLive({ kind: 'project', id: 41 })).toBe(false)
    expect(attached.isAlive).not.toHaveBeenCalled()
  })

  it('reattaches a ready local row independently of graceful shutdown retention', async () => {
    const { root, cfg } = await setup({ HGW_GUARD_PATCH: 'off' })
    const projectPath = join(root, 'local-row')
    mkdirSync(projectPath, { recursive: true })
    const launcher = {
      instancesOutliveGateway: false,
      start: async () => { throw new Error('isLive must never launch') },
      attach: vi.fn(() => ({ hasExited: () => false, isAlive: async () => true, terminate: async () => {} })),
    }
    const liveManager = new InstanceManager(
      new SurvivorRepository(projectPath, 43262, mintedLaunchStamp(cfg)),
      cfg,
      launcher,
      { principalPublicKey: '' },
    )
    manager = liveManager
    expect(await liveManager.isLive({ kind: 'project', id: 41 })).toBe(true)
    expect(launcher.attach).toHaveBeenCalledOnce()
  })

  it('rolls back a lease admission when the durable touch fails', async () => {
    const { cfg } = await setup({ HGW_GUARD_PATCH: 'off' })
    const repository: InstanceRepository = new (class extends FailingStopRepository {
      override touch(): Promise<void> { return Promise.reject(new Error('durable touch failed')) }
    })(new Set<number>())
    repository.startEligibility = async () => ({ stopReason: null })
    const touchManager = new InstanceManager(repository, cfg)
    manager = touchManager
    await expect(touchManager.wsRef({ kind: 'user', id: 1 }, 1)).rejects.toThrow('durable touch failed')
    expect(touchManager['wsRefs'].size).toBe(0)
    expect(touchManager['wsTotals'].size).toBe(0)
  })

  it.each(['wsRef', 'operationRef'] as const)('rejects new %s admission after eligibility loss while allowing the existing lease to release', async method => {
    const { db, alice, manager } = await setup()
    db.prepare("UPDATE instances SET state='ready' WHERE user_id=?").run(alice.id)
    await manager[method](alice.id, 1)
    db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(alice.id)
    await expect(manager[method](alice.id, 1)).rejects.toThrow('not ready for a new lease')
    await expect(manager[method](alice.id, -1)).resolves.toBeUndefined()
    expect(manager[method === 'wsRef' ? 'wsRefs' : 'operationRefs'].size).toBe(0)
    expect(await manager.stateOf(alice.id)).toBe('ready')
  })

  it.each(['wsRef', 'operationRef'] as const)('refuses a stale %s generation without changing activity or retaining a reference', async method => {
    const { db, alice, manager } = await setup()
    db.prepare("UPDATE instances SET state='ready' WHERE user_id=?").run(alice.id)
    const activity = () => db.prepare('SELECT last_activity_at FROM instances WHERE user_id=?').get(alice.id)
    const before = activity()
    await expect(manager[method](alice.id, 1, 2)).rejects.toThrow('not ready for a new lease')
    expect(activity()).toEqual(before)
    expect(manager[method === 'wsRef' ? 'wsRefs' : 'operationRefs'].size).toBe(0)
    await expect(manager[method](alice.id, 1, 1)).resolves.toBeUndefined()
    await expect(manager[method](alice.id, -1, 1)).resolves.toBeUndefined()
    expect(manager[method === 'wsRef' ? 'wsRefs' : 'operationRefs'].size).toBe(0)
  })

  it('keeps a lease release applied when the durable touch fails', async () => {
    const { db, alice, manager } = await setup()
    db.prepare(`UPDATE instances SET state='ready' WHERE user_id=?`).run(alice.id)
    await manager.wsRef(alice.id, 1)
    await manager.operationRef(alice.id, 1)
    db.prepare('DROP TABLE instances').run()
    await expect(manager.wsRef(alice.id, -1)).rejects.toThrow()
    await expect(manager.operationRef(alice.id, -1)).rejects.toThrow()
    expect(manager['wsRefs'].size).toBe(0)
    expect(manager['wsTotals'].size).toBe(0)
    expect(manager['operationRefs'].size).toBe(0)
    expect(manager['operationTotals'].size).toBe(0)
  })
})
