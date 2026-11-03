import { deploymentContextSchema } from './deployment-protocol.ts'
/** Node enrollment and control leases; these messages never authorize runtime execution. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import type { RuntimeNodeId } from './runtime-catalog.ts'

/** Organization assigned by the center, never supplied as an enrollment selector. */
export type NodeOrganizationId = Branded<'NodeOrganizationId'>
/** Process-specific outbound connection identity. */
export type NodeConnectionId = Branded<'NodeConnectionId'>
/** Monotonic lease generation serialized as a decimal PostgreSQL bigint. */
export type NodeConnectionEpoch = Branded<'NodeConnectionEpoch'>
/** One-time enrollment capability, shown only when the administrator issues it. */
export type NodeEnrollmentToken = Branded<'NodeEnrollmentToken'>
/** Durable administrator issuance request identity. */
export type NodeEnrollmentId = Branded<'NodeEnrollmentId'>
/** Node-generated bearer capability; only its digest is stored by the center. */
export type NodeCredential = Branded<'NodeCredential'>

/** Control-plane deployment limits, independent of runtime/file transfer traffic. */
export interface NodeAccessConfig {
  enrollmentTtlMs: number
  leaseMs: number
  heartbeatMs: number
  maxInFlight: number
}

/** Stable wire refusals accepted by the node agent. */
export const NODE_ACCESS_ERROR_CODES = [
  'node-access/invalid-request', 'node-access/unauthorized', 'node-access/forbidden', 'node-access/not-found',
  'node-access/name-conflict', 'node-access/enrollment-already-issued', 'node-access/revision-conflict',
  'node-access/already-connected', 'node-access/lease-lost', 'node-access/unsupported-platform',
  'node-access/unsupported-protocol', 'node-access/response-too-large', 'node-access/busy', 'node-access/unavailable',
  'node-access/mode-disabled', 'node-access/computer-busy', 'node-access/detached',
] as const

/** Expected refusal without exposing credential material or database diagnostics. */
export class NodeAccessError extends Error {
  /**
   * @param status - HTTP refusal status.
   * @param code - stable reason for the receiving application.
   */
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 503,
    readonly code: typeof NODE_ACCESS_ERROR_CODES[number]) {
    super(code)
    this.name = 'NodeAccessError'
  }
}

/** Canonical UUIDs carried by node control messages. */
export const nodeUuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
/** Node credentials require 256 bits of canonical base64url token material. */
export const nodeCredentialSchema = z.string().regex(/^dsh_node_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u).transform(value => value as NodeCredential)
/** Enrollment tickets occupy a separate credential namespace. */
export const nodeEnrollmentTokenSchema = z.string().regex(/^dsh_enroll_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u).transform(value => value as NodeEnrollmentToken)
/** Center-assigned identity returned after a ticket is consumed. */
export const nodeIdentitySchema = z.object({
  protocolVersion: z.literal(1),
  organizationId: nodeUuidSchema.transform(value => value as NodeOrganizationId),
  nodeId: nodeUuidSchema.transform(value => value as RuntimeNodeId),
  executionReady: z.literal(false),
}).strict()
/** Parsed center identity; connectivity alone grants no execution access. */
export type NodeIdentity = z.infer<typeof nodeIdentitySchema>
/** A lease is usable only by its connection ID and exact epoch. */
export const nodeLeaseSchema = nodeIdentitySchema.extend({
  connectionId: nodeUuidSchema.transform(value => value as NodeConnectionId),
  epoch: z.string().regex(/^[1-9][0-9]{0,18}$/u).transform(value => value as NodeConnectionEpoch),
  expiresAt: z.iso.datetime(),
  heartbeatMs: z.number().int().positive().max(2_147_483_647),
}).strict()
/** Lease response consumed by the outbound node process. */
export type NodeLease = z.infer<typeof nodeLeaseSchema>

/** One-time ticket response; replaying issuance never returns its secret again. */
export interface NodeEnrollment {
  nodeId: RuntimeNodeId
  enrollmentId: NodeEnrollmentId
  revision: number
  token: NodeEnrollmentToken
  expiresAt: string
}

/** Cached center metadata; listing nodes never contacts a remote process. */
export interface NodeAccessEntry {
  nodeId: RuntimeNodeId
  name: string
  revision: number
  status: 'pending' | 'connected' | 'disconnected' | 'revoked' | 'detached'
  platform: 'darwin' | 'linux' | null
  architecture: 'x64' | 'arm64' | null
  lastSeenAt: string | null
  leaseExpiresAt: string | null
  executionReady: false
}

/** Keyset page bounded by the Gateway's directory row and complete-JSON byte limits. */
export interface NodeAccessPage {
  items: NodeAccessEntry[]
  nextCursor: RuntimeNodeId | null
}

const runtimeNodeIdSchema = nodeUuidSchema.transform(value => value as RuntimeNodeId)
const revisionSchema = z.number().int().positive().safe()

/** Center identity and whether its existing-service forwarding has been enabled. */
export const adminComputerContextSchema = z.object({
  nodeId: runtimeNodeIdSchema, name: z.string().min(1), forwardingEnabled: z.boolean(), deployment: deploymentContextSchema.optional(),
}).strict()
/** Cached bootstrap metadata for the Admin computer selector. */
export type AdminComputerContext = z.infer<typeof adminComputerContextSchema>

/** Browser-side validation of cached node metadata, independent of the credential exchange. */
export const nodeAccessEntrySchema: z.ZodType<NodeAccessEntry> = z.object({
  nodeId: runtimeNodeIdSchema, name: z.string().min(1).max(64), revision: revisionSchema,
  status: z.enum(['pending', 'connected', 'disconnected', 'revoked', 'detached']),
  platform: z.enum(['darwin', 'linux']).nullable(), architecture: z.enum(['x64', 'arm64']).nullable(),
  lastSeenAt: z.iso.datetime().nullable(), leaseExpiresAt: z.iso.datetime().nullable(), executionReady: z.literal(false),
}).strict()

/** Bounded directory response accepted by the Admin node section. */
export const nodeAccessPageSchema: z.ZodType<NodeAccessPage> = z.object({
  items: z.array(nodeAccessEntrySchema).max(200), nextCursor: runtimeNodeIdSchema.nullable(),
}).strict()

/** One-time issuance response; malformed success responses still have an uncertain mutation outcome. */
export const nodeEnrollmentSchema: z.ZodType<NodeEnrollment> = z.object({
  nodeId: runtimeNodeIdSchema, enrollmentId: nodeUuidSchema.transform(value => value as NodeEnrollmentId),
  revision: revisionSchema, token: nodeEnrollmentTokenSchema, expiresAt: z.iso.datetime(),
}).strict()

/** Confirmed credential revocation response, without credential material. */
export const nodeRevocationSchema = z.object({ nodeId: runtimeNodeIdSchema, revision: revisionSchema, status: z.literal('revoked') }).strict()

/** Confirmed exit from managed execution; the computer retains its independent local data. */
export const nodeDetachmentSchema = z.object({ nodeId: runtimeNodeIdSchema, revision: revisionSchema,
  status: z.literal('detached'), topologyRevision: z.string().regex(/^(0|[1-9][0-9]*)$/u) }).strict()
