import { isolatedNodeConfigurationAuthority } from './node-config-fixture.ts'
/** Node configuration keeps effective values separate from validated, revision-bound requests. */
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { testConfig, testEnvironment } from './test-config.ts'
import {
  loadManagedNodeEnvironment, NodeConfigurationStore, parseNodeSettingValues,
  readNodeConfiguration, writeNodeConfiguration,
} from '../src/node-config-store.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hgw-node-config-'))
  roots.push(root)
  const env = testEnvironment(root, { HGW_STATE_ROOT: root, HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECT_RUNTIMES_ROOT: join(root, 'project-runtimes'),
    HGW_DATABASE_URL: 'postgresql://localhost/example_test' })
  const cfg = testConfig(root, env), identity = { organizationId: 'organization-a', nodeId: 'node-a' }
  const store = new NodeConfigurationStore(identity, cfg, env, isolatedNodeConfigurationAuthority)
  await store.initialize()
  return { root, env, cfg, store, identity }
}

it('keeps saved settings unapplied across restarts and rejects stale or wrong-node submissions', async () => {
  const f = await fixture(), initial = await f.store.view(1)
  const changed = { ...initial.desired, HGW_PORT: '9301' }
  const saved = await f.store.save(f.identity, initial.revision, changed, 1)
  expect(saved).toMatchObject({ revision: 1, runningRevision: 0, appliedRevision: 0,
    desired: { HGW_PORT: '9301' }, effective: { HGW_PORT: '8899' } })
  expect((await loadManagedNodeEnvironment(f.env)).HGW_PORT).toBe('8899')
  await expect(f.store.save(f.identity, 0, changed, 1)).rejects.toThrow('revision-conflict')
  await expect(f.store.save({ ...f.identity, nodeId: 'node-b' }, 1, changed, 1)).rejects.toThrow('identity-mismatch')
  const second = new NodeConfigurationStore(f.identity, f.cfg, f.env, isolatedNodeConfigurationAuthority)
  await second.initialize()
  expect((await second.view(1)).desired.HGW_PORT).toBe('9301')
  expect(await readFile(f.cfg.nodeConfigFile, 'utf8')).not.toContain('postgresql:')
})

it('queues exactly the reviewed revision and prevents edits while an apply is pending', async () => {
  const f = await fixture(), initial = await f.store.view(1)
  await expect(f.store.requestApply(f.identity, 0, 1)).rejects.toThrow('already-applied')
  await f.store.save(f.identity, 0, { ...initial.desired, HGW_PORT: '9310' }, 1)
  await expect(f.store.requestApply(f.identity, 0, 1)).rejects.toThrow('revision-conflict')
  const requested = await f.store.requestApply(f.identity, 1, 9)
  expect(requested.operation).toMatchObject({ revision: 1, actor: 9, status: 'pending' })
  await expect(f.store.requestApply(f.identity, 1, 9)).rejects.toThrow('in-progress')
  await expect(f.store.save(f.identity, 1, initial.desired, 1)).rejects.toThrow('in-progress')
})

it('rejects commands, injected lines, invalid ports, origins and paths at the public input parser', async () => {
  const f = await fixture(), { desired } = await f.store.view(1)
  for (const invalid of [
    { ...desired, HGW_DSH_COMMAND: 'anything' },
    { ...desired, HGW_PORT: '65536' }, { ...desired, HGW_PORT: '12\nVALUE=x' },
    { ...desired, HGW_USERS_ROOT: '/' }, { ...desired, HGW_USERS_ROOT: 'relative' },
    { ...desired, HGW_PUBLIC_ORIGINS: 'javascript:example' },
    { ...desired, HGW_PUBLIC_ORIGINS: 'https://user:secret@example.com/' },
    { ...desired, HGW_PUBLIC_ORIGINS: 'https://example.com/path' },
  ]) expect(() => parseNodeSettingValues(invalid, f.env)).toThrow()
})

it('allows one winner across concurrent stores and refuses a copied file from another node', async () => {
  const f = await fixture(), other = new NodeConfigurationStore(f.identity, f.cfg, f.env, isolatedNodeConfigurationAuthority), initial = await f.store.view(1)
  const results = await Promise.allSettled([f.store.save(f.identity, 0, { ...initial.desired, HGW_PORT: '9311' }, 1),
    other.save(f.identity, 0, { ...initial.desired, HGW_PORT: '9312' }, 1)])
  expect(results.map(row => row.status).sort()).toEqual(['fulfilled', 'rejected'])
  const wrong = new NodeConfigurationStore({ ...f.identity, nodeId: 'other' }, f.cfg, f.env, isolatedNodeConfigurationAuthority)
  await expect(wrong.initialize()).rejects.toThrow('identity-mismatch')
  await expect(loadManagedNodeEnvironment({ ...f.env, HGW_COMPUTE_NODE_NAME: 'other' })).rejects.toThrow('bootstrap-identity')
})

it('loads only applied settings and refuses corrupt, public or linked config files', async () => {
  const f = await fixture(), record = (await readNodeConfiguration(f.cfg.nodeConfigFile, f.env))!
  record.appliedRevision = 2; record.revision = 2
  record.applied.HGW_PORT = '9333'
  await writeNodeConfiguration(f.cfg.nodeConfigFile, record)
  expect(await loadManagedNodeEnvironment(f.env)).toMatchObject({ HGW_PORT: '9333', HGW_NODE_CONFIG_REVISION: '2' })
  await chmod(f.cfg.nodeConfigFile, 0o644)
  await expect(readNodeConfiguration(f.cfg.nodeConfigFile, f.env)).rejects.toThrow('private')
  await rm(f.cfg.nodeConfigFile)
  await writeFile(join(f.root, 'target'), '{}', { mode: 0o600 })
  await symlink(join(f.root, 'target'), f.cfg.nodeConfigFile)
  await expect(readNodeConfiguration(f.cfg.nodeConfigFile, f.env)).rejects.toThrow()
  await rm(f.cfg.nodeConfigFile)
  await writeFile(f.cfg.nodeConfigFile, '{invalid', { mode: 0o600 })
  await expect(readNodeConfiguration(f.cfg.nodeConfigFile, f.env)).rejects.toThrow()
  await rm(f.cfg.nodeConfigFile)
  await mkdir(f.cfg.nodeConfigFile)
  await expect(readNodeConfiguration(f.cfg.nodeConfigFile, f.env)).rejects.toThrow('private')
})

it('refuses a durable record whose applied generation exceeds its reviewed revision', async () => {
  const f = await fixture(), record = (await readNodeConfiguration(f.cfg.nodeConfigFile, f.env))!
  await writeNodeConfiguration(f.cfg.nodeConfigFile, { ...record, appliedRevision: record.revision + 1 })
  await expect(loadManagedNodeEnvironment(f.env)).rejects.toThrow('inconsistent-node-configuration-revisions')
})

it('persists node admission limits and upgrades missing additive settings from the bootstrap configuration', async () => {
  const f = await fixture(), initial = await f.store.view(1)
  expect(initial.effective).toMatchObject({ HGW_RUNTIME_MAX_STARTING: '2', HGW_RUNTIME_MAX_RESIDENT: '0', HGW_RUNTIME_MAX_QUEUED: '32', HGW_RUNTIME_QUEUE_WAIT_MS: '30000', HGW_PERFORMANCE_ENABLED: 'true', HGW_PERFORMANCE_EVENT_LOOP_RESOLUTION_MS: '20', HGW_DATABASE_MAX_CONNECTIONS: '10', HGW_DATABASE_MAX_CHECKOUT_QUEUE: '256', HGW_DATABASE_CONNECTION_TIMEOUT_MS: '5000' })
  const next = { ...initial.desired, HGW_RUNTIME_MAX_STARTING: '3', HGW_RUNTIME_MAX_RESIDENT: '10', HGW_PERFORMANCE_ENABLED: 'false' }
  await f.store.save(f.identity, 0, next, 1)
  expect((await readNodeConfiguration(f.cfg.nodeConfigFile, f.env))?.desired).toMatchObject(next)
  const legacy: Record<string, unknown> = { ...initial.desired }
  for (const key of ['HGW_RUNTIME_MAX_STARTING', 'HGW_RUNTIME_MAX_RESIDENT', 'HGW_RUNTIME_MAX_QUEUED', 'HGW_RUNTIME_QUEUE_WAIT_MS', 'HGW_PERFORMANCE_ENABLED', 'HGW_PERFORMANCE_EVENT_LOOP_RESOLUTION_MS', 'HGW_DATABASE_MAX_CONNECTIONS', 'HGW_DATABASE_MAX_CHECKOUT_QUEUE', 'HGW_DATABASE_CONNECTION_TIMEOUT_MS']) delete legacy[key]
  expect(parseNodeSettingValues(legacy, { ...f.env, HGW_RUNTIME_MAX_RESIDENT: '12' })).toMatchObject({ HGW_RUNTIME_MAX_RESIDENT: '12', HGW_RUNTIME_MAX_STARTING: '2' })
  expect(() => parseNodeSettingValues({ ...initial.desired, HGW_RUNTIME_MAX_RESIDENT: null }, f.env)).toThrow('HGW_RUNTIME_MAX_RESIDENT')
  expect(parseNodeSettingValues({ ...initial.desired, HGW_RUNTIME_MAX_STARTING: '9' }, f.env))
    .toMatchObject({ HGW_RUNTIME_MAX_STARTING: '9', HGW_RUNTIME_MAX_RESIDENT: '0' })
  expect(() => parseNodeSettingValues({ ...initial.desired, HGW_RUNTIME_MAX_STARTING: '9', HGW_RUNTIME_MAX_RESIDENT: '8' }, f.env))
    .toThrow('HGW_RUNTIME_MAX_STARTING')
})

it('shows the effective node draft window, keeps saved changes pending, and upgrades settings without those two keys', async () => {
  const f = await fixture()
  const initial = await f.store.view(1)
  expect(initial.effective).toMatchObject({ HGW_DRAFT_HISTORY_REVISIONS: '16', HGW_DRAFT_HISTORY_BYTES: '262144' })
  const next = { ...initial.desired, HGW_DRAFT_HISTORY_REVISIONS: '4', HGW_DRAFT_HISTORY_BYTES: '8192' }
  await f.store.save(f.identity, 0, next, 1)
  const saved = await readNodeConfiguration(f.cfg.nodeConfigFile, f.env)
  expect(saved?.desired).toMatchObject({ HGW_DRAFT_HISTORY_REVISIONS: '4', HGW_DRAFT_HISTORY_BYTES: '8192' })
  expect((await f.store.view(1)).effective).toMatchObject({ HGW_DRAFT_HISTORY_REVISIONS: '16', HGW_DRAFT_HISTORY_BYTES: '262144' })
  const legacy: Record<string, string> = { ...initial.desired }
  delete legacy.HGW_DRAFT_HISTORY_REVISIONS
  delete legacy.HGW_DRAFT_HISTORY_BYTES
  expect(parseNodeSettingValues(legacy, { ...f.env, HGW_DRAFT_HISTORY_REVISIONS: '3' }))
    .toMatchObject({ HGW_DRAFT_HISTORY_REVISIONS: '3', HGW_DRAFT_HISTORY_BYTES: '262144' })
  expect(() => parseNodeSettingValues({ ...initial.desired, HGW_DRAFT_HISTORY_BYTES: '-1' }, f.env)).toThrow('HGW_DRAFT_HISTORY_BYTES')
})
