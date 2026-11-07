/** Verified models accept bounded concurrent recordings while the managed worker starts. */
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ResourceLease, ResourceRequest } from '@deepseek-ai/dsh-resource-budget'
import SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import { afterEach, expect, it, vi } from 'vitest'
import * as Provider from '../src/index.ts'
import { SenseVoiceWorker } from '../src/recognizer.ts'
import { inspectRuntime, prepareRuntime } from '../src/runtime.ts'
vi.mock('../src/runtime.ts', () => ({ inspectRuntime: vi.fn(), prepareRuntime: vi.fn() }))
afterEach(() => { vi.restoreAllMocks() })

it('cancels worker admission before native allocation and preserves later readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speech-admission-')), ctx = new Context()
  const entered = Promise.withResolvers<ResourceRequest>(), grant = Promise.withResolvers<ResourceLease>()
  let allocations = 0
  class ObservedSubprocess extends LocalSubprocess {
    protected override spawnProcess(spec: SubprocessSpawnSpec): SubprocessHandle {
      allocations++
      return super.spawnProcess(spec)
    }
  }
  const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
  const lease: ResourceLease = { signal: new AbortController().signal, release, uncertain }
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('resourceBudget', { acquire: (request: ResourceRequest) => { entered.resolve(request); return grant.promise } } as never)
  let active: Promise<unknown> | undefined
  try {
    const worker = join(root, 'worker.mjs')
    await writeFile(worker, `await import(${JSON.stringify(new URL('./worker.fixture.mjs', import.meta.url).href)});\n`)
    vi.mocked(inspectRuntime).mockResolvedValue({ tokens: root, model: root, vad: root, worker })
    await ctx.plugin(ObservedSubprocess)
    await ctx.plugin(SpeechToText, { defaultProvider: 'sensevoice-local', language: 'auto' })
    await ctx.plugin(Provider, { dataRoot: root, idleTimeoutMs: 0 })
    const speech = ctx.get('speechToText')!
    await vi.waitFor(() => { expect(speech.snapshot().providers[0]?.preparation.phase).toBe('standby') })
    const controller = new AbortController()
    const spec = speech.resolve({ audio: new Uint8Array([1, 2]), language: 'zh' })
    active = speech.transcribe(spec, controller.signal).then(value => ({ value }), (error: unknown) => ({ error }))
    const request = await entered.promise
    expect(allocations).toBe(0)
    controller.abort(new Error('cancel recording before worker allocation'))
    await vi.waitFor(() => { expect(request.signal?.aborted).toBe(true) })
    grant.resolve(lease)
    expect(await active).toHaveProperty('error')
    expect(allocations).toBe(0)
    expect(release).toHaveBeenCalledOnce()
    expect(uncertain).not.toHaveBeenCalled()
    const next = new AbortController()
    expect(await speech.transcribe(spec, next.signal)).toMatchObject({ text: 'zh' })
    expect(allocations).toBe(1)
    next.abort(new Error('completed recording lifetime ended'))
    expect(await speech.transcribe(spec, new AbortController().signal)).toMatchObject({ text: 'zh' })
    expect(allocations).toBe(1)
  } finally {
    grant.resolve(lease)
    await active
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
})

it.each([false, true])('queues recordings during startup and honors waiting cancellation (%s)', async (cancelled) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speech-queue-')), ctx = new Context()
  const startupEntered = Promise.withResolvers<undefined>(), releaseStartup = Promise.withResolvers<undefined>()
  const gate = createServer((_request, response) => {
    startupEntered.resolve(undefined)
    void releaseStartup.promise.then(() => { response.end('ready') })
  })
  try {
    await new Promise<void>((resolve, reject) => { gate.once('error', reject); gate.listen(0, '127.0.0.1', resolve) })
    const address = gate.address()
    if (!address || typeof address === 'string') throw Error('Missing gate address')
    const worker = join(root, 'worker.mjs')
    const fixtureUrl = new URL('./worker.fixture.mjs', import.meta.url).href
    await writeFile(worker, `await fetch('http://127.0.0.1:${address.port}/');\nawait import(${JSON.stringify(fixtureUrl)});\n`)
    vi.mocked(inspectRuntime).mockResolvedValue({ tokens: root, model: root, vad: root, worker })
    await ctx.plugin(LocalSubprocess)
    await ctx.plugin(SpeechToText, { defaultProvider: 'sensevoice-local', language: 'auto' })
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    const enqueue = vi.spyOn(SenseVoiceWorker.prototype, 'transcribe')
    await ctx.plugin(Provider, { dataRoot: root, idleTimeoutMs: 0, maxPending: 2 })
    const speech = ctx.get('speechToText')!
    await vi.waitFor(() => { expect(speech.snapshot().providers[0]?.preparation.phase).toBe('standby') })
    const firstSpec = speech.resolve({ audio: new Uint8Array([1, 2]), language: 'zh' })
    const secondSpec = speech.resolve({ audio: new Uint8Array([3, 4]), language: 'en' })
    const first = speech.transcribe(firstSpec, new AbortController().signal)
    const firstResult = first.then(value => ({ value }), (error: unknown) => ({ error }))
    try {
      await startupEntered.promise
      expect(speech.snapshot().providers[0]?.preparation.phase).toBe('waking')
      const waiting = new AbortController()
      const second = speech.transcribe(secondSpec, waiting.signal)
      const secondResult = second.then(value => ({ value }), (error: unknown) => ({ error }))
      await Promise.resolve()
      expect(enqueue).toHaveBeenCalledTimes(2)
      await expect(speech.transcribe(secondSpec, new AbortController().signal)).rejects.toThrow('queue is full')
      if (cancelled) waiting.abort(new Error('waiting recording cancelled'))
      releaseStartup.resolve(undefined)
      expect(await firstResult).toMatchObject({ value: { text: 'zh' } })
      if (cancelled) expect(await secondResult).toMatchObject({ error: { message: 'waiting recording cancelled' } })
      else expect(await secondResult).toMatchObject({ value: { text: 'en' } })
      expect(await readFile(join(root, 'requests'), 'utf8')).toBe(cancelled ? 'zh\n' : 'zh\nen\n')
      expect(spawn).toHaveBeenCalledOnce()
      expect(prepareRuntime).not.toHaveBeenCalled()
    } finally { releaseStartup.resolve(undefined); await firstResult }
  } finally {
    releaseStartup.resolve(undefined)
    try { await ctx.fiber.dispose() } finally {
      try {
        if (gate.listening) await new Promise<void>((resolve, reject) => {
          gate.close((error) => { if (error) reject(error); else resolve() })
        })
      } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
})
