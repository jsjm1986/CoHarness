/** Bounded admission messages shared by remote resource providers and their coordinator. @module */
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ResourceOperationId } from './types.ts'

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const delay = positive.max(2_147_483_647)
const operationId = z.uuid().transform(value => value.toLowerCase() as ResourceOperationId)
const sessionId = z.string().min(1).max(512).transform(value => value as Branded<'SessionId'>)

/** Maximum encoded request/response bytes on the resource protocol. */
export const RESOURCE_MESSAGE_MAX_BYTES = 64 * 1024
/** Maximum exact operation references in one status poll. */
export const RESOURCE_POLL_MAX_OPERATIONS = 512

/** Durable deployment limits, read under the coordinator's node lock. */
export const resourcePolicySchema = z.object({
  sampleMs: delay, staleMs: delay, cpuTarget: z.number().positive().max(1),
  eventLoopTargetMs: positive, linuxMemoryReserveRatio: z.number().positive().max(1),
  maxQueued: positive, maxQueuedPerUser: positive, maxQueuedPerProject: positive,
  maxQueuedBytes: positive, maxWaitMs: delay,
}).strict().refine(value => value.staleMs > value.sampleMs
  && value.maxQueuedPerUser <= value.maxQueued && value.maxQueuedPerProject <= value.maxQueued,
'resource freshness and per-owner queues must fit the node policy')

/** An operation identity remains stable across registration retries and completion reports. */
export const resourceOperationSchema = z.object({ sequence: positive, requestId: operationId }).strict()

/** Origin references contain no caller-selected actor or project identifiers. */
export const resourceOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId,
    scopeId: z.uuid().transform(value => value.toLowerCase() as Branded<'ExecutionScopeId'>).optional() }).strict(),
  z.object({ kind: z.literal('principal'), assertion: z.string().min(1).max(16 * 1024) }).strict(),
  z.object({ kind: z.literal('runtime') }).strict(),
])

/** One bounded, serial registration before dispatching a model request or process. */
export const resourceRequestSchema = resourceOperationSchema.extend({
  kind: z.enum(['model', 'process']), origin: resourceOriginSchema,
}).strict()

/** Polling returns accounting state; an active permit does not grant execution authority. */
export const resourceStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.enum(['queued', 'active', 'uncertain', 'closed']) }).strict(),
  z.object({ state: z.literal('refused'), reason: z.enum([
    'queue-full', 'user-queue-full', 'project-queue-full', 'queue-bytes', 'nested-capacity', 'authority-unavailable',
  ]) }).strict(),
])

/** Batch size is a protocol limit independent of deployment queue capacity. */
export const resourceStatusesSchema = z.object({ operations: z.array(resourceOperationSchema).max(RESOURCE_POLL_MAX_OPERATIONS) }).strict()

/** Error recovery uses a bounded code while discarding diagnostic fields. */
export const resourceErrorSchema = z.object({ error: z.string().min(1).max(128) })

/** Only exact-owner completion reports may retire a reservation. */
export const resourceFinishSchema = resourceOperationSchema.extend({
  outcome: z.enum(['quiescent', 'not-started', 'uncertain']),
}).strict()

/** Registration returns the committed policy and next sequence without resetting active work. */
export const resourceRegistrationSchema = z.object({ nextSequence: positive, policy: resourcePolicySchema }).strict()

/** Captured resource origin, distinct from execution permission. */
export type ResourceOrigin = z.infer<typeof resourceOriginSchema>
/** One remote resource request after wire validation. */
export type ResourceWireRequest = z.infer<typeof resourceRequestSchema>
/** Committed remote admission policy, including queue and observation bounds. */
export type ResourcePolicy = z.infer<typeof resourcePolicySchema>
/** Accounting state of one exact operation; execution authorization is separate. */
export type ResourceStatus = z.infer<typeof resourceStatusSchema>
