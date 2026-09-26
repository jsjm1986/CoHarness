/** Desktop authorization surrounds the actual effect and survives policy replacement. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import ComputerUse from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup(managed = false) {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('executionAuthorityRequired', managed)
  await ctx.plugin(ComputerUse)
  const execution: ToolExecution = {
    rootCallId: 'desktop-call' as ToolExecution['rootCallId'], token: Symbol('desktop-call') as ToolExecutionToken,
    name: 'desktop-click', callId: 'desktop-call' as ToolExecution['callId'], arguments: {}, signal: new AbortController().signal,
  }
  return { ctx, execution }
}

it('permits the independent local operator and forwards its cancellation', async () => {
  const { ctx, execution } = await setup()
  const operation = vi.fn(async (signal: AbortSignal) => { expect(signal.aborted).toBe(false); return 'local result' })
  await expect(ctx.computerUse.run(execution, operation)).resolves.toBe('local result')
  await expect(ctx.computerUse.run({ ...execution, signal: AbortSignal.abort() }, operation)).rejects.toThrow()
  expect(operation).toHaveBeenCalledOnce()
})

it('refuses missing managed authority and refuses anonymous calls even with a policy', async () => {
  const { ctx, execution } = await setup(true)
  const operation = vi.fn(async () => 'effect')
  await expect(ctx.computerUse.run(execution, operation)).rejects.toThrow('authorized Session')
  const run = vi.fn(async () => 'not authorized')
  ctx.provide('computerUseAuthorization', { run } as never)
  await expect(ctx.computerUse.run(execution, operation)).rejects.toThrow('authorized Session')
  expect(run).not.toHaveBeenCalled()
  expect(operation).not.toHaveBeenCalled()
})

it('keeps a managed runtime restricted after its required marker is removed', async () => {
  const { ctx, execution } = await setup(true)
  await expect(ctx.computerUse.run(execution, async () => 'effect')).rejects.toThrow()
  ctx.executionAuthorityRequired = false
  await expect(ctx.computerUse.run(execution, async () => 'effect')).rejects.toThrow('authorized Session')
})

it('treats a composed execution-authority provider as managed even without the marker', async () => {
  const { ctx, execution } = await setup()
  ctx.provide('executionAuthority', {} as never)
  await expect(ctx.computerUse.run(execution, async () => 'effect')).rejects.toThrow('authorized Session')
})

it('propagates the exact actor and rejects output after lease revocation', async () => {
  const { ctx, execution } = await setup(true)
  const agent = {} as NonNullable<ToolExecution['agent']>
  const request = { ...execution, agent }
  const revoked = new AbortController()
  ctx.provide('computerUseAuthorization', {
    async run(request, operation) {
      expect(request.agent).toBe(agent)
      return operation(revoked.signal)
    },
  })
  await expect(ctx.computerUse.run(request, async () => 'authorized result')).resolves.toBe('authorized result')
  await expect(ctx.computerUse.run(request, async (signal) => {
    revoked.abort(new Error('desktop revoked'))
    expect(signal.aborted).toBe(true)
    return 'stale output'
  })).rejects.toThrow('desktop revoked')
  const operation = vi.fn(async () => 'effect')
  await expect(ctx.computerUse.run(request, operation)).rejects.toThrow('desktop revoked')
  expect(operation).not.toHaveBeenCalled()
})

it('does not invoke the driver when the current policy denies the request', async () => {
  const { ctx, execution } = await setup()
  ctx.provide('computerUseAuthorization', { run: async () => { throw new Error('desktop permission denied') } })
  const operation = vi.fn(async () => 'effect')
  await expect(ctx.computerUse.run(execution, operation)).rejects.toThrow('desktop permission denied')
  expect(operation).not.toHaveBeenCalled()
})
