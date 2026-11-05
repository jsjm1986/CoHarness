/** Credential-free physical volume status shared by the Gateway and the Admin browser. */
import { z } from 'zod'

const identity = { protocol: z.literal(1), nodeId: z.uuid() }
const location = { volumeId: z.uuid(), dataDirectory: z.string().min(1).max(4096) }
/** A verified or unavailable configured volume identifies the exact local data directory that was checked. */
export const nodeContentHealthSchema = z.discriminatedUnion('status', [
  z.object({ ...identity, status: z.literal('unconfigured') }).strict(),
  z.object({ ...identity, ...location, status: z.literal('verified') }).strict(),
  z.object({ ...identity, ...location, status: z.literal('unavailable') }).strict(),
])
export type NodeContentHealth = z.infer<typeof nodeContentHealthSchema>
