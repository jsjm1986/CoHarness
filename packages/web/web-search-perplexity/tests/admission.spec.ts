/** Sonar registration must retain admission and configuration ownership. */
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { ResourceAdmissionError, type ResourceLease, type ResourceRequest } from '@deepseek-ai/dsh-resource-budget'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Search from '../src/index.ts'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'

async function fixture() {
  const ctx = new Context()
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ citations: ['https://result.test'] })))
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { fetch.mockRestore() } })
  await ctx.plugin(WebRuntime)
  const config = { apiKey: 'initial-key', baseURL: 'https://initial.test', model: 'sonar', maxTokens: 32 }
  return { ctx, fetch, config, start: () => ctx.plugin(Search, config) }
}

it('uses the default Sonar model when independent registration omits a model', async () => {
  const f = await fixture()
  await f.ctx.plugin(Search, { apiKey: 'owned-fixture-key', baseURL: f.config.baseURL, maxTokens: 32 })
  await f.ctx.web.search({ query: 'default route' })
  const body = f.fetch.mock.calls[0]?.[1]?.body
  if (typeof body !== 'string') throw new Error('Search body did not contain JSON text')
  expect(JSON.parse(body)).toHaveProperty('model', Search.PERPLEXITY_DEFAULT_MODEL)
})

it('leaves an explicit route unavailable while only unrelated model adapters are mounted', async () => {
  const f = await fixture()
  await f.ctx.plugin(LlmRuntime)
  class OtherModel extends LlmAdapter {
    async *stream(): AsyncIterable<never> { throw new Error('Unrelated adapter was called') }
  }
  f.ctx.llm.registerAdapter(['unrelated'], new OtherModel())
  await f.ctx.plugin(Search, { provider: 'missing-route', model: 'sonar' })
  await expect(f.ctx.web.search({ query: 'unavailable route' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
  expect(f.fetch).not.toHaveBeenCalled()
})

it.each([
  { phase: 'admission', change: 'withdrawn' }, { phase: 'admission', change: 'replaced' },
  { phase: 'credential', change: 'withdrawn' }, { phase: 'credential', change: 'replaced' },
  { phase: 'credential', change: 'policy' },
  { phase: 'credential', change: 'installed' },
] as const)('refuses Sonar HTTP after $change ownership during $phase', async ({ phase, change }) => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
  const release = vi.fn(async () => {}), lease = { signal: new AbortController().signal, release, uncertain: async () => {} }
  const replacement = vi.fn(async () => lease), credential = vi.fn(async () => {
    if (phase === 'credential') { entered.resolve(undefined); await proceed.promise }
    return { value: 'owned-fixture-key', source: 'file' }
  })
  f.config.apiKey = ''
  f.ctx.provide('credentials', { resolve: credential })
  const withdraw = change === 'installed' ? () => {} : f.ctx.provide('resourceBudget', { async acquire() {
    if (phase === 'admission') { entered.resolve(undefined); await proceed.promise }
    return lease
  } })
  await f.ctx.plugin(SessionStore)
  const session = f.ctx.sessions.create(SessionId('sonar-admission-owner')), records: unknown[] = []
  f.ctx.provide('agents', { currentInitiator: () => ({ session }) })
  f.ctx.on('session/event', (_owner, event) => { if (event.type === 'web/perplexity-search-llm-request') records.push(event.data) })
  await f.start()
  const pending = f.ctx.web.search({ query: 'private query' }), observed = pending.catch((error: unknown) => error)
  try {
    await entered.promise
    if (change === 'policy') f.ctx.provide('modelAccessRequired', true)
    else { withdraw(); if (change === 'replaced' || change === 'installed') f.ctx.provide('resourceBudget', { acquire: replacement }) }
    proceed.resolve(undefined)
    expect(await observed).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(f.fetch).not.toHaveBeenCalled()
    expect(records).toEqual([])
    expect(credential).toHaveBeenCalledTimes(phase === 'credential' ? 1 : 0)
    expect(release).toHaveBeenCalledTimes(change === 'installed' ? 0 : 1)
    expect(replacement).not.toHaveBeenCalled()
  } finally { proceed.resolve(undefined); await observed }
})

it.each(['refused', 'cancelled'] as const)('refuses Sonar HTTP after %s model admission', async (reason) => {
  const f = await fixture()
  f.ctx.provide('resourceBudgetRequired', true)
  f.ctx.provide('resourceBudget', { async acquire() { throw new ResourceAdmissionError(reason, 'Owned admission refusal.') } })
  await f.start()
  await expect(f.ctx.web.search({ query: 'private query' })).rejects.toMatchObject({
    code: reason === 'cancelled' ? 'WEB_ABORTED' : 'WEB_PROVIDER_ERROR',
  })
  expect(f.fetch).not.toHaveBeenCalled()
})

it('resolves current independent credentials after a grant and settles the owned model permit', async () => {
  const f = await fixture()
  f.config.apiKey = ''
  let credential = 'initial-key'
  f.ctx.provide('credentials', { async resolve() { return { value: credential, source: 'file' } } })
  const entered = Promise.withResolvers<ResourceRequest>(), granted = Promise.withResolvers<ResourceLease>()
  const release = vi.fn(async () => {})
  const lease = { signal: new AbortController().signal, release, uncertain: async () => {} }
  f.ctx.provide('resourceBudget', { acquire(request: ResourceRequest) { entered.resolve(request); return granted.promise } })
  await f.start()
  const pending = f.ctx.web.search({ query: 'captured query' })
  try {
    expect(await entered.promise).toMatchObject({ kind: 'model', origin: 'execution' })
    expect(f.fetch).not.toHaveBeenCalled()
    credential = 'current-key'
    granted.resolve(lease)
    expect((await pending).sources).toHaveLength(1)
    expect(f.fetch).toHaveBeenCalledOnce()
    const [url, init] = f.fetch.mock.calls[0]!
    expect(url).toBe('https://initial.test/chat/completions')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer current-key')
    expect(init?.body).toBe(JSON.stringify({ model: 'sonar', max_tokens: 32, messages: [{ role: 'user', content: 'captured query' }] }))
    expect(release).toHaveBeenCalledOnce()
  } finally { granted.resolve(lease); await Promise.allSettled([pending]) }
})

it('joins a late Sonar permit during plugin unload without credentials or HTTP', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>(), granted = Promise.withResolvers<ResourceLease>()
  const release = vi.fn(async () => {})
  const lease = { signal: new AbortController().signal, release, uncertain: async () => {} }
  f.ctx.provide('resourceBudget', { acquire() { entered.resolve(undefined); return granted.promise } })
  const plugin = await f.start()
  const pending = f.ctx.web.search({ query: 'private query' })
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    closing = plugin.dispose()
    granted.resolve(lease)
    await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    await closing
    expect(release).toHaveBeenCalledOnce()
    expect(f.fetch).not.toHaveBeenCalled()
  } finally { granted.resolve(lease); await Promise.allSettled([pending, closing]) }
})

it('refuses managed Sonar search when the policy provider has withdrawn', async () => {
  const f = await fixture()
  f.ctx.provide('modelAccessRequired', true)
  await f.start()
  await expect(f.ctx.web.search({ query: 'private query' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
  expect(f.fetch).not.toHaveBeenCalled()
})

it.each([undefined, ''])('refuses a missing credential after admission without a private-key fallback: %s', async (value) => {
  const f = await fixture()
  f.config.apiKey = ''
  f.ctx.provide('credentials', { async resolve() { return value === undefined ? undefined : { value, source: 'file' } } })
  const release = vi.fn(async () => {})
  f.ctx.provide('resourceBudget', { async acquire() { return { signal: new AbortController().signal, release, uncertain: async () => {} } } })
  await f.start()
  await expect(f.ctx.web.search({ query: 'private query' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
  expect(f.fetch).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledOnce()
})

it('records the exact independent Sonar input in the initiating Session before HTTP', async () => {
  const f = await fixture()
  await f.ctx.plugin(SessionStore)
  const session = f.ctx.sessions.create(SessionId('standalone-sonar'))
  f.ctx.provide('agents', { currentInitiator: () => ({ session }) })
  const records: unknown[] = []
  f.ctx.on('session/event', (_owner, event) => {
    if (event.type === 'web/perplexity-search-llm-request') records.push(event.data)
  })
  f.fetch.mockImplementation(async () => {
    expect(records).toEqual([{ endpoint: 'https://initial.test/chat/completions', body: {
      model: 'sonar', max_tokens: 32, messages: [{ role: 'user', content: 'private query' }],
    } }])
    return new Response(JSON.stringify({ citations: [] }))
  })
  await f.start()
  await f.ctx.web.search({ query: 'private query' })
  expect(f.fetch).toHaveBeenCalledOnce()
})
