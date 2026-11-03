/** Native HTTP search must obtain model admission before sending a request. */
import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime, { type WebSearchProvider } from '@deepseek-ai/dsh-web'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as ApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { ResourceAdmissionError, type ResourceLease, type ResourceRequest } from '@deepseek-ai/dsh-resource-budget'
import * as Search from '../src/index.ts'
import { expect, it, onTestFinished, vi } from 'vitest'

const resultBody = { content: [{ type: 'web_search_tool_result', content: [
  { type: 'web_search_result', url: 'https://result.test', title: 'Result' },
] }] }

async function fixture(handler?: RequestListener) {
  let contacted = 0
  const server = createServer((request, response) => {
    contacted += 1
    if (handler !== undefined) { handler(request, response); return }
    request.resume()
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(resultBody))
  })
  const ctx = new Context()
  onTestFinished(async () => {
    server.closeAllConnections()
    const results = await Promise.allSettled([
      ctx.fiber.dispose(),
      server.listening
        ? new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
        : Promise.resolve(),
    ])
    const failures = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'Native search fixture cleanup failed')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  await ctx.plugin(WebRuntime, {})
  const baseURL = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  return { ctx, baseURL, contacted: () => contacted, start: () => ctx.plugin(Search, { apiKey: 'owned-fixture-key', baseURL }) }
}

function permit(signal = new AbortController().signal): ResourceLease & { release: ReturnType<typeof vi.fn<() => Promise<void>>> } {
  return { signal, release: vi.fn(async () => {}), uncertain: async () => {} }
}

it.each([
  { phase: 'admission', change: 'withdrawn' }, { phase: 'admission', change: 'replaced' },
  { phase: 'credential', change: 'withdrawn' }, { phase: 'credential', change: 'replaced' },
  { phase: 'credential', change: 'policy' },
  { phase: 'credential', change: 'installed' },
] as const)('refuses native HTTP after $change ownership during $phase', async ({ phase, change }) => {
  const { ctx, baseURL, contacted } = await fixture(), lease = permit()
  const entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
  const replacement = vi.fn(async () => lease), credential = vi.fn(async () => {
    if (phase === 'credential') { entered.resolve(undefined); await proceed.promise }
    return { value: 'owned-fixture-key', source: 'file' }
  })
  ctx.provide('credentials', { resolve: credential })
  const withdraw = change === 'installed' ? () => {} : ctx.provide('resourceBudget', { async acquire() {
    if (phase === 'admission') { entered.resolve(undefined); await proceed.promise }
    return lease
  } })
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('native-admission-owner')), records: unknown[] = []
  ctx.provide('agents', { currentInitiator: () => ({ session }) })
  ctx.on('session/event', (_owner, event) => { if (event.type === 'web/deepseek-search-llm-request') records.push(event.data) })
  await ctx.plugin(Search, { baseURL, apiKeyEnv: 'OWNER_SEARCH_KEY' })
  const pending = ctx.web.search({ query: 'private query' }), observed = pending.catch((error: unknown) => error)
  try {
    await entered.promise
    if (change === 'policy') ctx.provide('modelAccessRequired', true)
    else { withdraw(); if (change === 'replaced' || change === 'installed') ctx.provide('resourceBudget', { acquire: replacement }) }
    proceed.resolve(undefined)
    expect(await observed).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(contacted()).toBe(0)
    expect(records).toEqual([])
    expect(credential).toHaveBeenCalledTimes(phase === 'credential' ? 1 : 0)
    expect(lease.release).toHaveBeenCalledTimes(change === 'installed' ? 0 : 1)
    expect(replacement).not.toHaveBeenCalled()
  } finally { proceed.resolve(undefined); await observed }
})

it('refuses a retained native callback when its required LLM service is absent', async () => {
  const { ctx, contacted, start } = await fixture()
  const registered: { provider?: WebSearchProvider } = {}
  const register = ctx.web.registerSearchProvider.bind(ctx.web)
  vi.spyOn(ctx.web, 'registerSearchProvider').mockImplementation((provider) => { registered.provider = provider; return register(provider) })
  ctx.provide('modelAccessRequired', true)
  await start()
  if (registered.provider === undefined) throw new Error('Native search did not register its callback.')
  expect(registered.provider.available()).toBe(false)
  await expect(registered.provider.search({ query: 'fixture' })).rejects.toMatchObject({
    code: 'WEB_PROVIDER_ERROR', message: 'Governed DeepSeek search requires the LLM service.',
  })
  expect(contacted()).toBe(0)
})

it('refuses switching from independent transport to newly required policy after admission', async () => {
  const { ctx, contacted, start } = await fixture()
  const lease = permit()
  ctx.provide('resourceBudget', { acquire: async () => {
    ctx.provide('modelAccessRequired', true)
    return lease
  } })
  await start()
  await expect(ctx.web.search({ query: 'fixture' })).rejects.toThrow('authorization changed during admission')
  expect(contacted()).toBe(0)
  expect(lease.release).toHaveBeenCalledOnce()
})

it.each([false, true])('executes an explicitly selected model route with initiating Session=%s', async (withSession) => {
  const { ctx, baseURL, contacted } = await fixture()
  const home = await mkdtemp(join(tmpdir(), 'dsh-independent-governed-search-'))
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('NATIVE_PUBLIC_KEY', 'owned-fixture-key')
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) }
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  const session = withSession ? ctx.sessions.create(SessionId('governed-native-owner')) : undefined
  if (session !== undefined) ctx.provide('agents', { currentInitiator: () => ({ session }) })
  await ctx.plugin(ApiKey, { baseURL, apiKeyEnv: 'NATIVE_PUBLIC_KEY' })
  const lease = permit()
  const acquire = vi.fn(async (_request: ResourceRequest) => lease)
  ctx.provide('resourceBudget', { acquire })
  await ctx.plugin(Search, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  expect((await ctx.web.search({ query: 'fixture' })).sources).toHaveLength(1)
  expect(contacted()).toBe(1)
  expect(acquire).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'model', origin: 'execution' }))
  if (session === undefined) expect(acquire.mock.calls[0]?.[0]).not.toHaveProperty('sessionId')
  else {
    expect(acquire.mock.calls[0]?.[0]).toHaveProperty('sessionId', session.id)
    expect(session.snapshotEvents().filter(event => event.type === 'web/deepseek-search-llm-request')).toHaveLength(1)
  }
  expect(lease.release).toHaveBeenCalledOnce()
})

it.for(['refused', 'cancelled'] as const)('refuses native Messages before HTTP when model admission is %s', async (reason) => {
  const { ctx, contacted, start } = await fixture()
  ctx.provide('resourceBudgetRequired', true)
  const cause = new ResourceAdmissionError(reason, 'node refused model admission')
  ctx.provide('resourceBudget', { async acquire() { throw cause } })
  await start()
  await expect(ctx.web.search({ query: 'private fixture query' })).rejects.toMatchObject({
    code: reason === 'cancelled' ? 'WEB_ABORTED' : 'WEB_PROVIDER_ERROR', cause,
  })
  expect(contacted()).toBe(0)
})

it('refuses managed search when its admission provider is missing', async () => {
  const { ctx, contacted, start } = await fixture()
  ctx.provide('resourceBudgetRequired', true)
  await start()
  await expect(ctx.web.search({ query: 'fixture' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', cause: { reason: 'unavailable' } })
  expect(contacted()).toBe(0)
})

it('waits for a model grant and retains it through the real HTTP response body', async () => {
  const bodyStarted = Promise.withResolvers<undefined>(), bodyReady = Promise.withResolvers<undefined>()
  const { ctx, contacted, start } = await fixture((request, response) => {
    request.resume()
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"content":')
    bodyStarted.resolve(undefined)
    void bodyReady.promise.then(() => { response.end(JSON.stringify(resultBody.content) + '}') })
  })
  const entered = Promise.withResolvers<ResourceRequest>(), granted = Promise.withResolvers<ResourceLease>()
  const lease = permit()
  ctx.provide('resourceBudget', { acquire(request: ResourceRequest) { entered.resolve(request); return granted.promise } })
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('native-search-model'))
  const other = ctx.sessions.create(SessionId('native-search-other'))
  let currentSession = session
  ctx.provide('agents', { currentInitiator: () => ({ session: currentSession }) })
  const records: unknown[] = []
  const owners: unknown[] = []
  ctx.on('session/event', (owner, event) => {
    if (event.type === 'web/deepseek-search-llm-request') { records.push(event.data); owners.push(owner) }
  })
  await start()
  const searching = ctx.web.search({ query: 'fixture' })
  try {
    expect(await entered.promise).toMatchObject({ kind: 'model', origin: 'execution', sessionId: session.id })
    expect(contacted()).toBe(0)
    currentSession = other
    granted.resolve(lease)
    await bodyStarted.promise
    expect(records).toHaveLength(1)
    expect(owners).toEqual([session])
    expect(lease.release).not.toHaveBeenCalled()
    bodyReady.resolve(undefined)
    expect((await searching).sources).toHaveLength(1)
    expect(lease.release).toHaveBeenCalledTimes(1)
  } finally {
    granted.resolve(lease)
    bodyReady.resolve(undefined)
    await Promise.allSettled([searching])
  }
})

it('joins a late model grant during provider unload without contacting HTTP', async () => {
  const { ctx, contacted, start } = await fixture()
  const entered = Promise.withResolvers<ResourceRequest>(), granted = Promise.withResolvers<ResourceLease>()
  const lease = permit()
  const releaseEntered = Promise.withResolvers<undefined>(), releaseReady = Promise.withResolvers<undefined>()
  lease.release.mockImplementation(() => { releaseEntered.resolve(undefined); return releaseReady.promise })
  ctx.provide('resourceBudget', { acquire(request: ResourceRequest) { entered.resolve(request); return granted.promise } })
  const provider = await start()
  const searching = ctx.web.search({ query: 'fixture' })
  const outcome = searching.then(() => ({ kind: 'success' as const }), (error: unknown) => ({ kind: 'failure' as const, error }))
  let disposal: Promise<void> | undefined
  try {
    const request = await entered.promise
    const signal = request.signal
    if (signal === undefined) throw new Error('model admission must receive cancellation')
    const stopped = Promise.withResolvers<undefined>()
    signal.addEventListener('abort', () => { stopped.resolve(undefined) }, { once: true })
    let disposed = false
    disposal = provider.dispose().then(() => { disposed = true })
    await stopped.promise
    granted.resolve(lease)
    await releaseEntered.promise
    expect(disposed).toBe(false)
    releaseReady.resolve(undefined)
    expect((await outcome).kind).toBe('failure')
    await disposal
    expect(lease.release).toHaveBeenCalledTimes(1)
    expect(contacted()).toBe(0)
  } finally {
    granted.resolve(lease)
    releaseReady.resolve(undefined)
    await Promise.allSettled([searching, ...disposal === undefined ? [] : [disposal]])
  }
})

it.for(['caller', 'provider', 'budget'] as const)('cancels an active native response when %s stops it', async (owner) => {
  const bodyStarted = Promise.withResolvers<undefined>()
  const { ctx, start } = await fixture((request, response) => {
    request.resume()
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"content":')
    bodyStarted.resolve(undefined)
  })
  const budgetAbort = new AbortController(), lease = permit(budgetAbort.signal)
  const controller = new AbortController()
  ctx.provide('resourceBudget', { async acquire() { return lease } })
  const provider = await start()
  const searching = ctx.web.search({ query: 'fixture' }, controller.signal)
  const outcome = searching.then(() => ({ kind: 'success' as const }), (error: unknown) => ({ kind: 'failure' as const, error }))
  await bodyStarted.promise
  if (owner === 'caller') controller.abort()
  else if (owner === 'budget') budgetAbort.abort()
  else await provider.dispose()
  expect(await outcome).toMatchObject({ kind: 'failure', error: { code: 'WEB_ABORTED' } })
  expect(lease.release).toHaveBeenCalledTimes(1)
})

it('does not acquire a permit for an already cancelled native search', async () => {
  const { ctx, contacted, start } = await fixture()
  const acquire = vi.fn(async () => permit())
  ctx.provide('resourceBudget', { acquire })
  await start()
  const cause = new Error('owned caller cancellation')
  await expect(ctx.web.search({ query: 'fixture' }, AbortSignal.abort(cause))).rejects.toMatchObject({ code: 'WEB_ABORTED', cause })
  expect(acquire).not.toHaveBeenCalled()
  expect(contacted()).toBe(0)
})

it('releases an already revoked grant without sending the native request', async () => {
  const { ctx, contacted, start } = await fixture()
  const cause = new Error('owned grant revocation'), lease = permit(AbortSignal.abort(cause))
  ctx.provide('resourceBudget', { async acquire() { return lease } })
  await start()
  await expect(ctx.web.search({ query: 'fixture' })).rejects.toMatchObject({ code: 'WEB_ABORTED', cause })
  expect(lease.release).toHaveBeenCalledTimes(1)
  expect(contacted()).toBe(0)
})

it('resolves native request defaults when a composition calls apply directly', async () => {
  let body: unknown, apiVersion: string | string[] | undefined
  const { ctx, baseURL } = await fixture((request, response) => {
    const chunks: Buffer[] = []
    apiVersion = request.headers['anthropic-version']
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.once('end', () => {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(resultBody))
    })
  })
  await ctx.plugin({ inject: Search.inject, apply(owner: Context) { Search.apply(owner, { apiKey: 'owned-fixture-key', baseURL }) } })
  expect((await ctx.web.search({ query: 'fixture defaults' })).sources).toHaveLength(1)
  expect(body).toMatchObject({ model: 'deepseek-v4-flash', max_tokens: 4096,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] })
  expect(apiVersion).toBe('2023-06-01')
})

it.for([false, true])('retains model-permit release failure with provider failure=%s', async (providerFails) => {
  const { ctx, start } = await fixture(providerFails ? (request, response) => {
    request.resume(); response.writeHead(503); response.end()
  } : undefined)
  const cause = new Error('owned permit release failed'), lease = permit()
  lease.release.mockRejectedValue(cause)
  ctx.provide('resourceBudget', { async acquire() { return lease } })
  await start()
  const outcome = ctx.web.search({ query: 'fixture' })
  if (providerFails) {
    await expect(outcome).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR',
      cause: { errors: [expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }), cause] } })
  } else await expect(outcome).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', cause })
})

it('normalizes a non-Error admission rejection without contacting HTTP', async () => {
  const { ctx, contacted, start } = await fixture()
  ctx.provide('resourceBudget', { acquire: vi.fn<() => Promise<ResourceLease>>().mockRejectedValue('owned admission failure') })
  await start()
  await expect(ctx.web.search({ query: 'fixture' })).rejects.toMatchObject({
    code: 'WEB_PROVIDER_ERROR', message: 'DeepSeek search model admission failed', cause: 'owned admission failure',
  })
  expect(contacted()).toBe(0)
})
