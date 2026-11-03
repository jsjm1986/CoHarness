/** Native browser ownership through real Agent, Session, and ToolRuntime services. */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StagehandDrainError } from '../src/native.ts'
import { ResourceAcquisitionCleanupError } from '@deepseek-ai/dsh-experimental-browser-use-runtime'
import type { NativeBrowserConfig } from '../src/native.ts'
import type { BrowserWorkerAdmission } from '../src/worker-client.ts'
import type { StagehandModelHandler } from '../src/model.ts'
import type { ClientLLM } from '@browserbasehq/stagehand'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import ResourceBudget from '@deepseek-ai/dsh-resource-budget'
import * as Provider from '../src/index.ts'
import { fixture, nativeModel, resetFixture } from './fixtures/stagehand.ts'

const acquisition = vi.hoisted(() => ({
  signal: undefined as AbortSignal | undefined, warning: undefined as string | undefined,
  closeError: undefined as Error | undefined, chromiumCloseError: undefined as Error | undefined,
  admission: undefined as BrowserWorkerAdmission | undefined,
  openError: undefined as Error | undefined,
  openWait: undefined as Promise<void> | undefined, attempts: 0,
}))

vi.mock('playwright-core', async () => import('./fixtures/cdp.ts'))
vi.mock('@browserbasehq/stagehand', async importActual => ({
  ...await importActual<typeof import('@browserbasehq/stagehand')>(),
  ...await import('./fixtures/stagehand.ts'),
}))
vi.mock('@puppeteer/browsers', async () => import('./fixtures/chromium.ts'))
vi.mock('@deepseek-ai/dsh-subprocess-local', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-subprocess-local')>()
  const { allocateChromium } = await import('./fixtures/chromium.ts')
  return { ...original, LocalSubprocessRuntime: class extends original.LocalSubprocessRuntime {
    protected override spawnProcess(spec: import('@deepseek-ai/dsh-subprocess').SubprocessSpawnSpec) { return allocateChromium(spec) }
  } }
})
vi.mock('../src/launch.ts', async (importActual) => {
  const actual = await importActual<typeof import('../src/launch.ts')>()
  return {
    async launchChromium(...args: Parameters<typeof actual.launchChromium>) {
      const chromium = await actual.launchChromium(...args)
      return {
        ...chromium,
        async close() {
          await chromium.close()
          if (acquisition.chromiumCloseError !== undefined) throw acquisition.chromiumCloseError
        },
      }
    },
  }
})
vi.mock('../src/worker-client.ts', async () => {
  const { openNativeBrowser } = await import('../src/native.ts')
  return {
    async openBrowserWorker(
      config: NativeBrowserConfig, signal: AbortSignal, warn: (message: string) => void,
      model: StagehandModelHandler, admission?: BrowserWorkerAdmission,
    ) {
      acquisition.signal = signal
      acquisition.admission = admission
      acquisition.attempts++
      await acquisition.openWait
      if (acquisition.openError !== undefined) throw acquisition.openError
      let operationSignal = AbortSignal.abort()
      const native = await openNativeBrowser(config, { generate: input => model(input, operationSignal) as ReturnType<ClientLLM['generate']> })
      let closing: Promise<void> | undefined
      const close = () => closing ??= (async () => {
        if (acquisition.warning !== undefined) warn(acquisition.warning)
        if (acquisition.closeError !== undefined) throw acquisition.closeError
        await native.close()
      })()
      return {
        async execute(method: import('../src/native.ts').BrowserMethod, args: unknown, signal?: AbortSignal) {
          if (closing !== undefined) throw new Error('Fixture connection is closed')
          operationSignal = signal ?? new AbortController().signal
          const cancel = () => { void close().catch(() => {}) }
          signal?.addEventListener('abort', cancel, { once: true })
          try { return await native.execute(method, args) } finally { signal?.removeEventListener('abort', cancel) }
        },
        close,
      }
    },
  }
})

let ctx: Context
let first: Agent
let second: Agent

class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('Stagehand called the Session model') }
}

class BrowserFixtureModel extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await fixture.inference?.()
    options.signal?.throwIfAborted()
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(fixture.result ?? { extraction: 'Fixture heading' }) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

beforeEach(async () => {
  resetFixture()
  acquisition.signal = undefined
  acquisition.warning = undefined
  acquisition.closeError = undefined
  acquisition.chromiumCloseError = undefined
  acquisition.admission = undefined
  acquisition.openError = undefined
  acquisition.openWait = undefined
  acquisition.attempts = 0
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  ctx.provide('attachments', {} as AttachmentStore)
  await ctx.plugin(BrowserUseRegistry)
  ctx.llm.registerAdapter(['fixture'], new IndependentSessionModel())
  ctx.llm.registerAdapter(['browser-fixture'], new BrowserFixtureModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  first = await harness.create(SessionId('stagehand-first'), { provider: 'fixture', model: 'structured' })
  second = await harness.create(SessionId('stagehand-second'), { provider: 'fixture', model: 'structured' })
})

afterEach(async () => { await ctx.fiber.dispose() })

function execute(agent: Agent, suffix: string, args: unknown, signal = new AbortController().signal) {
  return ctx.tools.execute({ agent, name: `stagehand_${suffix}`, arguments: args, callId: ToolCallId(`test-${suffix}`), signal })
}

async function cancelConnection(): Promise<void> {
  const entered: PromiseWithResolvers<undefined> = Promise.withResolvers()
  const released: PromiseWithResolvers<undefined> = Promise.withResolvers()
  fixture.screenshot = async () => { entered.resolve(undefined); await released.promise }
  const controller = new AbortController()
  const pending = execute(first, 'screenshot', {}, controller.signal)
  try {
    await entered.promise
    controller.abort(new Error('Cancel existing connection'))
    released.resolve(undefined)
    expect((await pending).isError).toBe(true)
  } finally {
    released.resolve(undefined)
    await pending
    delete fixture.screenshot
  }
}

it('retains failed reconnect cleanup before admitting another connection', async () => {
  await ctx.plugin(Provider, { model: nativeModel, mode: 'attach', cdpEndpoint: 'http://fixture' })
  await cancelConnection()
  const cleanup = vi.fn<() => Promise<void>>(async () => { throw new Error('Reconnect Worker is still alive') })
  acquisition.openError = new ResourceAcquisitionCleanupError(cleanup, new Error('Cannot terminate reconnect Worker'))
  expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(true)
  acquisition.openError = undefined
  expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(true)
  expect(acquisition.attempts).toBe(2)
  expect(cleanup).toHaveBeenCalledOnce()
  cleanup.mockResolvedValue(undefined)
  expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(false)
  expect(acquisition.attempts).toBe(3)
  expect(cleanup).toHaveBeenCalledTimes(2)
})

it.each(['retry', 'dispose'] as const)('finishes an already rolled-back reconnect during %s', async (action) => {
  const provider = ctx.plugin(Provider, { model: nativeModel, mode: 'attach', cdpEndpoint: 'http://fixture' })
  await provider
  await cancelConnection()
  acquisition.openError = new Error('Reconnect extension initialization failed')
  const result = await execute(first, 'tabs', { action: 'list' })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('Reconnect extension initialization failed')
  acquisition.openError = undefined
  if (action === 'retry') {
    expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(false)
    expect(acquisition.attempts).toBe(3)
  } else {
    await provider.dispose()
    expect(ctx.browserUse.providerName).toBeUndefined()
  }
})

it('retains the attached reservation when disposal joins failed reconnect cleanup', async () => {
  const provider = ctx.plugin(Provider, { model: nativeModel, mode: 'attach', cdpEndpoint: 'http://fixture' })
  await provider
  await cancelConnection()
  const cleanup = vi.fn<() => Promise<void>>(async () => { throw new Error('Reconnect Worker is still alive') })
  const opening: PromiseWithResolvers<undefined> = Promise.withResolvers()
  acquisition.openWait = opening.promise
  acquisition.openError = new ResourceAcquisitionCleanupError(cleanup, new Error('Cannot terminate reconnect Worker'))
  const pending = execute(first, 'tabs', { action: 'list' })
  try {
    await vi.waitFor(() => { expect(acquisition.attempts).toBe(2) })
    const signal = acquisition.signal!
    const aborted = new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    const disposing = provider.dispose()
    await aborted
    opening.resolve(undefined)
    expect((await pending).isError).toBe(true)
    await disposing
    expect(cleanup).toHaveBeenCalledOnce()
    expect(ctx.browserUse.providerName).toBe('stagehand-native')
  } finally {
    opening.resolve(undefined)
    await pending
    cleanup.mockResolvedValue(undefined)
    await cleanup()
  }
})

it('refuses managed browser allocation while its required node accountant is absent', async () => {
  ctx.provide('resourceBudgetRequired', true)
  await ctx.plugin(Provider, { model: nativeModel, mode: 'launch' })
  const result = await execute(first, 'tabs', { action: 'list' })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('Managed execution requires its resource admission provider')
  expect(fixture.browsers).toEqual([])
})

it('passes the exact live Session to managed Worker admission', async () => {
  const budget = { acquire: vi.fn() }
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('resourceBudget', budget as never)
  await ctx.plugin(Provider, { model: nativeModel, mode: 'attach', cdpEndpoint: 'http://localhost:9222' })
  expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(false)
  expect(acquisition.admission).toMatchObject({ budget, sessionId: first.id })
  expect(acquisition.admission?.assertOwnership).toBeTypeOf('function')
})

it.each(['withdrawn', 'replaced', 'installed', 'required'] as const)('retains the original resource Service through Worker startup when %s', async (change) => {
  class Budget extends ResourceBudget {
    async acquire() { return { signal: new AbortController().signal, async release() {}, async uncertain() {} } }
  }
  const original = change === 'installed' ? undefined : await ctx.plugin(Budget)
  await ctx.plugin(Provider, { model: nativeModel, mode: 'attach', cdpEndpoint: 'http://fixture' })
  expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(false)
  expect(() => acquisition.admission?.assertOwnership?.()).not.toThrow()
  await original?.dispose()
  if (change === 'required') ctx.provide('resourceBudgetRequired', true)
  if (change === 'replaced' || change === 'installed') await ctx.plugin(Budget)
  expect(() => acquisition.admission?.assertOwnership?.()).toThrow(change === 'required'
    ? 'Managed execution requires its resource admission provider'
    : 'Stagehand resource provider changed during browser acquisition')
})

it('refuses owned Chromium before allocation when its node accountant denies the Session', async () => {
  const acquire = vi.fn(async () => { throw new Error('No browser process capacity') })
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('resourceBudget', { acquire } as never)
  await ctx.plugin(Provider, { model: nativeModel, mode: 'launch' })
  const result = await execute(first, 'tabs', { action: 'list' })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('No browser process capacity')
  expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ kind: 'process', sessionId: first.id }))
  expect(fixture.browsers).toEqual([])
})

it('refuses extension inference before dispatch when node model admission is denied', async () => {
  const inference = vi.fn(async () => {})
  fixture.inference = inference
  const acquire = vi.fn(async (request: { kind: string }) => {
    if (request.kind === 'model') throw new Error('No native model capacity')
    return { signal: new AbortController().signal, async release() {}, async uncertain() {} }
  })
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('resourceBudget', { acquire } as never)
  await ctx.plugin(Provider, { model: nativeModel, mode: 'attach', cdpEndpoint: 'http://fixture' })
  const result = await execute(first, 'act', { instruction: 'Click the fixture button' })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('No native model capacity')
  expect(inference).not.toHaveBeenCalled()
  expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ kind: 'model', sessionId: first.id }))
})

it('preserves the attached browser reservation after initialization loses Worker termination proof', async () => {
  const cleanup = vi.fn(async () => { throw new Error('Worker remains alive') })
  acquisition.openError = new ResourceAcquisitionCleanupError(cleanup, new Error('Worker termination unavailable'))
  const provider = ctx.plugin(Provider, { model: nativeModel, mode: 'attach', cdpEndpoint: 'http://fixture' })
  await provider
  expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(true)
  acquisition.openError = undefined
  expect((await execute(second, 'tabs', { action: 'list' })).isError).toBe(true)
  expect(fixture.browsers).toEqual([])
  await provider.dispose()
  expect(cleanup).toHaveBeenCalledOnce()
  expect(ctx.browserUse.providerName).toBe('stagehand-native')
})

it('retains startup cleanup after an owned Chromium rollback fails', async () => {
  fixture.createError = new Error('Stagehand initialization failed')
  acquisition.chromiumCloseError = new Error('Chromium cleanup failed')
  const provider = ctx.plugin(Provider, { model: nativeModel, mode: 'launch' })
  await provider
  expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(true)
  await provider.dispose()
  expect(ctx.browserUse.providerName).toBe('stagehand-native')
  expect(fixture.browsers).toHaveLength(1)
})

it('releases a failed attachment only after transferred cleanup confirms shutdown', async () => {
  const cleanup = vi.fn(async () => {})
  acquisition.openError = new ResourceAcquisitionCleanupError(cleanup, new Error('Worker termination unavailable'))
  const provider = ctx.plugin(Provider, { model: nativeModel, mode: 'attach', cdpEndpoint: 'http://fixture' })
  await provider
  expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(true)
  await provider.dispose()
  expect(cleanup).toHaveBeenCalledOnce()
  expect(ctx.browserUse.providerName).toBeUndefined()
})

it('lazily launches distinct browsers and preserves each Session tab state', async () => {
  const provider = ctx.plugin(Provider, { model: nativeModel, mode: 'launch', executablePath: '/fixture/chromium', headless: false })
  await provider
  expect(fixture.browsers).toEqual([])
  const schemas = ctx.tools.schemas()
  expect(schemas).toHaveLength(6)
  for (const tool of schemas) expect(tool.parameters).toMatchObject({ type: 'object' })
  expect((await execute(first, 'navigate', { url: 'https://first.example' })).isError).toBe(false)
  expect((await execute(second, 'navigate', { url: 'https://second.example' })).isError).toBe(false)
  expect(fixture.browsers).toHaveLength(2)
  expect(fixture.browsers[0]?.options).toEqual({ executablePath: '/fixture/chromium', headless: false })
  expect(fixture.browsers.map(browser => browser.active.currentURL)).toEqual(['https://first.example', 'https://second.example'])
  expect((await execute(first, 'tabs', { action: 'new', url: 'https://new.example' })).isError).toBe(false)
  expect((await execute(first, 'tabs', { action: 'select', pageId: 'tab-1' })).isError).toBe(false)
  expect((await execute(first, 'tabs', { action: 'close', pageId: 'tab-2' })).isError).toBe(false)
  expect((await execute(first, 'tabs', { action: 'list' })).content).toEqual([{ type: 'text', text: '{"tabs":[{"pageId":"tab-1","url":"https://first.example","title":"Fixture heading","active":true}]}' }])
  await provider.dispose()
  expect(fixture.browsers.every(browser => browser.closed && browser.stagehandClosed)).toBe(true)
  expect(ctx.browserUse.providerName).toBeUndefined()
  expect(ctx.tools.schemas()).toEqual([])
})

it('reserves an attached browser for one live owner and rejects model connection overrides', async () => {
  await ctx.plugin(Provider, { model: nativeModel, mode: 'attach', cdpEndpoint: 'http://localhost:9222', extensionId: 'fixture-extension' })
  expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(false)
  expect((await execute(second, 'tabs', { action: 'list' })).isError).toBe(true)
  expect(fixture.browsers).toHaveLength(1)
  expect(fixture.browsers[0]?.options).toEqual({ cdpUrl: 'http://localhost:9222', extensionId: 'fixture-extension' })
  expect((await execute(first, 'navigate', { url: 'https://example.com', cdpEndpoint: 'http://other' })).isError).toBe(true)
  expect((await execute(first, 'act', { instruction: 'click', model: 'other' })).isError).toBe(true)
})

it('uses its independent model for actions, observations, and a caller-selected extraction schema', async () => {
  await ctx.plugin(Provider, { model: nativeModel, mode: 'launch' })
  expect((await execute(first, 'act', { instruction: 'Click the fixture button' })).isError).toBe(false)
  expect((await execute(first, 'observe', { instruction: 'Find the fixture heading' })).isError).toBe(false)
  fixture.result = { heading: 'Fixture heading' }
  const extraction = await execute(first, 'extract', {
    instruction: 'Extract the heading',
    schema: { type: 'object', properties: { heading: { type: 'string' } }, required: ['heading'] },
  })
  expect(extraction.isError).toBe(false)
  expect(fixture.models).toHaveLength(1)
  expect(typeof fixture.models[0]?.generate).toBe('function')
  expect(first.session.snapshotEvents().filter(event => event.type === 'browser-use/stagehand-llm-request')).toHaveLength(3)
  expect(JSON.stringify(extraction.content)).toContain('Fixture heading')
  fixture.actResult = { success: false, message: 'Fixture button unavailable' }
  fixture.result = { extraction: 'Missing button' }
  const refused = await execute(first, 'act', { instruction: 'Click the missing button' })
  expect(refused.isError).toBe(true)
  expect(JSON.stringify(refused.content)).toContain('Fixture button unavailable')
})

it('refuses unavailable tabs and calls without an exact live Agent', async () => {
  await ctx.plugin(Provider, { model: nativeModel, mode: 'launch' })
  expect((await execute(first, 'navigate', { url: 'https://example.com', pageId: 'missing' })).isError).toBe(true)
  expect((await ctx.tools.execute({ name: 'stagehand_tabs', arguments: { action: 'list' }, callId: ToolCallId('agentless'), signal: new AbortController().signal })).isError).toBe(true)
  ctx.tools.register({ name: 'unrelated', description: 'An independent tool.', parameters: { type: 'object' }, output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'independent' }] }, execute: async () => true })
  const unrelated = await ctx.tools.execute({ agent: first, name: 'unrelated', arguments: {}, callId: ToolCallId('unrelated'), signal: new AbortController().signal })
  expect(unrelated.isError).toBe(false)
})

it('rolls back the native browser after initialization fails', async () => {
  fixture.createError = new Error('Stagehand extension failed')
  await ctx.plugin(Provider, { model: nativeModel, mode: 'launch' })
  expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(true)
  expect(fixture.browsers[0]?.closed).toBe(true)
  delete fixture.createError
  expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(false)
  expect(fixture.browsers).toHaveLength(2)
})

it('connects to a WebSocket endpoint without a configured extension id', async () => {
  await ctx.plugin(Provider, { model: nativeModel, mode: 'attach', cdpEndpoint: 'ws://127.0.0.1:9222/devtools/browser/fixture' })
  expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(false)
  expect(fixture.browsers[0]?.options).toEqual({ cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/fixture' })
})

it('holds the provider reservation until browser cleanup settles', async () => {
  const started: PromiseWithResolvers<undefined> = Promise.withResolvers()
  const settle: PromiseWithResolvers<undefined> = Promise.withResolvers()
  fixture.browserClose = async () => { started.resolve(undefined); await settle.promise }
  const provider = ctx.plugin(Provider, { model: nativeModel, mode: 'launch' })
  await provider
  await execute(first, 'tabs', { action: 'list' })
  const closing = provider.dispose()
  try {
    await started.promise
    expect(ctx.tools.schemas()).toEqual([])
    expect(() => ctx.browserUse.register(BrowserUseProviderName('other'))).toThrow('already registered')
  } finally {
    settle.resolve(undefined)
    await closing
  }
  expect(ctx.browserUse.providerName).toBeUndefined()
})

it('cancels queued work without navigating while an earlier call settles', async () => {
  const started: PromiseWithResolvers<undefined> = Promise.withResolvers()
  const settle: PromiseWithResolvers<undefined> = Promise.withResolvers()
  fixture.navigate = async () => { started.resolve(undefined); await settle.promise }
  await ctx.plugin(Provider, { model: nativeModel, mode: 'launch' })
  const pending = execute(first, 'navigate', { url: 'https://first.example' })
  await started.promise
  const controller = new AbortController()
  const queued = execute(first, 'navigate', { url: 'https://canceled.example' }, controller.signal)
  controller.abort(new Error('Canceled queued navigation'))
  settle.resolve(undefined)
  expect((await pending).isError).toBe(false)
  expect((await queued).isError).toBe(true)
  expect(fixture.browsers[0]?.active.currentURL).toBe('https://first.example')
})

it.each([
  { model: nativeModel, mode: 'attach' },
  { model: nativeModel, mode: 'attach', cdpEndpoint: 'invalid endpoint' },
  { model: nativeModel, mode: 'attach', cdpEndpoint: 'file:///tmp/browser' },
  { model: nativeModel, mode: 'launch', cdpEndpoint: 'http://localhost:9222' },
  { model: nativeModel, mode: 'attach', cdpEndpoint: 'http://localhost:9222', executablePath: '/chrome' },
] satisfies Provider.Config[])('rejects inconsistent connection configuration %j before acquiring a browser', async (config) => {
  await expect(ctx.plugin(Provider, config)).rejects.toThrow()
  expect(fixture.browsers).toEqual([])
})

it.each(['cancel', 'dispose'] as const)('drains native inference before completing browser %s', async (reason) => {
  const started: PromiseWithResolvers<undefined> = Promise.withResolvers()
  const release: PromiseWithResolvers<undefined> = Promise.withResolvers()
  const closeStarted: PromiseWithResolvers<undefined> = Promise.withResolvers()
  fixture.inference = async () => { started.resolve(undefined); await release.promise }
  fixture.stagehandClose = () => { closeStarted.resolve(undefined) }
  const provider = ctx.plugin(Provider, { model: nativeModel, mode: 'attach', cdpEndpoint: 'http://fixture' })
  await provider
  const controller = new AbortController()
  const operation = execute(first, 'extract', { instruction: 'Read the heading' }, controller.signal)
  await started.promise
  let operationSettled = false
  void operation.then(() => { operationSettled = true })
  let disposal: Promise<void> | undefined
  try {
    if (reason === 'dispose') disposal = provider.dispose()
    else controller.abort(new Error('Cancel native inference'))
    await closeStarted.promise
    expect(operationSettled).toBe(false)
    expect(ctx.browserUse.providerName).toBe('stagehand-native')
    expect((await execute(second, 'tabs', { action: 'list' })).isError).toBe(true)
  } finally {
    release.resolve(undefined)
    await disposal
    expect((await operation).isError).toBe(true)
  }
  expect(fixture.browsers[0]?.stagehandClosed).toBe(true)
  expect(fixture.browsers[0]?.closed).toBe(false)
})

it.each([
  { shutdownGraceMs: 2 ** 31 },
  { operationTimeoutMs: 2 ** 31 - 10000 },
])('rejects timer overflow %j', (settings) => {
  expect(() => Provider.Config({ model: nativeModel, mode: 'launch', ...settings })).toThrow()
})

it.each([false, true])('retains late initialization cleanup through provider disposal (cleanup failure: %s)', async (cleanupFailure) => {
  const started: PromiseWithResolvers<undefined> = Promise.withResolvers()
  const release: PromiseWithResolvers<undefined> = Promise.withResolvers()
  const aborted: PromiseWithResolvers<undefined> = Promise.withResolvers()
  fixture.create = async () => { started.resolve(undefined); await release.promise }
  if (cleanupFailure) acquisition.closeError = new Error('Late connection cleanup failed')
  const provider = ctx.plugin(Provider, { model: nativeModel, mode: 'attach', cdpEndpoint: 'http://fixture' })
  await provider
  const operation = execute(first, 'tabs', { action: 'list' })
  await started.promise
  acquisition.signal!.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
  const closing = provider.dispose()
  try {
    await aborted.promise
    release.resolve(undefined)
    expect((await operation).isError).toBe(true)
    await closing
    expect(fixture.browsers[0]?.stagehandClosed).toBe(!cleanupFailure)
    expect(fixture.browsers[0]?.closed).toBe(false)
    expect(ctx.browserUse.providerName).toBe(cleanupFailure ? 'stagehand-native' : undefined)
  } finally {
    release.resolve(undefined)
    await closing
  }
})


it.each([false, true])('disposes a real AgentHandle while its screenshot waits, with prior user cancel %s', async (cancelFirst) => {
  const entered: PromiseWithResolvers<undefined> = Promise.withResolvers()
  const stopped: PromiseWithResolvers<undefined> = Promise.withResolvers()
  fixture.screenshot = async () => { entered.resolve(undefined); await stopped.promise }
  fixture.browserClose = async () => { stopped.resolve(undefined) }
  class ScreenshotModel extends LlmAdapter {
    async * stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('blocked-screenshot'), name: 'stagehand_screenshot', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['screenshot'], new ScreenshotModel())
  await ctx.plugin(Provider, { model: nativeModel, mode: 'launch' })
  const owner = await ctx.agents.create({ sessionId: SessionId('screenshot-disposal'), agentOptions: { provider: 'screenshot', model: 'fixture' } })
  try {
    owner.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a screenshot.' }], source: { kind: 'user' } }))
    await entered.promise
    if (cancelFirst) {
      owner.agent.cancel({ kind: 'user' })
      stopped.resolve(undefined)
    }
    await owner.dispose()
    expect(fixture.browsers[0]?.closed).toBe(true)
    expect(ctx.agents.get(owner.agent.id)).toBeUndefined()
  } finally {
    stopped.resolve(undefined)
    await owner.dispose()
  }
})


it('releases the provider after a terminated connection reports an SDK cleanup warning', async () => {
  const warning = vi.spyOn(ctx.logger, 'warn')
  acquisition.warning = 'Stagehand SDK cleanup did not finish: deadline'
  const provider = ctx.plugin(Provider, { model: nativeModel, mode: 'launch' })
  await provider
  await execute(first, 'tabs', { action: 'list' })
  await provider.dispose()
  expect(warning).toHaveBeenCalledWith(acquisition.warning)
  expect(ctx.browserUse.providerName).toBeUndefined()
  expect(fixture.browsers[0]?.closed).toBe(true)
})

it('closes owned Chromium but retains the reservation if its Worker fails to terminate', async () => {
  acquisition.closeError = new Error('Worker failed to terminate')
  const provider = ctx.plugin(Provider, { model: nativeModel, mode: 'launch' })
  await provider
  await execute(first, 'tabs', { action: 'list' })
  await provider.dispose()
  expect(fixture.browsers[0]?.closed).toBe(true)
  expect(ctx.browserUse.providerName).toBe('stagehand-native')
})


it('reconnects after cancellation while preserving the owned browser and its tabs', async () => {
  const entered: PromiseWithResolvers<undefined> = Promise.withResolvers()
  const stopped: PromiseWithResolvers<undefined> = Promise.withResolvers()
  fixture.screenshot = async () => { entered.resolve(undefined); await stopped.promise }
  await ctx.plugin(Provider, { model: nativeModel, mode: 'launch' })
  await execute(first, 'navigate', { url: 'https://kept.example/' })
  const controller = new AbortController()
  const screenshot = execute(first, 'screenshot', {}, controller.signal)
  await entered.promise
  controller.abort({ kind: 'user' })
  try {
    stopped.resolve(undefined)
    expect((await screenshot).isError).toBe(true)
    expect(fixture.browsers).toHaveLength(1)
    expect(fixture.browsers[0]?.closed).toBe(false)
    const tabs = await execute(first, 'tabs', { action: 'list' })
    expect(tabs.isError).toBe(false)
    expect(JSON.stringify(tabs.content)).toContain('https://kept.example/')
    expect(fixture.browsers).toHaveLength(1)
  } finally {
    stopped.resolve(undefined)
  }
})

it.each([
  undefined,
  { modelName: 'openai/gpt-5.4-mini' },
  { modelName: 'openai/gpt-5.4-mini', apiKey: ' ' },
  { modelName: 'deepseek/deepseek-chat', apiKey: 'fixture' },
  { modelName: 'openai/gpt-5.4-mini', apiKey: 'fixture', baseURL: 'https://fixture' },
])('rejects unsupported native model configuration before browser acquisition: %j', async (model) => {
  const input: unknown = { mode: 'launch', model }
  expect(() => Provider.Config(input as Provider.Config)).toThrow()
  expect(fixture.browsers).toEqual([])
})

it('uses the configured browser output cap without changing the Session model', async () => {
  const model = { ...nativeModel, maxTokens: 1000 }
  await ctx.plugin(Provider, { mode: 'launch', model })
  expect((await execute(first, 'extract', { instruction: 'Read the heading' })).isError).toBe(false)
  const event = first.session.snapshotEvents().find(event => event.type === 'browser-use/stagehand-llm-request')
  expect(event?.data).toMatchObject({ request: { ...model } })
  expect(first.options).toMatchObject({ provider: 'fixture', model: 'structured' })
})

it.each(['launch', 'attach'] as const)('releases an undrained extension only after owned Chromium has stopped (%s)', async (mode) => {
  acquisition.closeError = new StagehandDrainError('Extension request did not drain')
  const provider = ctx.plugin(Provider, { model: nativeModel, mode, ...mode === 'attach' ? { cdpEndpoint: 'http://fixture' } : {} })
  await provider
  await execute(first, 'tabs', { action: 'list' })
  await provider.dispose()
  expect(fixture.browsers[0]?.closed).toBe(mode === 'launch')
  expect(ctx.browserUse.providerName).toBe(mode === 'launch' ? undefined : 'stagehand-native')
})

it('retains ownership when both SDK drainage and owned Chromium cleanup fail', async () => {
  acquisition.closeError = new StagehandDrainError('Extension request did not drain')
  acquisition.chromiumCloseError = new Error('Chromium profile cleanup failed')
  const provider = ctx.plugin(Provider, { model: nativeModel, mode: 'launch' })
  await provider
  await execute(first, 'tabs', { action: 'list' })
  await provider.dispose()
  expect(fixture.browsers[0]?.closed).toBe(true)
  expect(ctx.browserUse.providerName).toBe('stagehand-native')
})

it('blocks reconnection and another owner after canceled native work fails to drain', async () => {
  const entered: PromiseWithResolvers<undefined> = Promise.withResolvers()
  const release: PromiseWithResolvers<undefined> = Promise.withResolvers()
  fixture.inference = async () => { entered.resolve(undefined); await release.promise }
  acquisition.closeError = new StagehandDrainError('Extension request did not drain')
  const provider = ctx.plugin(Provider, { model: nativeModel, mode: 'attach', cdpEndpoint: 'http://fixture' })
  await provider
  const controller = new AbortController()
  const operation = execute(first, 'extract', { instruction: 'Read the page' }, controller.signal)
  try {
    await entered.promise
    controller.abort(new Error('Cancel browser operation'))
  } finally {
    release.resolve(undefined)
  }
  expect((await operation).isError).toBe(true)
  expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(true)
  expect((await execute(second, 'tabs', { action: 'list' })).isError).toBe(true)
  expect(fixture.browsers).toHaveLength(1)
  await provider.dispose()
  expect(fixture.browsers[0]?.closed).toBe(false)
  expect(ctx.browserUse.providerName).toBe('stagehand-native')
})
