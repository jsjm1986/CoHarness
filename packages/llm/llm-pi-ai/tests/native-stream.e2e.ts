/** Real Responses inference through the delegated operation and parent model admission. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type NativeModelStreamEvent, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

const key = process.env.OPENAI_API_KEY
const model = process.env.DSH_PI_AI_OPENAI_MODEL ?? 'gpt-4.1-nano'
const baseURL = process.env.DSH_PI_AI_OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'

it.skipIf(!key)('streams a real native Responses request with actual usage and one released model permit', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const profiles = resolveProfiles({ native: { api: 'openai-responses', baseURL, apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: model }] } })
  ctx.llm.registerAdapter(['native'], new PiAiAdapter({ profiles: () => profiles, auth: memoryAuth(),
    resolveApiKey: () => Promise.resolve({ value: key as string, source: 'env' }) }))
  const lease = { signal: new AbortController().signal, release: vi.fn(async () => {}), uncertain: vi.fn(async () => {}) }
  const acquire = vi.fn(async () => lease)
  ctx.provide('resourceBudget', { acquire })
  const observed: StreamChunk[] = []
  ctx.on('llm/delegated-stream', async function* (_options, next) {
    for await (const chunk of next()) { observed.push(chunk); yield chunk }
  })
  const events: NativeModelStreamEvent[] = []
  const call = await ctx.llm.prepareDelegatedOperation({ provider: 'native', model, maxTokens: 64 }, 'native-stream', {
    protocol: 'openai-responses', body: { model, stream: true, input: 'Reply with exactly pong.' }, maxResponseBytes: 1024 * 1024,
    write: (event) => { events.push(event); return Promise.resolve() },
  })
  await call.run({ ...call.config, signal: AbortSignal.timeout(60_000) })
  expect(events.at(-1)?.event).toBe('response.completed')
  const deltas = events.filter(event => event.event === 'response.output_text.delta').map((event) => {
    const value = JSON.parse(event.data) as { delta?: unknown }
    return typeof value.delta === 'string' ? value.delta : ''
  })
  expect(deltas.join('').toLowerCase()).toContain('pong')
  const usage = observed.filter(chunk => chunk.type === 'usage')
  expect(usage).toHaveLength(1)
  expect(usage[0]?.usage.outputTokens).toBeGreaterThan(0)
  expect(usage[0]?.usage.totalTokens).toBeGreaterThan(0)
  expect(usage[0]?.credentialSource).toBe('env')
  expect(acquire).toHaveBeenCalledOnce()
  expect(lease.release).toHaveBeenCalledOnce()
  expect(lease.uncertain).not.toHaveBeenCalled()
})
