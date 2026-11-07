/** Administrator archive record IDs are decoded independently of Host Session strings. @module */
import { expect, it } from 'vitest'
import { parseConversationArchiveId } from '../src/archive-identity.ts'

it('canonicalizes a UUID archive identity', () => {
  expect(parseConversationArchiveId('A2000000-0000-4000-8000-000000000022')).toBe('a2000000-0000-4000-8000-000000000022')
})
it.each([undefined, null, 12, {}, [], '', 'same-host-root', 'not-a-uuid', 'a2000000000040008000000000000022'])('refuses a non-UUID archive identity: %j', input => {
  expect(parseConversationArchiveId(input)).toBeUndefined()
})
