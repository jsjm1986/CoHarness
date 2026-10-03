/**
 * tasks domain zod schemas: the branded job id, the wire view carried by
 * `session/jobs` frames, and the `jobs.*` method payloads.
 */

import { z } from 'zod'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { JobView } from './jobs.ts'
import type { Wire } from './rpc.schema.ts'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import { sessionIdSchema } from './sessions.schema.ts'

/** JobId: one brand cast after non-empty string validation. */
export const taskIdSchema = z.string().min(1) as unknown as z.ZodType<JobId>

/** The ring's absolute coordinates and spill-file list. */
export const jobOutputCoordsSchema = z.object({
  total: z.number().int().nonnegative(),
  earliest: z.number().int().nonnegative(),
  spillPaths: z.array(z.string()).optional(),
})

/**
 * One wire task view. `kind` stays an open string because producer plugins
 * extend the registry's kind map by declaration merging, so the closed set is
 * not knowable at this boundary.
 */
export const taskViewSchema = z.object({
  id: taskIdSchema,
  kind: z.string().min(1),
  label: z.string().min(1),
  status: z.union([
    z.literal('running'),
    z.literal('stopping'),
    z.literal('completed'),
    z.literal('killed'),
    z.literal('failed'),
  ]),
  progress: z.string().optional(),
  detail: z.string().optional(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
  output: jobOutputCoordsSchema,
}) satisfies z.ZodType<Wire<JobView>>

/** One output chunk of a `jobs.output` read: absolute offset, text, channel, loss marker. */
const jobOutputChunkSchema = z.object({
  at: z.number().int().nonnegative(),
  text: z.string(),
  channel: z.union([z.literal('stdout'), z.literal('stderr'), z.literal('log')]).optional(),
  gapBefore: z.literal(true).optional(),
})

/** jobs.output request payload: the fenced job, the fence session, and the resume offset. */
export const jobsOutputRequestSchema = z.object({
  sessionId: sessionIdSchema.optional(),
  jobId: taskIdSchema,
  from: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'jobs.output'>>>

/** jobs.output response value: the fenced read plus the job's fresh projection. */
export const jobsOutputValueSchema = z.object({
  job: taskViewSchema,
  output: jobOutputCoordsSchema,
  chunks: z.array(jobOutputChunkSchema),
  next: z.number().int().nonnegative(),
  lossy: z.literal(true).optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'jobs.output'>>>

/** jobs.kill request payload: the session whose list carries the job, and the job id. */
export const jobsKillRequestSchema = z.object({
  sessionId: sessionIdSchema,
  jobId: taskIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'jobs.kill'>>>

/** jobs.kill response value: the registry's admission. */
export const jobsKillValueSchema = z.object({
  outcome: z.union([z.literal('requested'), z.literal('already-finished')]),
}) satisfies z.ZodType<Wire<ResponseValue<'jobs.kill'>>>
