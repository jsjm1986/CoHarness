/**
 * skills domain zod schemas (names derived from map keys: skillListRequestSchema /
 * skillListValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { sessionIdSchema } from './sessions.schema.ts'
import type { SkillEntry, SkillPreview } from './skills.ts'

/** SkillEntry row of skill.list. */
export const skillEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  whenToUse: z.string().optional(),
  modelInvocable: z.boolean(),
}) satisfies z.ZodType<Wire<SkillEntry>>

/** skill.list request payload. */
export const skillListRequestSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'skill.list'>>>

/** skill.list response value. */
export const skillListValueSchema = z.object({
  skills: z.array(skillEntrySchema),
}) satisfies z.ZodType<Wire<ResponseValue<'skill.list'>>>

/** Current skill source exposed to the user; provider metadata is omitted. */
export const skillPreviewSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  contentMarkdown: z.string(),
}) satisfies z.ZodType<Wire<SkillPreview>>

/** skill.get request payload; the Host selects the session's visible registry. */
export const skillGetRequestSchema = z.object({
  sessionId: sessionIdSchema,
  name: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'skill.get'>>>

/** skill.get response; an unavailable name has no preview. */
export const skillGetValueSchema = z.object({
  skill: skillPreviewSchema.optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'skill.get'>>>
