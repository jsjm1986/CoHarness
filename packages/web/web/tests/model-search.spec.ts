import { expect, it, vi } from 'vitest'
import { modelSearchUsage, resolveModelSearchCredential } from '../src/model-search.ts'
import { WebError } from '../src/types.ts'

const fields = { inputTokens: 'prompt_tokens', outputTokens: 'completion_tokens', totalTokens: 'total_tokens', reasoningTokens: 'reasoning_tokens' }

it('retains actual counters, omits missing usage and rejects an inconsistent full-call total', () => {
  expect(modelSearchUsage(undefined, fields, 'Search')).toBeUndefined()
  expect(modelSearchUsage({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, reasoning_tokens: 1 }, fields, 'Search'))
    .toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5, reasoningTokens: 1 })
  expect(modelSearchUsage({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 6 }, fields, 'Search'))
    .toEqual({ inputTokens: 3, outputTokens: 2 })
})

it.each([null, [], {}, { prompt_tokens: '3', completion_tokens: 2 },
  { prompt_tokens: 3, completion_tokens: 2, reasoning_tokens: -1 },
  { prompt_tokens: 3, completion_tokens: 2, total_tokens: 1.5 },
])('refuses invalid wire usage without quoting response contents: %j', (usage) => {
  expect(() => modelSearchUsage(usage, fields, 'Search')).toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
})

it('never starts credentials for an already aborted caller', async () => {
  const controller = new AbortController()
  controller.abort('caller stopped')
  const resolve = vi.fn(async () => 'unused')
  await expect(resolveModelSearchCredential(resolve, controller.signal, 'Search')).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  expect(resolve).not.toHaveBeenCalled()
})

it('observes a late credential rejection after the resolver synchronously withdraws its caller', async () => {
  const controller = new AbortController(), late = Promise.withResolvers<string>()
  const pending = resolveModelSearchCredential(() => { controller.abort('withdrawn in resolver'); return late.promise }, controller.signal, 'Search')
  await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  late.reject(new Error('late credential error'))
  await Promise.resolve()
})

it('preserves credential-domain errors and classifies a resolver abort without an aborted signal', async () => {
  const missing = new WebError('Missing owned credential.', 'WEB_PROVIDER_CREDENTIAL_MISSING')
  await expect(resolveModelSearchCredential(async () => { throw missing }, undefined, 'Search')).rejects.toBe(missing)
  await expect(resolveModelSearchCredential(async () => { throw missing }, new AbortController().signal, 'Search')).rejects.toBe(missing)
  await expect(resolveModelSearchCredential(async () => { throw new DOMException('Resolver stopped.', 'AbortError') }, undefined, 'Search'))
    .rejects.toMatchObject({ code: 'WEB_ABORTED' })
})

it('normalizes a credential resolver rejection that is not an Error', async () => {
  const rejected = Promise.withResolvers<string>()
  const pending = resolveModelSearchCredential(() => rejected.promise, new AbortController().signal, 'Search')
  rejected.reject('external credential failure')
  await expect(pending).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', cause: { cause: 'external credential failure' } })
})
