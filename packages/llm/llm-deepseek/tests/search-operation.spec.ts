import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type GenerateOptions, type PreparedAdapterCall, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { DeepSeekRequestAuth } from '../src/types.ts'
import { adapter, MODEL } from './helpers.ts'
import { expect, it, onTestFinished, vi } from 'vitest'

const parameters = { query: 'native query', apiVersion: '2023-06-01', maxUses: 2 }
const options: GenerateOptions = { provider: 'deepseek-official', model: MODEL, messages: [] }
const response = { usage: { input_tokens: 3, output_tokens: 2 }, content: [
  { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://result.test' }] },
] }

function transport(resolveAuth: () => Promise<DeepSeekRequestAuth>, body: unknown = response) {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body)))
  onTestFinished(() => { fetch.mockRestore() })
  return { adapter: adapter({ baseURL: 'https://owned.test/anthropic' }, { resolveAuth }), fetch }
}

function operationOf(prepared: PreparedAdapterCall) {
  const factory = prepared.operations?.['deepseek-web-search']
  if (factory === undefined) throw new Error('The prepared adapter has no native search operation.')
  return factory(parameters, options)
}

it('resolves adapter defaults without HTTP or credentials and reports usage without an invented source', async () => {
  const resolveAuth = vi.fn(async () => ({ headers: { 'x-api-key': 'owned-key' } }))
  const f = transport(resolveAuth)
  const prepared = await f.adapter.prepareCall(options.provider, options.model)
  const operation = operationOf(prepared)
  expect(operation.request.body.max_tokens).toBe(prepared.model.defaultMaxTokens)
  expect(resolveAuth).not.toHaveBeenCalled()
  expect(f.fetch).not.toHaveBeenCalled()
  const usage = vi.fn()
  expect((await operation.run(options, { usage, dispatch: request => request() })).sources).toHaveLength(1)
  expect(usage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 3, outputTokens: 2 }, undefined)
  expect(f.fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-api-key': 'owned-key', 'x-deepseek-harness-user-id': 'test-user' })
})

it.each(['none', 'map', 'throw'] as const)('preserves observed usage and provider credential error handling: %s', async (handler) => {
  const original: unknown[] = []
  const onRequestError = vi.fn(async (error: unknown) => {
    original.push(error)
    if (handler === 'throw') throw new Error('Credential state update failed.')
    return new Error('Mapped native request failure.')
  })
  const f = transport(async () => ({ headers: { 'x-api-key': 'owned-key' }, credentialSource: 'organization',
    ...handler === 'none' ? {} : { onRequestError },
  }), { usage: response.usage, content: [] })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([options.provider], f.adapter)
  const observed: StreamChunk[] = []
  ctx.on('llm/stream', async function* (_options, next) {
    for await (const chunk of next()) { observed.push(chunk); yield chunk }
  })
  const call = await ctx.llm.prepareOperation(options, 'deepseek-web-search', parameters)
  await expect(call.run({ ...call.config, sessionId: SessionId('native-error-session') }))
    .rejects.toThrow(handler === 'map' ? 'Mapped native request failure.' : 'no web_search_tool_result')
  expect(observed).toContainEqual({ type: 'usage', usage: { inputTokens: 3, outputTokens: 2 }, credentialSource: 'organization' })
  expect(onRequestError).toHaveBeenCalledTimes(handler === 'none' ? 0 : 1)
  expect(original).toHaveLength(handler === 'none' ? 0 : 1)
  if (handler !== 'none') {
    expect(String(original[0])).toContain('configured model provider "deepseek-official"')
    expect(String(original[0])).not.toContain('web-search-deepseek.baseURL')
  }
})

it('refuses credentials before HTTP without invoking request-error handling', async () => {
  const failure = new Error('Credential lookup refused.')
  const f = transport(async () => { throw failure })
  const prepared = await f.adapter.prepareCall(options.provider, options.model)
  const operation = operationOf(prepared)
  await expect(operation.run(options, { usage: vi.fn(), dispatch: request => request() })).rejects.toThrow('Credential lookup refused.')
  expect(f.fetch).not.toHaveBeenCalled()
})

it('refuses native search after credentials wait across parent revocation', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const f = transport(async () => { entered.resolve(undefined); await release.promise; return { headers: { 'x-api-key': 'owned-key' } } })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([options.provider], f.adapter)
  let allowed = true
  ctx.provide('modelAccess', { decide: () => allowed ? { allowed: true as const } : { allowed: false as const, reason: 'revoked' } })
  const call = await ctx.llm.prepareOperation(options, 'deepseek-web-search', parameters)
  const run = call.run(call.config).then(() => 'dispatched', (error: unknown) => (error as { code: string }).code)
  await entered.promise
  allowed = false
  release.resolve(undefined)
  expect(await run).toBe('MODEL_FORBIDDEN')
  expect(f.fetch).not.toHaveBeenCalled()
})

it.each(['stream', 'prepared'] as const)('refuses an ordinary %s request after credentials wait across parent revocation', async (mode) => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const f = transport(async () => { entered.resolve(undefined); await release.promise; return { headers: { 'x-api-key': 'owned-key' } } })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([options.provider], f.adapter)
  let allowed = true
  ctx.provide('modelAccess', { decide: () => allowed ? { allowed: true as const } : { allowed: false as const, reason: 'revoked' } })
  const call = mode === 'prepared' ? await ctx.llm.prepareCall(options) : undefined
  const stream = call === undefined ? ctx.llm.stream(options) : call.stream({ ...options, ...call.config })
  const result = (async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks
  })()
  await entered.promise
  allowed = false
  release.resolve(undefined)
  const chunks = await result
  expect(f.fetch).not.toHaveBeenCalled()
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_FORBIDDEN' } } })
})
