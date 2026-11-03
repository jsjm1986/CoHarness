/** Failed multi-stream startup retains admission through sibling allocation and native socket closure. */
import { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import ResourceBudget, { type ResourceLease } from '@deepseek-ai/dsh-resource-budget'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { SshSubprocessRuntime } from '../src/index.ts'

class HeldSocket extends Duplex {
  readonly closing = Promise.withResolvers<undefined>()
  private finish: (() => void) | undefined
  private released = false
  override _read(): void {}
  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void { callback() }
  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.closing.resolve(undefined)
    this.finish = () => { callback(error) }
    if (this.released) this.finish()
  }
  release(): void { this.released = true; this.finish?.(); this.finish = undefined }
}

it.each(['rejected', 'granted'] as const)('retains failed startup while a sibling stream is %s after cancellation', async (late) => {
  const ctx = new Context(), errors: unknown[] = []
  ctx.logger.error = ((error: unknown) => { errors.push(error) }) as typeof ctx.logger.error
  const failed = Promise.withResolvers<never>(), pending = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>(), terminated = Promise.withResolvers<undefined>()
  const stdin = new HeldSocket(), stderr = new HeldSocket()
  const calls: string[] = [], failure = new Error('stdout allocation refused')
  let releases = 0, uncertainties = 0
  ctx.provide('resourceBudgetRequired', true)
  class Budget extends ResourceBudget {
    override async acquire(): Promise<ResourceLease> {
      let settled = false
      return { signal: new AbortController().signal,
        release: async () => { if (!settled) { settled = true; releases++ } },
        uncertain: async () => { uncertainties++ } }
    }
  }
  await ctx.plugin(Budget)
  ctx.provide('ssh', {
    retainConsumer: (cleanup: () => Promise<void>) => cleanup,
    request: async <T>(method: string, _params: unknown, schema: z.ZodType<T>): Promise<T> => {
      calls.push(method)
      if (method === 'process.prepare') return schema.parse({ id: 'd941f644-18d6-47f2-9d8c-488f3683a2ec', streams: {
        stdin: { path: '/tmp/stdin', capability: 'a'.repeat(64) },
        stdout: { path: '/tmp/stdout', capability: 'b'.repeat(64) },
        stderr: { path: '/tmp/stderr', capability: 'c'.repeat(64) },
      } })
      if (method === 'process.terminate') { terminated.resolve(undefined); return schema.parse(null) }
      throw new Error(`Unexpected request ${method}`)
    },
    connectStream: async (endpoint: { path: string }, signal: AbortSignal) => {
      if (endpoint.path === '/tmp/stdin') return stdin
      if (endpoint.path === '/tmp/stdout') return failed.promise
      entered.resolve(undefined)
      await pending.promise
      if (late === 'rejected') { signal.throwIfAborted(); throw new Error('sibling allocation refused') }
      return stderr
    },
    dispose: async () => {},
  } as never)
  const fiber = await ctx.plugin(SshSubprocessRuntime)
  onTestFinished(async () => {
    failed.reject(failure); pending.resolve(undefined)
    for (const socket of [stdin, stderr]) { socket.release(); socket.destroy() }
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
  const spec: SubprocessSpawnSpec = { argv: ['node'], cwd: '/workspace', graceMs: 5,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } }
  const handle = await ctx.subprocess.spawn(spec)
  let doneSettled = false, observationSettled = false, disposed = false
  const done = handle.done.then(() => undefined, (error: unknown) => error).finally(() => { doneSettled = true })
  await entered.promise
  failed.reject(failure)
  await terminated.promise
  const observation = handle.waitForExit().finally(() => { observationSettled = true })
  const disposal = fiber.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(doneSettled).toBe(false)
  expect(observationSettled).toBe(false)
  expect(disposed).toBe(false)
  expect(releases).toBe(0)
  expect(await handle.waitForExit(AbortSignal.abort())).toBe(false)
  pending.resolve(undefined)
  await Promise.all([stdin.closing.promise, ...(late === 'granted' ? [stderr.closing.promise] : [])])
  expect(doneSettled).toBe(false)
  expect(observationSettled).toBe(false)
  expect(disposed).toBe(false)
  expect(releases).toBe(0)
  stdin.release(); stderr.release()
  expect(await done).toBe(failure)
  expect(await observation).toBe(true)
  await disposal
  expect(stdin.closed).toBe(true)
  if (late === 'granted') expect(stderr.closed).toBe(true)
  expect(releases).toBe(1)
  expect(uncertainties).toBe(1)
  expect(calls).toEqual(['process.prepare', 'process.terminate'])
  expect(errors).toEqual([])
})
