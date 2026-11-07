import { expect, it, vi } from 'vitest'
import ResourceBudget from '@deepseek-ai/dsh-resource-budget'
import type { ResourceLease, ResourceRequest } from '@deepseek-ai/dsh-resource-budget'
import { createRuntimeContext } from './setup.ts'
import PythonPtcRuntime from '../src/index.ts'

function reservation() {
  const controller = new AbortController()
  const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
  const lease: ResourceLease = { signal: controller.signal, release, uncertain }
  return { controller, release, uncertain, lease }
}

async function queuedExecution() {
  const ctx = await createRuntimeContext()
  const probe = reservation(), execution = reservation()
  const grant = Promise.withResolvers<ResourceLease>(), requested = Promise.withResolvers<ResourceRequest>()
  let requests = 0
  ctx.provide('resourceBudgetRequired', true)
  new class extends ResourceBudget { acquire = (request: ResourceRequest) => {
    if (requests++ === 0) return Promise.resolve(probe.lease)
    requested.resolve(request)
    return grant.promise
  } }(ctx)
  const fiber = await ctx.plugin(PythonPtcRuntime, { maxWallMs: 30_000, graceMs: 50 })
  return { ctx, fiber, runtime: ctx.ptcRuntime, probe, execution, grant, requested }
}

it('requires infrastructure admission before its interpreter version probe', async () => {
  const ctx = await createRuntimeContext()
  const acquire = vi.fn(async () => { throw new Error('interpreter admission denied') })
  ctx.provide('resourceBudgetRequired', true)
  new class extends ResourceBudget { acquire = acquire }(ctx)
  await expect(ctx.plugin(PythonPtcRuntime)).rejects.toThrow('interpreter admission denied')
  expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ kind: 'process', origin: 'infrastructure' }))
})

it('refuses its interpreter probe after a required accountant is withdrawn', async () => {
  const ctx = await createRuntimeContext()
  ctx.provide('resourceBudgetRequired', true)
  await expect(ctx.plugin(PythonPtcRuntime)).rejects.toThrow('requires its resource admission provider')
})

it('cancels queued plugin initialization and returns a late unused probe grant', async () => {
  const ctx = await createRuntimeContext(), owner = reservation()
  const grant = Promise.withResolvers<ResourceLease>(), requested = Promise.withResolvers<ResourceRequest>()
  ctx.provide('resourceBudgetRequired', true)
  new class extends ResourceBudget { acquire = (request: ResourceRequest) => {
    requested.resolve(request)
    return grant.promise
  } }(ctx)
  const fiber = ctx.plugin(PythonPtcRuntime)
  const rejected = expect(Promise.resolve(fiber)).rejects.toThrow('Python runtime disposed')
  try {
    const request = await requested.promise
    const stopped = fiber.dispose()
    expect(request.signal?.aborted).toBe(true)
    grant.resolve(owner.lease)
    await Promise.all([stopped, rejected])
    expect(owner.release).toHaveBeenCalledOnce()
    expect(owner.uncertain).not.toHaveBeenCalled()
  } finally { grant.resolve(owner.lease); await fiber.dispose(); await rejected }
})

it('attributes a queued program to its Session and stops it on permit withdrawal', async () => {
  const test = await queuedExecution(), ready = Promise.withResolvers<number>()
  const report = vi.fn(async (value: unknown) => { ready.resolve(value as number); return null })
  const sessionId = 'python-admission-session' as NonNullable<ResourceRequest['sessionId']>
  const pending = test.runtime.run(test.runtime.resolve({
    program: 'import os, asyncio\nawait tools.ready(os.getpid())\nawait asyncio.Event().wait()',
    bindings: [{ global: 'tools', functions: { ready: report } }],
    sandboxPolicy: { ...test.ctx.sandboxPolicy.resolve(), sessionId },
  }))
  try {
    expect(await test.requested.promise).toMatchObject({ kind: 'process', sessionId })
    expect(report).not.toHaveBeenCalled()
    expect(test.probe.release).toHaveBeenCalled()
    test.grant.resolve(test.execution.lease)
    const pid = await ready.promise
    expect(test.execution.release).not.toHaveBeenCalled()
    test.execution.controller.abort(new Error('node process admission withdrawn'))
    expect((await pending).error?.kind).toBe('worker-exit')
    expect(test.execution.release).toHaveBeenCalled()
    expect(test.execution.uncertain).not.toHaveBeenCalled()
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/)
  } finally {
    test.grant.resolve(test.execution.lease)
    await test.fiber.dispose()
    await pending
  }
})

it('cancels program allocation before dispatch and returns its late grant', async () => {
  const test = await queuedExecution(), controller = new AbortController()
  const report = vi.fn(async () => null)
  const pending = test.runtime.run(test.runtime.resolve({
    program: 'await tools.ready(None)', bindings: [{ global: 'tools', functions: { ready: report } }], signal: controller.signal,
  }))
  try {
    await test.requested.promise
    controller.abort(new Error('cancel Python allocation'))
    test.grant.resolve(test.execution.lease)
    expect((await pending).error).toMatchObject({ kind: 'abort', message: 'cancel Python allocation' })
    expect(test.execution.release).toHaveBeenCalledOnce()
    expect(test.execution.uncertain).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  } finally { test.grant.resolve(test.execution.lease); await test.fiber.dispose(); await pending }
})
