/** Runtime-qualified selectors for administrator Session maintenance. @module */
import { z } from 'zod'
import type { RuntimeId } from './runtime-catalog.ts'

/** One Host root on its recorded Runtime. */
export interface ConversationSessionIdentity {
  readonly rootSessionId: string
  readonly runtimeId: RuntimeId
}
const sessionIdentitySchema = z.object({
  rootSessionId: z.string().min(1).max(512).refine(value => !value.includes('\0')),
  runtimeId: z.string().uuid(),
}).strict()

/**
 * Parse a Session maintenance selector received over HTTP.
 * @param value - untrusted JSON value.
 * @returns a canonical Runtime and original Host root, or absence for invalid fields.
 */
export function parseConversationSessionIdentity(value: unknown): ConversationSessionIdentity | undefined {
  const result = sessionIdentitySchema.safeParse(value)
  return result.success ? { rootSessionId: result.data.rootSessionId, runtimeId: result.data.runtimeId.toLowerCase() as RuntimeId } : undefined
}
