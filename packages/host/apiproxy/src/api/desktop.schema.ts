/** Strict desktop gesture payloads and current-user response validation. */
import { z } from 'zod'
import { sessionIdSchema } from './sessions.schema.ts'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** Confirmation reads cannot carry an actor or a caller-selected node. */
export const desktopStatusRequestSchema = z.object({ sessionId: sessionIdSchema }).strict() satisfies z.ZodType<Wire<RequestPayload<'desktop.status'>>>
/** A save binds the target displayed before the human gesture. */
export const desktopConfirmRequestSchema = desktopStatusRequestSchema.extend({
  rootSessionId: sessionIdSchema, nodeId: z.string().min(1).max(256), desktop: z.string().min(1).max(256), confirmed: z.boolean(),
}).strict() satisfies z.ZodType<Wire<RequestPayload<'desktop.confirm'>>>
/** Current-user state; other participants' confirmations are not exposed. */
export const desktopConfirmationSchema = z.object({
  rootSessionId: sessionIdSchema, nodeId: z.string().min(1), desktop: z.string().min(1),
  userId: z.number().int().positive(), eligible: z.boolean(), confirmed: z.boolean(),
}).strict() satisfies z.ZodType<Wire<ResponseValue<'desktop.confirm'>>>
/** Null represents a deployment without a managed desktop policy. */
export const desktopStatusValueSchema = desktopConfirmationSchema.nullable() satisfies z.ZodType<Wire<ResponseValue<'desktop.status'>>>
