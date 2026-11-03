import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { attributionHeaders, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles, type ResolvedPiAiProviderProfile } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import WebRuntime from '@deepseek-ai/dsh-web'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as Perplexity from '@deepseek-ai/dsh-web-search-perplexity'

async function fixture(sonar = false) {
  const requests: Array<{ path: string; headers: import('node:http').IncomingHttpHeaders; body: unknown }> = []
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    void (async () => {
      const parts: Buffer[] = []
      for await (const part of request as AsyncIterable<Buffer>) parts.push(part)
      requests.push({ path: request.url!, headers: request.headers, body: JSON.parse(Buffer.concat(parts).toString()) })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(sonar ? { choices: [{ message: { content: 'Native answer' } }], citations: ['https://result.test'],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      } : { usage: { input_tokens: 3, output_tokens: 2 }, content: [
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://result.test' }] },
      ] }))
    })().catch((error: unknown) => { response.destroy(error instanceof Error ? error : new Error(String(error))) })
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket) }) })
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    for (const socket of sockets) socket.destroy()
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const baseURL = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  await ctx.plugin(LlmRuntime)
  return { ctx, requests, baseURL }
}

const parameters = { query: 'captured query', apiVersion: '2023-06-01', maxUses: 2 }

it.each([false, true])('dispatches registered Sonar search through its native route with Session=%s', async (withSession) => {
  const f = await fixture(true)
  await f.ctx.plugin(WebRuntime)
  await f.ctx.plugin(SessionStore)
  const session = withSession ? f.ctx.sessions.create(SessionId('registered-sonar-owner')) : undefined
  if (session !== undefined) f.ctx.provide('agents', { currentInitiator: () => ({ session }) })
  const profiles = resolveProfiles({ native: {
    api: 'openai-completions', baseURL: f.baseURL, models: [{ id: 'sonar' }],
  } })
  f.ctx.llm.registerAdapter(['native'], new PiAiAdapter({
    profiles: () => profiles, resolveApiKey: async () => ({ value: 'owned-route-key', source: 'file' }), auth: memoryAuth(),
  }))
  await f.ctx.plugin(Perplexity, { provider: 'native', model: 'sonar', maxTokens: 12,
    ...withSession ? { searchRecency: 'week' } : {},
  })
  expect((await f.ctx.web.search({ query: 'registered sonar query' })).sources).toHaveLength(1)
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]?.path).toBe('/chat/completions')
  if (session !== undefined) {
    expect(session.snapshotEvents().filter(event => event.type === 'web/perplexity-search-llm-request')).toHaveLength(1)
  }
})

it('keeps a default governed Sonar route denied when its required user policy is absent', async () => {
  const f = await fixture(true)
  await f.ctx.plugin(WebRuntime)
  const profiles = resolveProfiles({ perplexity: {
    api: 'openai-completions', baseURL: f.baseURL, models: [{ id: 'sonar' }],
  } })
  const resolveApiKey = vi.fn(async () => 'owned-route-key')
  f.ctx.llm.registerAdapter(['perplexity'], new PiAiAdapter({ profiles: () => profiles, resolveApiKey, auth: memoryAuth() }))
  f.ctx.provide('modelAccessRequired', true)
  await f.ctx.plugin(Perplexity, { model: 'sonar' })
  await expect(f.ctx.web.search({ query: 'user policy required' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  expect(resolveApiKey).not.toHaveBeenCalled()
  expect(f.requests).toEqual([])
})

it('retains the configured Messages endpoint, model, headers and credential reference across profile replacement', async () => {
  const f = await fixture()
  let profiles = resolveProfiles({ native: { api: 'anthropic-messages', baseURL: `${f.baseURL}/first/v1`, apiKeyEnv: 'FIRST_KEY',
    models: [{ id: 'm', maxTokens: 64 }], headers: { 'x-owned-profile': 'first' } } })
  let key = 'old-value'
  const resolveApiKey = vi.fn(async (_provider: string, profile: ResolvedPiAiProviderProfile) => {
    expect(profile.apiKeyEnv).toBe('FIRST_KEY')
    return { value: key, source: 'file' }
  })
  f.ctx.llm.registerAdapter(['native'], new PiAiAdapter({ profiles: () => profiles, resolveApiKey, auth: memoryAuth() }))
  const observed: StreamChunk[] = []
  f.ctx.on('llm/stream', async function* (_options, next) {
    for await (const chunk of next()) { observed.push(chunk); yield chunk }
  })
  const call = await f.ctx.llm.prepareOperation({ provider: 'native', model: 'm', maxTokens: 12 }, 'deepseek-web-search', parameters)
  expect(resolveApiKey).not.toHaveBeenCalled()
  expect(f.requests).toHaveLength(0)
  profiles = resolveProfiles({ native: { api: 'anthropic-messages', baseURL: `${f.baseURL}/second`, apiKeyEnv: 'SECOND_KEY',
    models: [{ id: 'm', maxTokens: 128 }], headers: { 'x-owned-profile': 'second' } } })
  key = 'fresh-value'
  expect((await call.run(call.config)).sources).toHaveLength(1)
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]).toMatchObject({
    path: '/first/v1/messages', headers: { ...attributionHeaders(), 'x-api-key': 'fresh-value', 'x-owned-profile': 'first' },
    body: call.request.body,
  })
  expect(call.request.body.max_tokens).toBe(12)
  expect(resolveApiKey).toHaveBeenCalledOnce()
  expect(observed).toContainEqual({ type: 'usage', usage: { inputTokens: 3, outputTokens: 2 }, credentialSource: 'file' })
})

it.each([undefined, 'literal-key'])('uses explicit custom Messages route authentication without inventing a credential source: %s', async (credential) => {
  const f = await fixture()
  const profiles = resolveProfiles({ native: { api: 'anthropic-messages', baseURL: f.baseURL, defaultMaxTokens: 24, models: [{ id: 'm' }] } })
  f.ctx.llm.registerAdapter(['native'], new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => credential, auth: memoryAuth() }))
  const call = await f.ctx.llm.prepareOperation({ provider: 'native', model: 'm' }, 'deepseek-web-search', parameters)
  expect(call.request.body.max_tokens).toBe(24)
  expect((await call.run(call.config)).sources).toHaveLength(1)
  expect(f.requests[0]?.path).toBe('/v1/messages')
  expect(f.requests[0]?.headers['x-api-key']).toBe(credential)
})

it('refuses native operations on another protocol before credentials or HTTP', async () => {
  const f = await fixture()
  const profiles = resolveProfiles({ native: { api: 'openai-completions', baseURL: f.baseURL, models: [{ id: 'm' }] } })
  const resolveApiKey = vi.fn(async () => 'unused')
  f.ctx.llm.registerAdapter(['native'], new PiAiAdapter({ profiles: () => profiles, resolveApiKey, auth: memoryAuth() }))
  await expect(f.ctx.llm.prepareOperation({ provider: 'native', model: 'm' }, 'deepseek-web-search', parameters))
    .rejects.toMatchObject({ code: 'MODEL_OPERATION_UNSUPPORTED' })
  expect(resolveApiKey).not.toHaveBeenCalled()
  expect(f.requests).toHaveLength(0)
})

it('refuses provider-native login without projecting it into an API-key request', async () => {
  const f = await fixture()
  const profiles = resolveProfiles({ anthropic: { baseURL: f.baseURL } })
  const resolveApiKey = vi.fn(async () => undefined)
  const model = profiles.get('anthropic')!.piProvider!.getModels()[0]!
  f.ctx.llm.registerAdapter(['anthropic'], new PiAiAdapter({ profiles: () => profiles, resolveApiKey, auth: memoryAuth() }))
  await expect(f.ctx.llm.prepareOperation({ provider: 'anthropic', model: model.id }, 'deepseek-web-search', parameters))
    .rejects.toMatchObject({ code: 'MODEL_OPERATION_AUTH_UNSUPPORTED' })
  expect(resolveApiKey).not.toHaveBeenCalled()
  expect(f.requests).toHaveLength(0)
})

const sonarParameters = { query: 'captured sonar query', maxResponseBytes: 4096, searchRecency: 'week' as const }

it('retains the chat-completions generation while resolving fresh credentials for native Sonar search', async () => {
  const f = await fixture(true)
  let profiles = resolveProfiles({ native: { api: 'openai-completions', baseURL: `${f.baseURL}/first/v1`, apiKeyEnv: 'FIRST_KEY',
    models: [{ id: 'sonar', maxTokens: 64 }], headers: { 'x-owned-profile': 'first' } } })
  let key = 'old-value'
  const resolveApiKey = vi.fn(async (_provider: string, profile: ResolvedPiAiProviderProfile) => {
    expect(profile.apiKeyEnv).toBe('FIRST_KEY')
    return { value: key, source: 'project-env' }
  })
  f.ctx.llm.registerAdapter(['native'], new PiAiAdapter({ profiles: () => profiles, resolveApiKey, auth: memoryAuth() }))
  const observed: StreamChunk[] = []
  f.ctx.on('llm/stream', async function* (_options, next) {
    for await (const chunk of next()) { observed.push(chunk); yield chunk }
  })
  const call = await f.ctx.llm.prepareOperation({ provider: 'native', model: 'sonar', maxTokens: 12 }, 'perplexity-web-search', sonarParameters)
  expect(resolveApiKey).not.toHaveBeenCalled()
  profiles = resolveProfiles({ native: { api: 'openai-completions', baseURL: `${f.baseURL}/second`, apiKeyEnv: 'SECOND_KEY',
    models: [{ id: 'sonar', maxTokens: 128 }], headers: { 'x-owned-profile': 'second' } } })
  key = 'fresh-value'
  expect((await call.run(call.config)).sources).toHaveLength(1)
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]).toMatchObject({ path: '/first/v1/chat/completions',
    headers: { ...attributionHeaders(), authorization: 'Bearer fresh-value', 'x-owned-profile': 'first' }, body: call.request.body })
  expect(call.request.body).toMatchObject({ max_tokens: 12, search_recency_filter: 'week',
    messages: [{ role: 'user', content: 'captured sonar query' }] })
  expect(resolveApiKey).toHaveBeenCalledOnce()
  expect(observed).toContainEqual({ type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, credentialSource: 'project-env' })
})

it.each([undefined, 'literal-key'])('uses a configured chat-completions route without inventing a credential source: %s', async (credential) => {
  const f = await fixture(true)
  const profiles = resolveProfiles({ native: { api: 'openai-completions', baseURL: f.baseURL, defaultMaxTokens: 24, models: [{ id: 'sonar' }] } })
  f.ctx.llm.registerAdapter(['native'], new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => credential, auth: memoryAuth() }))
  const call = await f.ctx.llm.prepareOperation({ provider: 'native', model: 'sonar' }, 'perplexity-web-search', {
    query: 'q', maxResponseBytes: 4096,
  })
  expect(call.request.body.max_tokens).toBe(24)
  await call.run(call.config)
  expect(f.requests[0]?.path).toBe('/chat/completions')
  expect(f.requests[0]?.headers['authorization']).toBe(credential === undefined ? undefined : `Bearer ${credential}`)
})

it('refuses a Sonar operation on a Messages route before authentication or HTTP', async () => {
  const f = await fixture(true)
  const profiles = resolveProfiles({ native: { api: 'anthropic-messages', baseURL: f.baseURL, models: [{ id: 'm' }] } })
  const resolveApiKey = vi.fn(async () => 'unused')
  f.ctx.llm.registerAdapter(['native'], new PiAiAdapter({ profiles: () => profiles, resolveApiKey, auth: memoryAuth() }))
  await expect(f.ctx.llm.prepareOperation({ provider: 'native', model: 'm' }, 'perplexity-web-search', sonarParameters))
    .rejects.toMatchObject({ code: 'MODEL_OPERATION_UNSUPPORTED' })
  expect(resolveApiKey).not.toHaveBeenCalled()
  expect(f.requests).toHaveLength(0)
})

it('refuses a Sonar operation on a Responses route before authentication or HTTP', async () => {
  const f = await fixture(true)
  const profiles = resolveProfiles({ native: { api: 'openai-responses', baseURL: f.baseURL, models: [{ id: 'm' }] } })
  const resolveApiKey = vi.fn(async () => 'unused')
  f.ctx.llm.registerAdapter(['native'], new PiAiAdapter({ profiles: () => profiles, resolveApiKey, auth: memoryAuth() }))
  await expect(f.ctx.llm.prepareOperation({ provider: 'native', model: 'm' }, 'perplexity-web-search', sonarParameters))
    .rejects.toMatchObject({ code: 'MODEL_OPERATION_UNSUPPORTED' })
  expect(resolveApiKey).not.toHaveBeenCalled()
  expect(f.requests).toHaveLength(0)
})

it('refuses projecting catalog-native login onto a Sonar API-key request', async () => {
  const f = await fixture(true)
  const profiles = resolveProfiles({ groq: { baseURL: f.baseURL } })
  const model = profiles.get('groq')?.piProvider?.getModels().find(model => model.api === 'openai-completions')
  if (model === undefined) throw new Error('The installed Groq catalog has no chat-completions model.')
  const resolveApiKey = vi.fn(async () => undefined)
  f.ctx.llm.registerAdapter(['groq'], new PiAiAdapter({ profiles: () => profiles, resolveApiKey, auth: memoryAuth() }))
  await expect(f.ctx.llm.prepareOperation({ provider: 'groq', model: model.id }, 'perplexity-web-search', sonarParameters))
    .rejects.toMatchObject({ code: 'MODEL_OPERATION_AUTH_UNSUPPORTED' })
  expect(resolveApiKey).not.toHaveBeenCalled()
  expect(f.requests).toHaveLength(0)
})
