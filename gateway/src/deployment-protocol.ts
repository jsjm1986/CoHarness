/** Public deployment metadata; no secrets, process control or database dependencies. @module */
import { z } from 'zod'
import type { RuntimeNodeId } from './runtime-catalog.ts'

const uuid = z.uuid().transform(value => value as RuntimeNodeId)
/** Entry-owned deployment facts; this response must never be forwarded to a selected Runtime. */
export const deploymentContextSchema = z.object({
  mode: z.enum(['single', 'multi']), revision: z.string().regex(/^(0|[1-9][0-9]*)$/u),
  entry: z.object({ nodeId: uuid, name: z.string() }).strict(),
  primary: z.object({ nodeId: uuid, name: z.string(), origin: z.string() }).strict().nullable(),
  scope: z.enum(['local', 'organization']),
  role: z.enum(['standalone', 'primary', 'computer']),
  refreshAfterMs: z.number().int().positive().max(2_147_483_647),
  legacyMigrationRequired: z.boolean(),
}).strict()
/** Read-only browser presentation and request placement policy. */
export type DeploymentContext = z.infer<typeof deploymentContextSchema>
/** One retained computer whose attachment prevents disabling aggregation. */
export const deploymentBlockerSchema = z.object({ nodeId: uuid, name: z.string(),
  state: z.enum(['pending', 'managed']), activeRuntimes: z.number().int().nonnegative().safe() }).strict()
export type DeploymentBlocker = z.infer<typeof deploymentBlockerSchema>
/** Bounded preflight information, with an exact total independent of the first page. */
export const deploymentPreflightSchema = z.object({ canDisable: z.boolean(), blockingCount: z.number().int().nonnegative().safe(),
  computers: z.array(deploymentBlockerSchema) }).strict().refine(value => value.canDisable === (value.blockingCount === 0))
export type DeploymentPreflight = z.infer<typeof deploymentPreflightSchema>

/** Bounded, same-organization computers that already have a Gateway but no agent registration. */
export const deploymentCandidatesSchema = z.object({
  items: z.array(z.object({ nodeId: uuid, name: z.string() }).strict()), nextCursor: uuid.nullable(),
}).strict()
/** Existing identities available to the enrollment wizard. */
export type DeploymentCandidates = z.infer<typeof deploymentCandidatesSchema>


/** Credential-free setup status shown to the current computer's administrator. */
export const nodeConnectionViewSchema = z.object({ nodeId: uuid, revision: z.number().int().nonnegative().safe(),
  configured: z.boolean(), centerUrl: z.string().nullable(), localGatewayUrl: z.string(), enrollmentPending: z.boolean(),
  originReady: z.boolean(), service: z.string(), connectionState: z.enum(['independent', 'pending', 'connected', 'disconnected', 'revoked']) }).strict()
export type NodeConnectionView = z.infer<typeof nodeConnectionViewSchema>
