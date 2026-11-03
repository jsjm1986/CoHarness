/** Remote permit identities and deployment policies are validated before admission. @module */
import { expect, it } from 'vitest'
import {
  resourceFinishSchema, resourceOperationSchema, resourceOriginSchema, resourcePolicySchema,
  resourceRegistrationSchema, resourceRequestSchema, resourceStatusesSchema, resourceStatusSchema, resourceErrorSchema,
} from '../src/wire.ts'

const requestId = 'A9B3FCB6-5C32-4385-8ADC-57892705B91A'
const policy = {
  sampleMs: 500, staleMs: 2000, cpuTarget: 0.85, eventLoopTargetMs: 100, linuxMemoryReserveRatio: 0.1,
  maxQueued: 16, maxQueuedPerUser: 8, maxQueuedPerProject: 8, maxQueuedBytes: 65536, maxWaitMs: 30000,
}

it('canonicalizes opaque operation and scope UUIDs without admitting caller-selected ownership', () => {
  const ref = resourceOperationSchema.parse({ sequence: 1, requestId })
  expect(ref.requestId).toBe(requestId.toLowerCase())
  expect(resourceRequestSchema.parse({ ...ref, kind: 'process', origin: { kind: 'session', sessionId: 's', scopeId: requestId } }))
    .toEqual({ ...ref, kind: 'process', origin: { kind: 'session', sessionId: 's', scopeId: requestId.toLowerCase() } })
  for (const origin of [{ kind: 'runtime', actorId: 7 }, { kind: 'principal', assertion: '' },
    { kind: 'session', sessionId: 's', scopeId: 'not-a-uuid' }]) {
    expect(resourceOriginSchema.safeParse(origin).success).toBe(false)
  }
  expect(resourceRequestSchema.safeParse({ ...ref, kind: 'model', actorId: 7, origin: { kind: 'runtime' } }).success).toBe(false)
  expect(resourceOperationSchema.safeParse({ sequence: Number.MAX_SAFE_INTEGER + 1, requestId }).success).toBe(false)
})

it('rejects stale observations, overflowing timers and owner queues larger than the committed node policy', () => {
  expect(resourceRegistrationSchema.parse({ nextSequence: 1, policy })).toEqual({ nextSequence: 1, policy })
  for (const change of [{ staleMs: 500 }, { maxQueuedPerUser: 17 }, { maxQueuedPerProject: 17 },
    { sampleMs: 2_147_483_648 }, { maxWaitMs: 2_147_483_648 }, { cpuTarget: 1.01 }, { linuxMemoryReserveRatio: 0 }]) {
    expect(resourcePolicySchema.safeParse({ ...policy, ...change }).success).toBe(false)
  }
})

it('bounds polls and keeps accounting outcomes distinct from execution authority', () => {
  const ref = { sequence: 1, requestId }
  expect(resourceStatusesSchema.safeParse({ operations: Array.from({ length: 512 }, () => ref) }).success).toBe(true)
  expect(resourceStatusesSchema.safeParse({ operations: Array.from({ length: 513 }, () => ref) }).success).toBe(false)
  expect(resourceFinishSchema.parse({ ...ref, outcome: 'uncertain' })).toEqual({ ...ref, requestId: requestId.toLowerCase(), outcome: 'uncertain' })
  expect(resourceFinishSchema.safeParse({ ...ref, outcome: 'timeout' }).success).toBe(false)
  expect(resourceStatusSchema.parse({ state: 'active' })).toEqual({ state: 'active' })
  expect(resourceStatusSchema.safeParse({ state: 'active', canExecute: true }).success).toBe(false)
  expect(resourceErrorSchema.parse({ error: 'resource-request-conflict', message: 'private diagnostic' }))
    .toEqual({ error: 'resource-request-conflict' })
  expect(resourceErrorSchema.safeParse({ error: 'x'.repeat(129) }).success).toBe(false)
})
