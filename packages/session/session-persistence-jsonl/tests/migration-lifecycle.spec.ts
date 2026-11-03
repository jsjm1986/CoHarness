/** Provider withdrawal while a historical write still owns a verification Worker and write lease. */
import { Context } from '@deepseek-ai/cordis'
import ResourceBudget, { ResourceAdmissionError } from '@deepseek-ai/dsh-resource-budget'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scheduler } from 'node:timers/promises'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { generationLogPath } from '../src/format.ts'
import { verifyJsonlCurrentGeneration } from '../src/generation.ts'
import type { JsonlCompression } from '../src/format.ts'

const state = vi.hoisted(() => ({ workers: [] as unknown[], cleaning: false }))

vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Worker: class extends EventEmitter {
      private cleaned = false
      readonly stopped = Promise.withResolvers<number>()
      readonly terminate = vi.fn(() => this.stopped.promise)
      constructor(readonly entry: URL, readonly options: { workerData: { path: string } }) {
        super()
        state.workers.push(this)
        if (state.cleaning) queueMicrotask(() =>{  this.cleanup() })
      }
      cleanup(): void {
        if (this.cleaned) return
        this.cleaned = true
        this.emit('error', new Error('verification fixture cleanup'))
        this.stopped.resolve(0)
      }
    },
  }
})

interface VerificationWorker {
  readonly options: { workerData: {
    path: string
    compression: JsonlCompression
    expectedId: string
    expectedEventCount: number
    expectedVersion?: number
  } }
  readonly terminate: ReturnType<typeof vi.fn<() => Promise<number>>>
  readonly stopped: { resolve(value: number): void }
  cleanup(): void
  emit(event: string, value: unknown): boolean
}

beforeEach(() => { state.workers.length = 0; state.cleaning = false })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-migration-lifetime-'))
  const ctx = new Context()
  const opens: Array<Promise<unknown>> = []
  onTestFinished(async () => {
    state.cleaning = true
    for (const worker of state.workers as VerificationWorker[]) worker.cleanup()
    await Promise.allSettled(opens)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const backend = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  async function open(name: string) {
    const id = SessionId(name)
    const source = generationLogPath(root, undefined, id, 6, 'none')
    const bytes = JSON.stringify({ type: 'session', version: 6, id, createdAt: 1, isSeeded: false, delegationDepth: 0 }) + '\n'
    await mkdir(dirname(source), { recursive: true })
    await writeFile(source, bytes)
    const operation = ctx.sessionPersistence.open(id, 'write').then(async (handle) => {
      await handle.close()
      return 'opened'
    })
    const observed = operation.catch((error: unknown) => error)
    opens.push(observed)
    return { id, observed, source, bytes, current: generationLogPath(root, undefined, id, 7, 'none') }
  }
  return { root, ctx, backend, open }
}

it('keeps provider disposal pending while an accepted migration is still verifying', async () => {
  const f = await fixture()
  const operation = await f.open('owned-publication')
  await vi.waitFor(() => { expect(state.workers).toHaveLength(1) })
  let disposed = false
  const disposal = f.backend.dispose().then(() => { disposed = true })
  try {
    // There are no adopted handles or storage I/O in teardown; the turn drains its disposal microtasks.
    await scheduler.yield()
    expect(disposed).toBe(false)
    ;(state.workers[0] as VerificationWorker).cleanup()
    await disposal
    expect(await operation.observed).toBeInstanceOf(Error)
    expect(await readFile(operation.source, 'utf8')).toBe(operation.bytes)
    await expect(readFile(operation.current)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    state.cleaning = true
    for (const worker of state.workers as VerificationWorker[]) worker.cleanup()
    await operation.observed
    await disposal
  }
})

it('does not share a hidden verification queue between independent backend owners', async () => {
  const first = await fixture()
  await first.open('first')
  await first.open('second')
  await vi.waitFor(() => { expect(state.workers).toHaveLength(2) })
  const second = await fixture()
  await second.open('independent')
  await vi.waitFor(() => { expect(state.workers).toHaveLength(3) })
})

it('finishes an accepted publication and releases its write lease before provider withdrawal completes', async () => {
  const f = await fixture()
  const operation = await f.open('finishing-publication')
  await vi.waitFor(() => { expect(state.workers).toHaveLength(1) })
  const instance = state.workers[0] as VerificationWorker
  const request = instance.options.workerData
  const verified = await verifyJsonlCurrentGeneration(request.path, request.compression,
    request.expectedId, request.expectedEventCount, undefined, request.expectedVersion)
  instance.emit('message', { ok: true, result: verified })
  expect(instance.terminate).toHaveBeenCalledOnce()
  let disposed = false
  const disposal = f.backend.dispose().then(() => { disposed = true })
  try {
    await scheduler.yield()
    expect(disposed).toBe(false)
    instance.stopped.resolve(0)
    await disposal
    expect(await operation.observed).toBe('opened')
    expect(await readFile(operation.source, 'utf8')).toBe(operation.bytes)
    expect(JSON.parse(await readFile(operation.current, 'utf8'))).toMatchObject({ version: 7, id: operation.id })
    await f.ctx.plugin(JsonlSessionPersistence, { root: f.root, compression: 'none' })
    const reopened = await f.ctx.sessionPersistence.open(operation.id, 'write')
    await reopened.close()
  } finally {
    instance.stopped.resolve(0)
    await operation.observed
    await disposal
  }
})

it.each(['missing-provider', 'capacity-refusal'] as const)('preserves a healthy historical log on %s', async (failure) => {
  const f = await fixture()
  f.ctx.provide('resourceBudgetRequired', true)
  if (failure === 'capacity-refusal') {
    class RefusingBudget extends ResourceBudget {
      acquire(): Promise<never> { return Promise.reject(new ResourceAdmissionError('refused', 'node process capacity unavailable')) }
    }
    await f.ctx.plugin(RefusingBudget)
  }
  const operation = await f.open('healthy-history')
  const error: unknown = await operation.observed
  expect(error).toBeInstanceOf(ResourceAdmissionError)
  expect(error).not.toBeInstanceOf(SessionPersistenceCorruptionError)
  expect(state.workers).toHaveLength(0)
  expect(await readFile(operation.source, 'utf8')).toBe(operation.bytes)
  await expect(readFile(operation.current)).rejects.toMatchObject({ code: 'ENOENT' })
})
