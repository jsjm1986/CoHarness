/** Real index Worker admission through the public service and its lifetime owner. */
import { Context, Service } from '@deepseek-ai/cordis'
import ResourceBudget, { type ResourceRequest } from '@deepseek-ai/dsh-resource-budget'
import { expect, it, onTestFinished, vi } from 'vitest'
import PluginMarket from '../src/index.ts'

it.each(['replaced', 'withdrawn'] as const)('refuses a market parser provider %s while its process grant waits', async (change) => {
  const ctx = new Context(), grant = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
  const replacement = vi.fn(async () => ({ signal: new AbortController().signal, release, uncertain }))
  const budget = { async acquire() {
    entered.resolve(undefined); await grant.promise
    return { signal: new AbortController().signal, release, uncertain }
  } }
  const withdraw = ctx.provide('resourceBudget', budget)
  class Manager extends Service {
    constructor(inner: Context) { super(inner, 'pluginManager') }
    listBundles() { return Promise.resolve([]) }
    listVersionExemptions() { return { exemptions: {}, warnings: [] } }
  }
  const url = 'https://market.example/index.json'
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return requestedUrl === url ? Promise.resolve(new Response(JSON.stringify({ format: 1, title: 'Market', plugins: [] })))
      : originalFetch(input, init)
  })
  onTestFinished(async () => {
    grant.resolve(undefined)
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
  })
  await ctx.plugin(Manager)
  await ctx.plugin(PluginMarket, { indexes: [url] })
  const pending = ctx.pluginMarket.search(url, { sort: { kind: 'index' }, offset: 0, limit: 1 })
  const observed = pending.then(value => ({ value }), (error: unknown) => ({ error }))
  await entered.promise
  withdraw()
  if (change === 'replaced') ctx.provide('resourceBudget', { acquire: replacement })
  grant.resolve(undefined)
  expect(await observed).toMatchObject({ error: { code: 'plugin-market/fetch-failed', cause: { reason: 'unavailable' } } })
  expect(release).toHaveBeenCalledOnce()
  expect(uncertain).not.toHaveBeenCalled()
  expect(replacement).not.toHaveBeenCalled()
})

it('keeps a market search pending through process admission and confirmed resource completion', async () => {
  const ctx = new Context()
  const granted = Promise.withResolvers<undefined>()
  const requested = Promise.withResolvers<ResourceRequest>()
  const completing = Promise.withResolvers<undefined>()
  const completed = Promise.withResolvers<undefined>()
  onTestFinished(async () => {
    granted.resolve(undefined)
    completed.resolve(undefined)
    await ctx.fiber.dispose()
  })
  const release = vi.fn(async () => { completing.resolve(undefined); await completed.promise })
  const uncertain = vi.fn(async () => {})
  class Budget extends ResourceBudget {
    async acquire(request: ResourceRequest) {
      requested.resolve(request)
      await granted.promise
      return { signal: new AbortController().signal, release, uncertain }
    }
  }
  class Manager extends Service {
    constructor(inner: Context) { super(inner, 'pluginManager') }
    listBundles() { return Promise.resolve([]) }
    listVersionExemptions() { return { exemptions: {}, warnings: [] } }
  }
  const url = 'https://market.example/index.json'
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (requestedUrl !== url) return originalFetch(input, init)
    return Promise.resolve(new Response(JSON.stringify({ format: 1, title: 'Market', plugins: [] })))
  }))
  onTestFinished(() => { vi.unstubAllGlobals() })
  await ctx.plugin(Budget)
  await ctx.plugin(Manager)
  await ctx.plugin(PluginMarket, { indexes: [url] })
  let settled = false
  const result = ctx.pluginMarket.search(url, { sort: { kind: 'index' }, offset: 0, limit: 1 })
  void result.then(() => { settled = true }, () => { settled = true })
  const request = await requested.promise
  expect(request.kind).toBe('process')
  expect(request.origin).toBe('infrastructure')
  expect(request.signal).toBeInstanceOf(AbortSignal)
  expect(settled).toBe(false)
  granted.resolve(undefined)
  await completing.promise
  expect(settled).toBe(false)
  expect(release).toHaveBeenCalledOnce()
  completed.resolve(undefined)
  expect(await result).toMatchObject({ total: 0, entries: [] })
  expect(uncertain).not.toHaveBeenCalled()
})

it('refuses managed parsing when its resource provider has been withdrawn', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('resourceBudgetRequired', true)
  class Manager extends Service {
    constructor(inner: Context) { super(inner, 'pluginManager') }
    listBundles() { return Promise.resolve([]) }
    listVersionExemptions() { return { exemptions: {}, warnings: [] } }
  }
  const url = 'https://market.example/index.json'
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (requestedUrl !== url) return originalFetch(input, init)
    return Promise.resolve(new Response(JSON.stringify({ format: 1, title: 'Market', plugins: [] })))
  })
  onTestFinished(() => { vi.unstubAllGlobals() })
  await ctx.plugin(Manager)
  await ctx.plugin(PluginMarket, { indexes: [url] })
  await expect(ctx.pluginMarket.search(url, { sort: { kind: 'index' }, offset: 0, limit: 1 }))
    .rejects.toMatchObject({ cause: { reason: 'unavailable' } })
})
