/** Real Host readiness preserves background obligations before automatic process release. */
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Schedule from '@deepseek-ai/dsh-schedule'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import GatewayResourceBudget from '../src/resource-budget.ts'
import { GATEWAY_READINESS_PATH, GATEWAY_READINESS_NONCE_HEADER, GATEWAY_READINESS_REQUEST_HEADER } from '../src/index.ts'
import { loadGatewayComposition, type GatewayComposition } from './fixtures/gateway-admission.fixture.ts'

async function fixture(mode?: 'resident' | 'on-demand') {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-idle-'))
  const state: { gateway?: GatewayComposition } = {}
  const coordinator = createServer((request, response) => {
    request.resume()
    if (request.url !== '/internal/runtime/resources/register') { response.writeHead(404).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      nextSequence: 1, policy: { sampleMs: 20, staleMs: 500, cpuTarget: 0.85, eventLoopTargetMs: 100,
        linuxMemoryReserveRatio: 0.1, maxQueued: 16, maxQueuedPerUser: 8, maxQueuedPerProject: 8,
        maxQueuedBytes: 65536, maxWaitMs: 10000 },
    }))
  })
  onTestFinished(async () => {
    try { await state.gateway?.dispose() }
    finally {
      coordinator.closeAllConnections()
      if (coordinator.listening) await new Promise<void>((resolve, reject) => {
        coordinator.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
      await rm(directory, { recursive: true, force: true })
    }
  })
  await new Promise<void>(resolve => coordinator.listen(0, '127.0.0.1', resolve))
  const address = coordinator.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a loopback coordinator')
  const gateway = await loadGatewayComposition({ gatewayUrl: `http://127.0.0.1:${address.port}` })
  state.gateway = gateway
  const { ctx } = gateway
  await ctx.plugin(GatewayResourceBudget)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const path = join(directory, 'settings.json')
  await writeFile(path, JSON.stringify(mode === undefined ? {} : { 'runtime-execution': { mode } }))
  const settings = await ctx.plugin(SettingsFile, { path, watch: false })
  const { credential, origin } = gateway
  let sequence = 0
  const probe = async () => {
    const nonce = `idle-probe-${++sequence}`
    const identity = credential.runtime
    const proof = createHmac('sha256', credential.token).update([
      'dsh-gateway-readiness-v1', 'request', nonce, identity.kind, String(identity.id), String(identity.generation),
    ].join('\0')).digest('base64url')
    const response = await fetch(origin + GATEWAY_READINESS_PATH, {
      headers: { host: new URL(origin).host, [GATEWAY_READINESS_NONCE_HEADER]: nonce, [GATEWAY_READINESS_REQUEST_HEADER]: proof },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { idle: { policy: string; canStop: boolean; proof: string } }
    const expected = createHmac('sha256', credential.token).update([
      'dsh-gateway-idle-v1', nonce, identity.kind, String(identity.id), String(identity.generation),
      body.idle.policy, String(body.idle.canStop),
    ].join('\0')).digest('base64url')
    expect(body.idle.proof).toBe(expected)
    return { policy: body.idle.policy, canStop: body.idle.canStop }
  }
  return { ctx, directory, path, settings, probe }
}

it('keeps an unadapted background plugin resident by default', async () => {
  const { ctx, probe } = await fixture()
  let running = true
  const plugin = await ctx.plugin({ name: 'custom-listener', apply(scope) {
    scope.effect(() => () => { running = false })
  } })
  expect(await probe()).toEqual({ policy: 'resident', canStop: false })
  expect(running).toBe(true)
  await plugin.dispose()
})

it('persists an explicit on-demand policy and refuses malformed values', async () => {
  const { ctx, probe, path, settings } = await fixture()
  expect(await probe()).toEqual({ policy: 'resident', canStop: false })
  await ctx.settings.update(settingsNamespace('runtime-execution'), { mode: 'on-demand' })
  expect(await probe()).toEqual({ policy: 'on-demand', canStop: true })
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ 'runtime-execution': { mode: 'on-demand' } })
  await expect(ctx.settings.update(settingsNamespace('runtime-execution'), { mode: 'stop-now' })).rejects.toThrow()
  await settings.dispose()
  expect(await probe()).toEqual({ policy: 'resident', canStop: false })
  await ctx.plugin(SettingsFile, { path, watch: false })
  expect(await probe()).toEqual({ policy: 'on-demand', canStop: true })
})

it('keeps a real maintenance operation alive despite its public idle status', async () => {
  const { ctx, probe } = await fixture('on-demand')
  const handle = await ctx.agents.create({ sessionId: SessionId('maintenance-owner') })
  const release = Promise.withResolvers<undefined>()
  let signal: AbortSignal | undefined
  const work = handle.agent.runMaintenance((active) => { signal = active; return release.promise })
  try {
    expect(handle.agent.status).toBe('idle')
    expect(await probe()).toEqual({ policy: 'on-demand', canStop: false })
    expect(signal?.aborted).toBe(false)
  } finally { release.resolve(undefined); await work }
  expect(await probe()).toEqual({ policy: 'on-demand', canStop: true })
})

it('honors a plugin obligation without an active Session', async () => {
  const { ctx, probe } = await fixture('on-demand')
  const release = ctx.on('runtime/idle-release-check', () => 'busy', { global: true })
  expect(ctx.agents.list()).toEqual([])
  expect(await probe()).toEqual({ policy: 'on-demand', canStop: false })
  release()
  expect(await probe()).toEqual({ policy: 'on-demand', canStop: true })
})

it('retains a producer after a throwing cancel force-fails its record and unloads the provider', async () => {
  const { ctx, probe } = await fixture('on-demand')
  const finished = Promise.withResolvers<{ status: 'killed' }>()
  const jobsFiber = await ctx.plugin(LocalJobs)
  const jobs = ctx.jobs
  jobs.attachController('idle-test-controller')
  jobs.start({ kind: 'bash', label: 'Held producer', run: () => ({
    cancel: () => { throw new Error('test cancel failed') }, done: finished.promise,
  }) })
  try {
    const running = await probe()
    expect(running).toEqual({ policy: 'on-demand', canStop: false })
    await jobsFiber.dispose()
    expect(ctx.get('jobs')).toBeUndefined()
    expect(jobs.list()).toEqual([])
    expect(ctx.agents.list()).toEqual([])
    const providerRemoved = await probe()
    expect(providerRemoved).toEqual({ policy: 'on-demand', canStop: false })
    finished.resolve({ status: 'killed' })
    await expect.poll(probe).toEqual({ policy: 'on-demand', canStop: true })
    await expect(JSON.stringify({ running, providerRemoved, producerFinished: await probe() }, null, 2) + '\n').toMatchFileSnapshot(
      fileURLToPath(new URL('./expected/runtime-idle-orphan.json', import.meta.url)),
    )
  } finally { finished.resolve({ status: 'killed' }); await jobsFiber.dispose() }
})

it('retains a future timer after its original Agent is unloaded', async () => {
  const { ctx, directory, probe } = await fixture('on-demand')
  await ctx.plugin(Persistence, { root: join(directory, 'sessions'), compression: 'none' })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(directory, 'domains') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  ctx.provide('sessionController', { resolveAgent: () => { throw new Error('A future task must not activate its Session') } } as never)
  await ctx.plugin(Schedule)
  const handle = await ctx.agents.create({ sessionId: SessionId('future-timer-owner') })
  const record = await ctx.schedule.create(handle.agent.id, { title: 'Later', prompt: 'Later', after_seconds: 3600 })
  await handle.dispose()
  expect(ctx.agents.list()).toEqual([])
  const waiting = await probe()
  expect(waiting).toEqual({ policy: 'on-demand', canStop: false })
  expect(await ctx.schedule.list({ sessionId: handle.agent.id })).toEqual([record])
  expect(await ctx.schedule.delete({ id: record.id, sessionId: handle.agent.id })).toEqual({ id: record.id, deleted: true })
  await expect.poll(probe).toEqual({ policy: 'on-demand', canStop: true })
  await expect(JSON.stringify({ waiting, afterDeletion: await probe() }, null, 2) + '\n').toMatchFileSnapshot(
    fileURLToPath(new URL('./expected/runtime-idle.json', import.meta.url)),
  )
})
