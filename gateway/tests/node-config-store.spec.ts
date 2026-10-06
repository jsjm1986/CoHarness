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
  const f = await fixture(), initial = await f.store.view()
  const changed = { ...initial.desired, HGW_PORT: '9301' }
  const saved = await f.store.save(f.identity, initial.revision, changed)
  expect(saved).toMatchObject({ revision: 1, runningRevision: 0, appliedRevision: 0,
    desired: { HGW_PORT: '9301' }, effective: { HGW_PORT: '8899' } })
  expect((await loadManagedNodeEnvironment(f.env)).HGW_PORT).toBe('8899')
  await expect(f.store.save(f.identity, 0, changed)).rejects.toThrow('revision-conflict')
  await expect(f.store.save({ ...f.identity, nodeId: 'node-b' }, 1, changed)).rejects.toThrow('identity-mismatch')
  const second = new NodeConfigurationStore(f.identity, f.cfg, f.env, isolatedNodeConfigurationAuthority)
  await second.initialize()
  expect((await second.view()).desired.HGW_PORT).toBe('9301')
  expect(await readFile(f.cfg.nodeConfigFile, 'utf8')).not.toContain('postgresql:')
})

it('queues exactly the reviewed revision and prevents edits while an apply is pending', async () => {
  const f = await fixture(), initial = await f.store.view()
  await expect(f.store.requestApply(f.identity, 0, 1)).rejects.toThrow('already-applied')
  await f.store.save(f.identity, 0, { ...initial.desired, HGW_PORT: '9310' })
  await expect(f.store.requestApply(f.identity, 0, 1)).rejects.toThrow('revision-conflict')
  const requested = await f.store.requestApply(f.identity, 1, 9)
  expect(requested.operation).toMatchObject({ revision: 1, actor: 9, status: 'pending' })
  await expect(f.store.requestApply(f.identity, 1, 9)).rejects.toThrow('in-progress')
  await expect(f.store.save(f.identity, 1, initial.desired)).rejects.toThrow('in-progress')
})

it('rejects commands, injected lines, invalid ports, origins and paths at the public input parser', async () => {
  const f = await fixture(), { desired } = await f.store.view()
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
  const f = await fixture(), other = new NodeConfigurationStore(f.identity, f.cfg, f.env, isolatedNodeConfigurationAuthority), initial = await f.store.view()
  const results = await Promise.allSettled([f.store.save(f.identity, 0, { ...initial.desired, HGW_PORT: '9311' }),
    other.save(f.identity, 0, { ...initial.desired, HGW_PORT: '9312' })])
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
