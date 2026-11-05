/** Operator-visible identities and preconditions for moving an existing project to its assigned computer. */
import { z } from 'zod'
import type { RuntimeId } from './runtime-catalog.ts'

const runtime = z.uuid().transform(value => value as RuntimeId)
const snapshot = z.object({ id: z.uuid(), jobId: z.uuid(), sourceRevision: z.string().regex(/^(0|[1-9]\d*)$/u) }).strict()
export const nodeMigrationTargetSchema = z.object({ nodeId: z.uuid(), runtimeId: runtime }).strict()
export const nodeMigrationPublishSchema = nodeMigrationTargetSchema.extend({ generation: z.number().int().nonnegative(), snapshot }).strict()
const blocker = z.enum(['volume-unavailable', 'adapters-missing', 'names-incomplete', 'node-unavailable', 'runtime-busy',
  'progress-busy', 'prepare-required', 'source-changed', 'archive-files-unverified'])
export const nodeMigrationPreflightSchema = nodeMigrationTargetSchema.extend({
  projectId: z.number().int().positive(), generation: z.number().int().nonnegative(),
  storage: z.enum(['shared', 'node']), sourceRetirement: z.enum(['new', 'retiring', 'retired']).nullable(),
  snapshot: snapshot.nullable(), sourceRevision: z.string().regex(/^(0|[1-9]\d*)$/u).nullable(),
  blockers: z.array(blocker), missingAdapters: z.string().array(), canPrepare: z.boolean(), canPublish: z.boolean(),
}).strict()
export type NodeMigrationTarget = z.infer<typeof nodeMigrationTargetSchema>
export type NodeMigrationPublish = z.infer<typeof nodeMigrationPublishSchema>
export type NodeMigrationPreflight = z.infer<typeof nodeMigrationPreflightSchema>
export type NodeMigrationBlocker = z.infer<typeof blocker>
export const nodeMigrationChoicesSchema = z.object({
  items: z.array(z.object({ id: z.number().int().positive(), name: z.string().nullable() }).strict()),
  next: z.number().int().positive().nullable(),
}).strict()
export type NodeMigrationChoices = z.infer<typeof nodeMigrationChoicesSchema>

export const nodeRetirementOpenSchema=z.object({runtimeId:runtime,writerEpoch:z.string().regex(/^[1-9]\d*$/u),policyDigest:z.string().regex(/^[a-f0-9]{64}$/u)}).strict()
export const nodeRetirementFinalizeSchema=z.object({reviewId:z.uuid()}).strict()
const mediaDomain=z.enum(['policy','wal','backups','replicas','cluster-media','other-projections'])
/** Status fields rendered in the Admin migration panel. The operator CLI also receives the signed-challenge coordinates. */
export const nodeRetirementSummarySchema=z.object({
  projectId:z.number().int().positive(),nodeId:z.uuid(),runtimeId:runtime,writerEpoch:z.string().regex(/^[1-9]\d*$/u),
  sourceRetirement:z.enum(['new','retiring','retired']),knownOrigin:z.boolean(),originalClusterStillServing:z.boolean().nullable(),
  reviewId:z.uuid().nullable(),retainedRelations:z.array(z.string()),outstanding:z.array(mediaDomain),
})
export type NodeRetirementSummary=z.infer<typeof nodeRetirementSummarySchema>
