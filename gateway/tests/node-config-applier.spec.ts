import { isolatedNodeConfigurationAuthority } from './node-config-fixture.ts'
/** Independent appliers preserve recovery state across rejected and interrupted service restarts. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { testConfig, testEnvironment } from './test-config.ts'
import { NodeConfigurationStore, readNodeConfiguration, writeNodeConfiguration } from '../src/node-config-store.ts'
import { applyNodeConfiguration, recoverNodeConfiguration, type NodeConfigurationApplyHost } from '../src/node-config-applier.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hgw-config-apply-'))
  roots.push(root)
  const env = testEnvironment(root, { HGW_STATE_ROOT: root }), cfg = testConfig(root, env), identity = { organizationId: 'org', nodeId: 'node' }
  const store = new NodeConfigurationStore(identity, cfg, env, isolatedNodeConfigurationAuthority)
  await store.initialize()
  const current = await store.view()
  await store.save(identity, 0, { ...current.desired, HGW_PORT: '9334' })
  await store.requestApply(identity, 1, 7)
  const host: NodeConfigurationApplyHost = {
    signal: new AbortController().signal,
    preflight: vi.fn(async () => {}), restartAndVerify: vi.fn(async () => {}), isHealthy: vi.fn(async () => false),
  }
  return { cfg, env, store, host, apply: () => applyNodeConfiguration(cfg.nodeConfigFile, env, host) }
}

it('preflights the saved revision and confirms the effective revision before completion', async () => {
  const f = await fixture()
  vi.mocked(f.host.restartAndVerify).mockImplementation(async record => {
    expect(record.operation?.status).toBe('applying')
    expect(await readNodeConfiguration(f.cfg.nodeConfigFile, f.env)).toMatchObject({ appliedRevision: 1, previous: { revision: 0 } })
  })
  expect(await f.apply()).toMatchObject({ appliedRevision: 1, operation: { status: 'completed' } })
  expect((await f.store.view()).effective.HGW_PORT).toBe('8899')
  expect(await f.apply()).toBeUndefined()
})

it('records failed preflight without publishing settings or restarting the service', async () => {
  const f = await fixture()
  vi.mocked(f.host.preflight).mockRejectedValue(new Error('writers-not-quiesced'))
  expect(await f.apply()).toMatchObject({ appliedRevision: 0, operation: { status: 'failed', error: 'writers-not-quiesced' } })
  expect(f.host.restartAndVerify).not.toHaveBeenCalled()
})

it('restores the previous configuration and verifies its service after the candidate fails', async () => {
  const f = await fixture(), revisions: number[] = []
  vi.mocked(f.host.restartAndVerify).mockImplementation(async record => {
    revisions.push(record.appliedRevision)
    if (record.appliedRevision === 1) throw new Error('candidate-unhealthy')
  })
  expect(await f.apply()).toMatchObject({ appliedRevision: 0, applied: { HGW_PORT: '8899' },
    desired: { HGW_PORT: '9334' }, operation: { status: 'failed', error: 'candidate-unhealthy; previous-configuration-restored' } })
  expect(revisions).toEqual([1, 0])
})

it('recognizes a completed restart after interruption without restarting again', async () => {
  const f = await fixture(), record = (await readNodeConfiguration(f.cfg.nodeConfigFile, f.env))!
  record.previous = { revision: 0, values: structuredClone(record.applied) }
  record.applied = structuredClone(record.desired); record.appliedRevision = 1; record.operation!.status = 'applying'
  await writeNodeConfiguration(f.cfg.nodeConfigFile, record)
  vi.mocked(f.host.isHealthy).mockResolvedValue(true)
  expect(await f.apply()).toMatchObject({ appliedRevision: 1, operation: { status: 'completed' } })
  expect(f.host.restartAndVerify).not.toHaveBeenCalled()
})

it('keeps local recovery available after both candidate and fallback restarts fail', async () => {
  const f = await fixture()
  vi.mocked(f.host.restartAndVerify).mockRejectedValue(new Error('service-unavailable'))
  expect(await f.apply()).toMatchObject({ appliedRevision: 0, operation: { status: 'failed', error: expect.stringContaining('node-config recover') } })
  vi.mocked(f.host.restartAndVerify).mockResolvedValue(undefined)
  expect(await recoverNodeConfiguration(f.cfg.nodeConfigFile, f.env, f.host)).toMatchObject({ appliedRevision: 0,
    operation: { error: 'previous-configuration-restored-by-local-operator' } })
})

it('stops writing when the database lease is lost and lets a new owner resolve the durable applying state', async () => {
  const f = await fixture(), lifetime = new AbortController()
  const lostHost: NodeConfigurationApplyHost = { ...f.host, signal: lifetime.signal,
    async restartAndVerify() { lifetime.abort(new Error('lease lost')); throw lifetime.signal.reason },
  }
  await expect(applyNodeConfiguration(f.cfg.nodeConfigFile, f.env, lostHost)).rejects.toThrow('lease lost')
  expect(await readNodeConfiguration(f.cfg.nodeConfigFile, f.env)).toMatchObject({ appliedRevision: 1,
    previous: { revision: 0 }, operation: { status: 'applying', error: null } })
  vi.mocked(f.host.isHealthy).mockResolvedValue(true)
  expect(await f.apply()).toMatchObject({ appliedRevision: 1, operation: { status: 'completed' } })
})

it('invalidates an interrupted request before a health acknowledgment when its generation is obsolete', async () => {
  const f = await fixture(), record = (await readNodeConfiguration(f.cfg.nodeConfigFile, f.env))!
  record.previous = { revision: 0, values: structuredClone(record.applied) }
  record.applied = structuredClone(record.desired); record.appliedRevision = 1; record.operation!.status = 'applying'
  await writeNodeConfiguration(f.cfg.nodeConfigFile, record)
  vi.mocked(f.host.preflight).mockRejectedValue(new Error('node-configuration-request-predates-restored-data'))
  expect(await f.apply()).toMatchObject({ appliedRevision: 1, operation: { status: 'failed', error: 'node-configuration-request-predates-restored-data' } })
  expect(f.host.isHealthy).not.toHaveBeenCalled()
  expect(f.host.restartAndVerify).not.toHaveBeenCalled()
})
