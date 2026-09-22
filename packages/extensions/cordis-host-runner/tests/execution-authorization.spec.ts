/** Deployment authorization at dynamic Host execution and activation commit points. */
import { expect, it, onTestFinished } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { AGENT_A, CLIENT_CODE, setup } from './helpers.ts'

const HOST = 'let calls = 0; harness.handle("count", () => ++calls); return { apply(ctx) { ctx.provide("authorizationProbe", "active") } }'

async function world() {
  const harness = await setup()
  onTestFinished(() => harness.ctx.fiber.dispose())
  const definition = harness.runner.define({
    sessionId: AGENT_A.id, plugin: { kind: 'new', idPrefix: 'auth' },
    name: 'Execution authorization probe', purpose: 'Observe real Host execution',
    code: { host: HOST },
  })
  return { ...harness, definition }
}

it('retains independent local execution when no managed-runtime policy is present', async () => {
  const { ctx, runner, definition } = await world()
  await expect(runner.run(AGENT_A, definition.pluginId, definition.packageId, 'run')).resolves.toMatchObject({ ok: true })
  expect(ctx.get('authorizationProbe')).toBe('active')
})

it('requires a policy in a managed runtime while retaining read-only definitions', async () => {
  const { ctx, runner, definition } = await world()
  ctx.provide('executionAuthorityRequired', true)
  expect(runner.inspectPackage(AGENT_A, definition.pluginId, definition.packageId).code.host).toBe(HOST)
  await expect(runner.run(AGENT_A, definition.pluginId, definition.packageId, 'run')).rejects.toMatchObject({ code: 'plugin-management/forbidden' })
  expect(ctx.get('authorizationProbe')).toBeUndefined()
  expect((await runner.inventory())[0]?.activeRun).toBeUndefined()
})

it.each(['run', 'runHostHalf'] as const)('%s refuses the real execution path when the deployment denies it', async (method) => {
  const { ctx, runner, definition } = await world()
  ctx.provide('pluginManagementAuthorization', {
    protectedModules: new Set<string>(),
    authorize: () => Promise.reject(new Error('deployment denies dynamic execution')),
  })
  const attempt = method === 'run'
    ? runner.run(AGENT_A, definition.pluginId, definition.packageId, 'run')
    : runner.runHostHalf(AGENT_A, definition.pluginId, definition.packageId, 'run', null, false)
  await expect(attempt).rejects.toThrow('deployment denies dynamic execution')
  expect(ctx.get('authorizationProbe')).toBeUndefined()
  expect((await runner.inventory())[0]?.activeRun).toBeUndefined()
})

it('rechecks invocation and does not run a retained Host handler after denial', async () => {
  const { ctx, runner, definition } = await world()
  const run = await runner.run(AGENT_A, definition.pluginId, definition.packageId, 'run')
  if (!run.ok) throw new Error(run.message)
  let allowed = true
  ctx.provide('pluginManagementAuthorization', {
    protectedModules: new Set<string>(),
    authorize: async () => { if (!allowed) throw new Error('execution revoked') },
  })
  await expect(runner.invoke(definition.pluginId, run.pluginRunId, 'count', null)).resolves.toEqual({ ok: true, value: 1 })
  allowed = false
  await expect(runner.invoke(definition.pluginId, run.pluginRunId, 'count', null)).rejects.toThrow('execution revoked')
  allowed = true
  await expect(runner.invoke(definition.pluginId, run.pluginRunId, 'count', null)).resolves.toEqual({ ok: true, value: 2 })
})

it('does not invoke an activation stopped while deployment authorization was pending', async () => {
  const { ctx, runner, definition } = await world()
  const run = await runner.run(AGENT_A, definition.pluginId, definition.packageId, 'run')
  if (!run.ok) throw new Error(run.message)
  const checking = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  ctx.provide('pluginManagementAuthorization', {
    protectedModules: new Set<string>(),
    authorize: () => { checking.resolve(undefined); return release.promise },
  })
  const pending = runner.invoke(definition.pluginId, run.pluginRunId, 'count', null)
  await checking.promise
  await runner.stop(AGENT_A, definition.pluginId)
  release.resolve(undefined)
  await expect(pending).resolves.toMatchObject({ ok: false, code: 'plugin-not-running' })
})

it('rechecks the executable tool registered by a previously authorized dynamic Plugin', async () => {
  const { ctx, runner } = await world()
  const definition = runner.define({
    sessionId: AGENT_A.id, plugin: { kind: 'new', idPrefix: 'tool' },
    name: 'Guarded dynamic tool', purpose: 'Cover the alternative tool execution path',
    code: { host: `let calls = 0; return { apply(ctx) {
      harness.registerTool(ctx, harness.defineTool({
        name: 'authorized_probe', description: 'Count actual executions', parameters: {},
        output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute: async () => ++calls,
      }))
    } }` },
  })
  await expect(runner.run(AGENT_A, definition.pluginId, definition.packageId, 'run')).resolves.toMatchObject({ ok: true })
  let allowed = false
  ctx.provide('pluginManagementAuthorization', {
    protectedModules: new Set<string>(),
    authorize: async () => { if (!allowed) throw new Error('dynamic tool authority revoked') },
  })
  const execute = () => ctx.tools.execute({
    callId: ToolCallId('dynamic-probe'), name: 'authorized_probe', arguments: {}, signal: new AbortController().signal,
  })
  expect(await execute()).toMatchObject({ isError: true, error: { message: 'dynamic tool authority revoked' } })
  allowed = true
  expect(await execute()).toMatchObject({ isError: false, value: 1 })
})

it('rechecks a pending Plugin when its dependency becomes available', async () => {
  const { ctx, runner } = await world()
  const checked = Promise.withResolvers<undefined>()
  let allowed = true
  ctx.provide('pluginManagementAuthorization', {
    protectedModules: new Set<string>(),
    authorize: async () => {
      if (!allowed) {
        checked.resolve(undefined)
        throw new Error('late activation authority revoked')
      }
    },
  })
  const definition = runner.define({
    sessionId: AGENT_A.id, plugin: { kind: 'new', idPrefix: 'late' },
    name: 'Pending Host Plugin', purpose: 'Recheck delayed Cordis activation',
    code: { host: 'return { inject: ["lateDependency"], apply(ctx) { ctx.provide("lateActivationProbe", true) } }' },
  })
  await expect(runner.run(AGENT_A, definition.pluginId, definition.packageId, 'run')).resolves.toMatchObject({ ok: true })
  const fiber = runner.snapshot(AGENT_A).find(row => row.pluginId === definition.pluginId)?.activeRun?.fiber
  if (fiber === undefined) throw new Error('expected a pending Host fiber')
  allowed = false
  ctx.provide('lateDependency', {})
  await checked.promise
  await expect(fiber.await()).rejects.toThrow('late activation authority revoked')
  expect(ctx.get('lateActivationProbe')).toBeUndefined()
})

it('rechecks after old-run cleanup before evaluating an update', async () => {
  const { ctx, runner } = await world()
  const cleaning = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  ctx.provide('cleanupGate', { wait: () => { cleaning.resolve(undefined); return release.promise } })
  const first = runner.define({
    sessionId: AGENT_A.id, plugin: { kind: 'new', idPrefix: 'wait' },
    name: 'Waiting cleanup', purpose: 'Own the update handoff',
    code: { host: 'return { inject: ["cleanupGate"], apply(ctx) { ctx.effect(() => () => ctx.cleanupGate.wait()) } }' },
  })
  await expect(runner.run(AGENT_A, first.pluginId, first.packageId, 'run')).resolves.toMatchObject({ ok: true })
  const next = runner.define({
    sessionId: AGENT_A.id, plugin: { kind: 'existing', pluginId: first.pluginId },
    name: 'Must not evaluate', purpose: 'Reject after an awaited cleanup',
    code: { host: 'throw new Error("new Host body executed")' },
  })
  let allowed = true
  ctx.provide('pluginManagementAuthorization', {
    protectedModules: new Set<string>(),
    authorize: async () => { if (!allowed) throw new Error('execution revoked during cleanup') },
  })
  const updating = runner.run(AGENT_A, first.pluginId, next.packageId, 'update')
  const rejection = expect(updating).rejects.toThrow('execution revoked during cleanup')
  await cleaning.promise
  allowed = false
  release.resolve(undefined)
  await rejection
  const rejected = (await runner.inventory()).find(row => row.pluginId === first.pluginId)
  expect(rejected?.activeRun).toBeUndefined()
  expect(rejected?.latestRun).toMatchObject({ status: 'failed', error: { message: 'execution revoked during cleanup' } })
})

it('blocks successful browser settlement after revocation but permits rejection and owner cleanup', async () => {
  const { ctx, runner } = await world()
  const definition = runner.define({
    sessionId: AGENT_A.id, plugin: { kind: 'new', idPrefix: 'client' },
    name: 'Client activation', purpose: 'Retain refusal and cleanup authority',
    code: { host: 'return { apply() {} }', client: CLIENT_CODE },
  })
  const started = await runner.run(AGENT_A, definition.pluginId, definition.packageId, 'run')
  if (!started.ok) throw new Error(started.message)
  const requestId = (await runner.inventory()).find(row => row.pluginId === definition.pluginId)?.latestRun?.approvalRequestId
  if (requestId === undefined) throw new Error('expected a pending browser approval')
  const half = await runner.runHostHalf(AGENT_A, definition.pluginId, definition.packageId, 'run', requestId, false)
  if (!half.ok) throw new Error(half.message)
  ctx.provide('pluginManagementAuthorization', {
    protectedModules: new Set<string>(),
    authorize: () => Promise.reject(new Error('approval authority revoked')),
  })
  await expect(runner.resolveRequestRun(requestId, { ok: true, pluginRunId: half.pluginRunId })).rejects.toThrow('approval authority revoked')
  await expect(runner.settleUserRun(AGENT_A, definition.pluginId, { ok: true, pluginRunId: half.pluginRunId })).rejects.toThrow('approval authority revoked')
  await expect(runner.resolveRequestRun(requestId, { ok: false, reason: 'rejected' })).resolves.toEqual({ accepted: true })
  await expect(runner.stop(AGENT_A, definition.pluginId)).resolves.toEqual({ ok: true })
})
