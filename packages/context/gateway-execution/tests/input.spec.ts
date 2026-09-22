import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { executionInputOf, executionScope, executionState, hasUnverifiedExecutionInput, inputDigest } from '../src/input.ts'

const A = '00000000-0000-4000-8000-000000000001'
const state = () => ({
  revision: '1', inputs: [A], actors: [{ userId: 1 }], primaryActorUserId: 1, unverifiedHistory: false,
})
const scope = () => ({ parentSessionId: SessionId('parent'), inputs: [A], primaryActorUserId: 1, unverifiedHistory: false })

describe('untrusted execution references', () => {
  it('hashes JSON content and refuses values JSON cannot encode', () => {
    expect(inputDigest([{ type: 'text', text: 'hello' }])).toMatch(/^[0-9a-f]{64}$/)
    expect(() => inputDigest(undefined)).toThrow(/must be JSON/)
  })

  it('rejects malformed message input references', () => {
    const user = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    expect(executionInputOf(user)).toBeUndefined()
    const invalid = { ...user, source: { kind: 'user', gatewayExecutionInput: 'forged' } } as unknown as UserMessage
    expect(() => executionInputOf(invalid)).toThrow(/invalid Gateway execution input reference/)
  })

  it.each([
    null, [], 1,
    { ...state(), revision: '-1' },
    { ...state(), inputs: ['forged'] },
    { ...state(), actors: [{ userId: 0 }] },
    { ...state(), unverifiedHistory: 'false' },
    { ...state(), primaryActorUserId: -1 },
  ])('rejects an invalid Gateway state %#', (value) => {
    expect(() => executionState(value)).toThrow(/invalid Gateway execution state/)
  })

  it.each([
    { ...state(), inputs: [A, A] },
    { ...state(), actors: [{ userId: 1 }, { userId: 1 }] },
  ])('rejects duplicate participant identity %#', (value) => {
    expect(() => executionState(value)).toThrow(/duplicate Gateway execution identity/)
  })

  it.each([
    null, [], 1,
    { ...scope(), parentSessionId: '' },
    { ...scope(), inputs: ['forged'] },
    { ...scope(), unverifiedHistory: 'false' },
    { ...scope(), primaryActorUserId: -1 },
    { ...scope(), inputs: [] },
  ])('rejects an invalid delegated scope %#', (value) => {
    expect(() => executionScope(value)).toThrow(/invalid Gateway execution scope/)
  })

  it('retains an unknown relay restriction and accepts a verified human reference', () => {
    const unknown = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    expect(hasUnverifiedExecutionInput(unknown)).toBe(true)
    const verified = { ...unknown, source: { kind: 'user', gatewayExecutionInput: A } } as unknown as UserMessage
    expect(hasUnverifiedExecutionInput(verified)).toBe(false)
    const relayed = { ...unknown, source: {
      kind: 'agent-message', gatewayExecutionScope: {
        parentSessionId: SessionId('child'), inputs: [], unverifiedHistory: true,
      },
    } } as unknown as UserMessage
    expect(hasUnverifiedExecutionInput(relayed)).toBe(true)
  })
})
