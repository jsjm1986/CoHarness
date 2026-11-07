/** An unverified renewal interval owns no private scope; keys need a visible Session and exact Runtime. */
import { expect, it } from 'vitest'
import type { ISessions } from '../src/client/contract/sessions.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionPersistenceKey } from '../src/client/session-persistence.ts'

it('drops the account Runtime key while Host metadata reconnects, and after account revocation', () => {
  const id = 'conversation' as SessionId
  const sessions = {
    list: { getSnapshot: () => ({ byId: { [id]: {} } }) },
    runtimeIdentityFor: () => ({ kind: 'personal', runtimeId: '10000000-0000-4000-8000-000000000001' }),
  } as unknown as Pick<ISessions, 'list' | 'runtimeIdentityFor'>
  const confirmed = sessionPersistenceKey(sessions, id, true, 7)
  expect(confirmed).toBe(JSON.stringify(['account:7', ['runtime', '10000000-0000-4000-8000-000000000001'], id]))
  expect(sessionPersistenceKey(sessions, id, undefined, 7)).toBeUndefined()
  expect(sessionPersistenceKey(sessions, id, undefined, undefined)).toBeUndefined()
  expect(sessionPersistenceKey(sessions, id, true, undefined)).toBeUndefined()
  expect(sessionPersistenceKey(sessions, id, false, undefined)).toContain('local')
})
