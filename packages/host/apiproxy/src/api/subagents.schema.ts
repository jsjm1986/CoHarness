/** Zod schemas for the browser-safe subagent domain. */

import { z } from 'zod'
import type { RequestPayload } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { sessionIdSchema } from './sessions.schema.ts'

/** subagent.history request payload. */
export const subagentHistoryRequestSchema = z.object({
  parentSessionId: sessionIdSchema,
  childSessionId: sessionIdSchema,
  mode: z.union([z.literal('one-shot'), z.literal('continuable')]),
  beforeSeq: z.number().int().nonnegative().optional(),
  maxMessages: z.number().int().positive().optional(),
  detail: z.union([z.literal('conversation'), z.literal('full')]).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'subagent.history'>>>
