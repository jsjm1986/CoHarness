/** Multiple personal allocations must never share a browser Session identity. */
import { expect, it } from 'vitest'
import { clientSessionKey, parseClientSessionKey, runtimeTargetKey, type ClientRuntimeId } from '../src/api/client-session.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const a = '10000000-0000-4000-8000-000000000001' as ClientRuntimeId
const b = '10000000-0000-4000-8000-000000000002' as ClientRuntimeId

it('distinguishes equal Session ids in two personal Runtimes and ignores display metadata', () => {
  const original = 'session/same ?字' as SessionId
  const first = clientSessionKey({ kind: 'personal', runtimeId: a, nodeName: 'Computer A' }, original)
  const second = clientSessionKey({ kind: 'personal', runtimeId: b, nodeName: 'Computer B' }, original)
  expect(first).not.toBe(second)
  expect(parseClientSessionKey(first)).toEqual({ runtime: { kind: 'personal', runtimeId: a }, sessionId: original })
  expect(clientSessionKey({ kind: 'personal', runtimeId: a, nodeName: 'Renamed' }, original)).toBe(first)
  expect(runtimeTargetKey({ kind: 'personal', runtimeId: a })).not.toBe(runtimeTargetKey({ kind: 'personal', runtimeId: b }))
})

it('retains standalone legacy addresses and rejects malformed allocated identities', () => {
  const legacy = clientSessionKey({ kind: 'project', projectId: 7 }, 'same' as SessionId)
  expect(parseClientSessionKey(legacy)).toEqual({ runtime: { kind: 'project', projectId: 7 }, sessionId: 'same' })
  expect(parseClientSessionKey('dsh-session:v2:not-json' as SessionId)).toBeUndefined()
})
