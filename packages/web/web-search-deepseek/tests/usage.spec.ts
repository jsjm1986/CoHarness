import { expect, it } from 'vitest'
import { nativeSearchUsage } from '../src/usage.ts'

it('retains absent usage and optional cache fields without inventing zero counts', () => {
  expect(nativeSearchUsage(undefined)).toBeUndefined()
  expect(nativeSearchUsage({ input_tokens: 0, output_tokens: 2 })).toEqual({ inputTokens: 0, outputTokens: 2 })
  expect(nativeSearchUsage({ input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 7, cache_creation_input_tokens: 5 }))
    .toEqual({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 5 })
})

it.each([null, [], false, 1, 'invalid', {},
  { input_tokens: -1, output_tokens: 2 },
  { input_tokens: 1.5, output_tokens: 2 },
  { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 2 },
  { input_tokens: '3', output_tokens: 2 },
  { input_tokens: 3, output_tokens: null },
  { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: -1 },
  { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 1.5 },
])('refuses invalid provider token usage %j', (value) => {
  expect(() => nativeSearchUsage(value)).toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
})
