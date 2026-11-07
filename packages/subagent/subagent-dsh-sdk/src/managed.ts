/** Private managed-child plugin inserted by the parent SDK provider. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ResourceAdmissionError } from '@deepseek-ai/dsh-resource-budget'
import { SDK_PARENT_CONTROL_ENV, controlChunk, controlConnection } from './control.ts'
import { ParentControlClient } from './managed-client.ts'
import { ManagedSdkBudget, type ChildModelSpan } from './managed-budget.ts'

export const name = 'sdk-parent-control'

/** Strip model-hidden authority before crossing into the parent process. */
function wireOptions(options: GenerateOptions): Record<string, unknown> {
  const wire: Record<string, unknown> = { ...options }
  delete wire.signal
  delete wire.executionIdentity
  delete wire.sessionId
  delete wire.resourceOrigin
  return wire
}

/** Mount mandatory parent admission without changing child adapters or logged input. @param ctx - child plugin context. */
export async function apply(ctx: Context): Promise<void> {
  const raw = process.env[SDK_PARENT_CONTROL_ENV]
  if (raw === undefined) throw new Error('Managed SDK child requires its parent control connection.')
  const connection = controlConnection(JSON.parse(raw))
  delete process.env.DSH_SDK_PARENT_CONTROL
  if (ctx.get('resourceBudget') !== undefined) throw new Error('Managed SDK child cannot install an independent resource budget.')
  const client = new ParentControlClient(connection)
  const lifetime = new AbortController()
  const models = new AsyncLocalStorage<ChildModelSpan>()
  const active = new Set<Promise<undefined>>()
  let available = true
  const budget = new ManagedSdkBudget(ctx, client, models)
  if (ctx.root.get('resourceBudgetRequired') !== true) ctx.root.effect(() => ctx.root.provide('resourceBudgetRequired', true))
  if (ctx.root.get('modelAccessRequired') !== true) ctx.root.effect(() => ctx.root.provide('modelAccessRequired', true))
  if (ctx.root.get('modelAccess') === undefined) {
    ctx.root.effect(() => ctx.root.provide('modelAccess', { decide: () => available ? { allowed: true as const }
      : { allowed: false as const, reason: 'SDK parent authorization is unavailable.' } }))
  }

  // These root-owned guards survive plugin withdrawal, which must never restore local execution.
  ctx.root.on('llm/stream', (options, next) => run(options, next), { global: true })
  ctx.root.on('llm/delegated-stream', (options, next) => run(options, next), { global: true })
  ctx.root.on('llm/authorize', async (options) => {
    const model = models.getStore()
    if (!available || model === undefined) throw new LlmError('SDK model request lost its parent owner.', 'MODEL_POLICY_UNAVAILABLE')
    await client.post('/model/authorize', { id: model.id, options: wireOptions(options) }, options.signal)
  }, { global: true })
  ctx.effect(() => async () => {
    available = false
    try {
      await client.cleanup(async () => {
        lifetime.abort(new ResourceAdmissionError('cancelled', 'SDK parent bridge was unloaded.'))
        await Promise.allSettled([...active])
        const results = await Promise.allSettled([client.retryModelCompletions(), budget.close()])
        const failures = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
        if (failures.length > 0) throw new AggregateError(failures, 'SDK model and resource cleanup failed.')
      })
    } finally { client.close() }
  }, 'sdk-parent-control: join models and resource reports')
  await client.post('/runtime/ready', { id: '1' })

  async function* run(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    if (!available) throw new LlmError('SDK parent authorization is unavailable.', 'MODEL_POLICY_UNAVAILABLE')
    const done = Promise.withResolvers<undefined>()
    active.add(done.promise)
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, lifetime.signal, ...options.signal === undefined ? [] : [options.signal]])
    let started: ReturnType<ParentControlClient['register']> | undefined
    let pump = Promise.resolve()
    const initialized = Promise.withResolvers<undefined>()
    let completion: Promise<void> | undefined
    const finish = (): Promise<void> => completion ??= (async () => {
      try {
        await initialized.promise
        await Promise.allSettled([pump])
        if (started !== undefined) await client.closeModel(started.id)
      } finally {
        signal.removeEventListener('abort', onAbort)
        active.delete(done.promise)
        done.resolve(undefined)
      }
    })()
    const onAbort = (): void => {
      controller.abort(signal.reason)
      // The stream consumer may remain suspended at a yielded chunk.
      void finish().catch(() => {
        // The consuming iterator awaits this same completion when resumed or closed.
      })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    try {
      try {
        await client.retryModelCompletions()
        signal.throwIfAborted()
        const operation = client.register('/model/open', { options: wireOptions(options) }, signal)
        started = operation
        await operation.ready
        let readiness = await client.post('/model/ready', { id: operation.id }, signal)
        while (readiness.pending === true) {
          await delay(connection.config.pollMs, undefined, { signal })
          readiness = await client.post('/model/ready', { id: operation.id }, signal)
        }
        if (typeof readiness.dispatch !== 'boolean') throw new LlmError('Invalid SDK parent readiness response.', 'SDK_PARENT_CONTROL_ERROR')
        if (readiness.dispatch) {
          pump = models.run({ id: operation.id, controller }, async () => {
            try {
              for await (const chunk of next()) await client.post('/model/input', { id: operation.id, chunk }, signal)
            } catch (error) {
              if (!signal.aborted) await client.post('/model/input', { id: operation.id, chunk: { type: 'finish', reason: { kind: 'error', failure: {
                message: error instanceof LlmError || error instanceof ResourceAdmissionError ? error.message : 'SDK child model stream failed.',
                code: error instanceof LlmError ? error.code : 'SDK_CHILD_MODEL_FAILED',
              } } } }, signal)
            } finally { await client.post('/model/finish', { id: operation.id }) }
          })
          // A transport failure must also wake a blocked output poll.
          void pump.catch((error: unknown) => { controller.abort(error) })
        }
      } finally { initialized.resolve(undefined) }
      for (;;) {
        const output = await client.post('/model/output', { id: started.id }, signal)
        if (output.pending === true) continue
        if (output.done === true) return
        if (output.done !== false) throw new LlmError('Invalid SDK parent stream response.', 'SDK_PARENT_CONTROL_ERROR')
        yield controlChunk(output.chunk)
      }
    } finally {
      controller.abort(new LlmError('SDK model consumer stopped.', 'ABORTED'))
      await finish()
    }
  }
}
