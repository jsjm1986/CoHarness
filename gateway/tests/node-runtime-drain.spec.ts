/** Node drain snapshots exact Runtime generations across worker batches and deadline expiry. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { InstanceManager, type InstanceRepository, type RuntimeTarget } from '../src/instances.ts'
import type { Launcher } from '../src/launcher.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import type { RuntimeShutdownOutcome } from '../src/runtime-shutdown.ts'
import { fixtureQueryPool } from './postgres-query-fixture.ts'
import { testConfig } from './test-config.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(count: number, terminate: (id: number) => Promise<RuntimeShutdownOutcome>, initiallyKnown = count) {
  const root = await mkdtemp(join(tmpdir(), 'hgw-runtime-drain-unit-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const targets = Array.from({ length: count }, (_, index): RuntimeTarget => ({
    kind: 'project', id: index + 1, runtimeId: `drain-fixture-${index + 1}` as RuntimeId,
  }))
  const states = new Map(targets.map(target => [target.id, 'ready']))
  const generations = new Map(targets.map(target => [target.id, 100 + target.id]))
  const overrides = {
    initialize: async () => {},
    resolveTarget: async (target: RuntimeTarget) => target,
    activeTargets: vi.fn(async () => targets.filter(target => states.get(target.id) !== 'stopped'))
      .mockResolvedValueOnce(targets.slice(0, initiallyKnown)),
    generationOf: async (target) => generations.get(target.id)!,
    credentialHashOf: async () => 'a'.repeat(64),
    stateOf: async (target) => states.get(target.id)!,
    markStopping: async (target, generation, reason) => {
      expect(reason).toBe('shutdown')
      if (generations.get(target.id) !== generation) return false
      states.set(target.id, 'stopping')
      return true
    },
    markStopped: async (target, generation) => {
      if (generations.get(target.id) !== generation) return false
      states.set(target.id, 'stopped')
      return true
    },
    snapshotOf: async (target) => ({ target, generation: generations.get(target.id)!, state: states.get(target.id)!,
      port: 43_000 + target.id, launchStamp: null, startedAt: 0 }),
    owner: async (target): ReturnType<InstanceRepository['owner']> => ({
      kind: 'project', id: target.id, username: `project-${target.id}`, homePath: root,
    }),
    portOf: async (target) => 43_000 + target.id,
  } satisfies Pick<InstanceRepository, 'initialize' | 'resolveTarget' | 'activeTargets' | 'generationOf' | 'credentialHashOf' | 'stateOf'
    | 'markStopping' | 'markStopped' | 'snapshotOf' | 'owner' | 'portOf'>
  const attach = vi.fn<NonNullable<Launcher['attach']>>((identity) => ({
    hasExited: () => false,
    terminate: () => terminate(identity.ownerId),
  }))
  const config = testConfig(root)
  const pool = fixtureQueryPool(() => { throw new Error('Unexpected SQL in the Runtime drain fixture') })
  const repository = Object.assign(new PostgresInstanceRepository({ pool, organizationId: 'fixture', organizationSlug: 'fixture',
    nodeId: 'fixture', nodeName: 'fixture' }, config.instancePortBase), overrides)
  const manager = new InstanceManager(repository, config, {
    instancesOutliveGateway: true, attach, start: async () => { throw new Error('unexpected start') },
  })
  return { manager, states, generations, repository, attach, targets }
}

it('collects every exact generation despite failed or uncertain stops in earlier batches', async () => {
  const outcomes = ['confirmed', 'failed', 'timeout', 'forced', 'unconfirmed', 'confirmed', 'throws', 'confirmed', 'confirmed', 'confirmed'] as const
  const firstBatch = deferred(), release = deferred()
  const attempted: number[] = []
  let inFlight = 0, peak = 0
  const f = await fixture(outcomes.length, async (id) => {
    expect(f.states.get(id)).toBe('stopping')
    attempted.push(id)
    peak = Math.max(peak, ++inFlight)
    if (attempted.length === 8) firstBatch.resolve()
    await release.promise
    inFlight -= 1
    const outcome = outcomes[id - 1]!
    if (outcome === 'throws') throw new Error('failed to terminate runtime process')
    return outcome
  })
  const drain = f.manager.drainForShutdown()
  try {
    await firstBatch.promise
    expect(attempted).toHaveLength(8)
    expect(f.manager.drainForShutdown()).toBe(drain)
  } finally { release.resolve() }
  const report = await drain.completion
  expect(report).toMatchObject({ inventory: 'complete', deadlineExceeded: false, succeeded: false })
  expect(peak).toBe(8)
  expect(attempted.toSorted((a, b) => a - b)).toEqual(f.targets.map(target => target.id))
  for (const entry of report.runtimes) {
    const outcome = outcomes[entry.target.id - 1]
    expect(entry.generation).toBe(100 + entry.target.id)
    if (outcome === 'throws') {
      expect(entry).toMatchObject({ state: 'failed', error: 'Error' })
      expect(f.states.get(entry.target.id)).toBe('stopping')
    } else {
      expect(entry).toMatchObject({ state: 'stopped', shutdownOutcome: outcome })
      expect(f.states.get(entry.target.id)).toBe('stopped')
    }
  }
})

it('reports in-flight and queued generations at the node deadline and stops dispatching more work', async () => {
  const firstBatch = deferred(), release = deferred()
  const attempted: number[] = []
  const f = await fixture(10, async (id) => {
    attempted.push(id)
    if (attempted.length === 8) firstBatch.resolve()
    await release.promise
    return 'confirmed'
  })
  const drain = f.manager.drainForShutdown()
  try {
    await firstBatch.promise
    const report = drain.expire()
    expect(report).toMatchObject({ inventory: 'complete', deadlineExceeded: true, succeeded: false })
    expect(report.runtimes.filter(entry => entry.state === 'stopping')).toHaveLength(8)
    expect(report.runtimes.filter(entry => entry.state === 'queued')).toHaveLength(2)
    for (const entry of report.runtimes) expect(entry.generation).toBe(100 + entry.target.id)
  } finally { release.resolve() }
  expect(await drain.completion).toMatchObject({ deadlineExceeded: true, succeeded: false })
  expect(attempted).toHaveLength(8)
})

it('keeps a recovered supervisor process in retained mode and refuses a generation changed during a drain', async () => {
  const retained = await fixture(1, async () => 'confirmed')
  await retained.manager.stopAll(true)
  expect(retained.attach).not.toHaveBeenCalled()
  expect(retained.states.get(1)).toBe('ready')

  const moved = await fixture(1, async () => 'confirmed')
  const generation = moved.generations.get(1)!
  vi.spyOn(moved.repository, 'generationOf').mockResolvedValueOnce(generation).mockResolvedValueOnce(generation + 1)
  const report = await moved.manager.drainForShutdown().completion
  expect(report).toMatchObject({ succeeded: false, runtimes: [{ generation, state: 'failed', error: 'RuntimeGenerationConflictError' }] })
  expect(moved.attach).not.toHaveBeenCalled()
  expect(moved.states.get(1)).toBe('ready')
})

it('retains checkpoint evidence when the durable stopped-state verification fails', async () => {
  const f = await fixture(1, async () => 'confirmed')
  vi.spyOn(f.repository, 'snapshotOf').mockRejectedValue(new Error('database unavailable after termination'))
  const report = await f.manager.drainForShutdown().completion
  expect(report).toMatchObject({ succeeded: false, runtimes: [{ generation: 101, state: 'failed', shutdownOutcome: 'confirmed' }] })
})

it('continues known Runtime stops after the assignment inventory read fails', async () => {
  const f = await fixture(2, async () => 'confirmed')
  await f.manager.resolveTarget(f.targets[0]!)
  f.repository.activeTargets.mockRejectedValueOnce(new Error('inventory query failed'))
  const report = await f.manager.drainForShutdown().completion
  expect(report).toMatchObject({ inventory: 'failed', inventoryError: 'Error', succeeded: false })
  expect(report.runtimes.filter(entry => entry.state === 'stopped')).toHaveLength(2)
})

it('keeps the durable stopping fence when a newly discovered allocation has no supervisor', async () => {
  const f = await fixture(1, async () => 'confirmed', 0)
  vi.spyOn(f.repository, 'owner').mockResolvedValue(null)
  const result = await f.manager.drainForShutdown().completion
  expect(result).toMatchObject({ succeeded: false, runtimes: [{ generation: 101, state: 'failed' }] })
  expect(f.attach).not.toHaveBeenCalled()
  expect(f.states.get(1)).toBe('stopping')
})
