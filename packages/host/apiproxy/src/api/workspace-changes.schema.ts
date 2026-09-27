/** Wire validation for historical workspace comparisons. */
import { z } from 'zod'
import { sessionIdSchema } from './sessions.schema.ts'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

const count = z.number().int().nonnegative()
const file = z.object({ path: z.string().min(1), display: z.string().min(1) })
/** Exact announcement coordinates. */
export const workspaceChangesSummaryRequestSchema = z.object({ sessionId: sessionIdSchema, seq: count }) satisfies z.ZodType<Wire<RequestPayload<'workspaceChanges.summary'>>>
/** Exact comparison coordinates; indices retain the recorder's ordering. */
export const workspaceChangesDiffRequestSchema = workspaceChangesSummaryRequestSchema.extend({ index: count }) satisfies z.ZodType<Wire<RequestPayload<'workspaceChanges.diff'>>>
/** Bounded recorder summary without storage metadata. */
export const workspaceChangesSummaryValueSchema = z.object({
  turn: z.number().int().positive(), total: count, added: count, deleted: count,
  files: z.array(file.extend({ added: count, deleted: count, binary: z.literal(true).optional(), oversized: z.literal(true).optional() })),
}).nullable() satisfies z.ZodType<Wire<ResponseValue<'workspaceChanges.summary'>>>
/** Text, binary, and size-limited historical comparisons. */
export const workspaceChangesDiffValueSchema = z.discriminatedUnion('kind', [
  file.extend({ kind: z.literal('binary') }),
  file.extend({ kind: z.literal('oversized') }),
  file.extend({ kind: z.literal('text'), before: z.boolean(), after: z.boolean(), coarse: z.boolean(),
    hunks: z.array(z.object({ oldStart: count, oldLines: count, newStart: count, newLines: count,
      lines: z.array(z.string().regex(/^[+ -]/u)),
    })),
  }),
]).nullable() satisfies z.ZodType<Wire<ResponseValue<'workspaceChanges.diff'>>>
