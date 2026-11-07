import { expect, it, onTestFinished, vi } from 'vitest'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { PerplexitySearchProvider } from '../src/provider.ts'

const answer = { choices: [{ message: { content: 'Owned answer.' } }], citations: ['https://result.test'],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }
const options = { apiKey: 'unused-private-key', baseURL: 'https://owned.test/v1/', model: 'sonar', maxTokens: 32, maxResponseBytes: 4096 }

function response(body: unknown = answer) {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body)))
  onTestFinished(() => { fetch.mockRestore() })
  return fetch
}

it('freezes the exact native request while deferring request-owned credentials and HTTP', async () => {
  const fetch = response()
  const mutable = { ...options, searchRecency: 'week' as const }
  const provider = new PerplexitySearchProvider(mutable)
  const input = { query: 'captured query' }
  const prepared = provider.prepare(input)
  expect(Object.isFrozen(prepared.request.body.messages)).toBe(true)
  expect(fetch).not.toHaveBeenCalled()
  mutable.model = 'changed'; mutable.baseURL = 'https://changed.test'; input.query = 'changed query'
  const resolveHeaders = vi.fn(async () => ({ authorization: 'Bearer owned-route-key' }))
  const usage = vi.fn()
  expect((await prepared.run(undefined, usage, resolveHeaders)).sources).toEqual([{ url: 'https://result.test' }])
  expect(resolveHeaders).toHaveBeenCalledExactlyOnceWith('https://owned.test/v1/chat/completions', undefined)
  expect(fetch.mock.calls[0]?.[0]).toBe(prepared.request.endpoint)
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: { ...attributionHeaders(), authorization: 'Bearer owned-route-key' },
    body: JSON.stringify(prepared.request.body) })
  expect(prepared.request.body).toMatchObject({ model: 'sonar', max_tokens: 32, messages: [{ role: 'user', content: 'captured query' }],
    search_recency_filter: 'week' })
  expect(usage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
})

it('reports actual usage even when later result mapping fails', async () => {
  response({ usage: answer.usage, search_results: [null] })
  const usage = vi.fn()
  await expect(new PerplexitySearchProvider(options).prepare({ query: 'q' }).run(undefined, usage)).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  expect(usage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
})

it('observes abandoned authentication while refusing HTTP after cancellation', async () => {
  const fetch = response(), controller = new AbortController(), late = Promise.withResolvers<Readonly<Record<string, string>>>()
  const pending = new PerplexitySearchProvider(options).prepare({ query: 'q' }).run(controller.signal, undefined, () => {
    controller.abort('owned caller cancelled'); return late.promise
  })
  await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  late.reject(new Error('Late credential failure.'))
  await Promise.resolve()
  expect(fetch).not.toHaveBeenCalled()
})

it('refuses a prepared request before credentials and HTTP when its caller is already cancelled', async () => {
  const fetch = response(), controller = new AbortController()
  controller.abort('caller already stopped')
  const headers = vi.fn(async () => ({ authorization: 'unused' }))
  await expect(new PerplexitySearchProvider(options).prepare({ query: 'q' }).run(controller.signal, undefined, headers))
    .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  expect(headers).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['request', 'success-body', 'error-body'])('classifies an owned cancellation with a custom reason during %s', async (phase) => {
  const controller = new AbortController(), reason = new Error('Owned resource permit withdrawn.')
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    if (phase === 'request') { controller.abort(reason); throw reason }
    return new Response(new ReadableStream({
      pull(stream) { controller.abort(reason); stream.error(reason) },
    }), { status: phase === 'error-body' ? 503 : 200 })
  })
  onTestFinished(() => { fetch.mockRestore() })
  await expect(new PerplexitySearchProvider(options).search({ query: 'q' }, controller.signal))
    .rejects.toMatchObject({ code: 'WEB_ABORTED', cause: reason })
})
