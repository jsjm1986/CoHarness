import { afterEach, expect, it, vi } from 'vitest'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { DeepSeekSearchProvider } from '../src/provider.ts'

afterEach(() => { vi.unstubAllGlobals() })

const options = { baseURL: 'https://prepared.test/v1/', model: 'first-model', apiVersion: '2023-06-01', maxTokens: 64, maxUses: 2 }
const result = { content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://result.test' }] }] }

it('freezes exact input while deferring credentials and HTTP and retaining fresh credential values', async () => {
  let key = 'initial-key'
  const resolveApiKey = vi.fn(async () => key)
  const mutable = { ...options, resolveApiKey }
  const provider = new DeepSeekSearchProvider(() => mutable)
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(result)))
  vi.stubGlobal('fetch', fetch)
  const input = { query: 'original query' }
  const prepared = provider.prepare(input)
  expect(Object.isFrozen(prepared.request.body.messages[0].content)).toBe(true)
  expect(resolveApiKey).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  mutable.model = 'changed-model'
  mutable.baseURL = 'https://changed.test'
  input.query = 'changed query'
  key = 'fresh-key'
  await prepared.run()
  expect(fetch.mock.calls[0]?.[0]).toBe('https://prepared.test/v1/messages')
  const sent = fetch.mock.calls[0]?.[1]
  expect(sent?.headers).toMatchObject({ ...attributionHeaders(), 'x-api-key': 'fresh-key' })
  expect(sent?.body).toBe(JSON.stringify(prepared.request.body))
  expect(prepared.request.body.model).toBe('first-model')
  expect(prepared.request.body.messages[0].content[0].text).toContain('original query')
})

it('uses only the owning adapter headers without account or API-key fallbacks', async () => {
  const resolveHeaders = vi.fn(async () => ({ authorization: 'Bearer owned-token' }))
  const resolveApiKey = vi.fn(async () => 'wrong-key')
  const resolveAccountToken = vi.fn(async () => 'wrong-account')
  const provider = new DeepSeekSearchProvider(() => ({ ...options, resolveHeaders, resolveApiKey, resolveAccountToken }))
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(result)))
  vi.stubGlobal('fetch', fetch)
  expect(provider.available()).toBe(true)
  await provider.prepare({ query: 'q' }).run()
  expect(resolveHeaders).toHaveBeenCalledOnce()
  expect(resolveApiKey).not.toHaveBeenCalled()
  expect(resolveAccountToken).not.toHaveBeenCalled()
  expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer owned-token' })
  expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('x-api-key')
})

it('reports actual response usage before a later result-mapping failure', async () => {
  const provider = new DeepSeekSearchProvider(() => ({ ...options, apiKey: 'owned-key' }))
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ content: [], usage: { input_tokens: 3, output_tokens: 2 } })))
  const usage = vi.fn()
  await expect(provider.prepare({ query: 'q' }).run(undefined, usage)).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  expect(usage).toHaveBeenCalledWith({ inputTokens: 3, outputTokens: 2 })
})

it('retains base URL query fields while applying request-owned authentication only at execution', async () => {
  const resolveApiKey = vi.fn(async () => 'unused-key')
  const provider = new DeepSeekSearchProvider(() => ({ ...options, baseURL: 'https://prepared.test/v1/?tenant=owned', resolveApiKey }))
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(result)))
  vi.stubGlobal('fetch', fetch)
  const prepared = provider.prepare({ query: 'q' })
  const resolveHeaders = vi.fn(async () => ({ 'x-owned-auth': 'owned-key' }))
  expect(prepared.request.endpoint).toBe('https://prepared.test/v1/messages?tenant=owned')
  expect(resolveHeaders).not.toHaveBeenCalled()
  await prepared.run(undefined, undefined, resolveHeaders)
  expect(resolveHeaders).toHaveBeenCalledOnce()
  expect(resolveApiKey).not.toHaveBeenCalled()
  expect(fetch.mock.calls[0]?.[0]).toBe(prepared.request.endpoint)
  expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-owned-auth': 'owned-key' })
})
