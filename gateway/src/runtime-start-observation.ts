/** Process-local, read-only continuation of a remote start whose response was lost. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { nodeUuidSchema } from './node-access.ts'
import type { RuntimeCatalogEntry } from './runtime-catalog.ts'
import type { RuntimePlacement } from './runtime-router.ts'

const observationSchema = z.object({
  userId: z.number().int().positive(), runtimeId: nodeUuidSchema, nodeId: nodeUuidSchema,
  target: z.union([z.literal('personal'), z.string().regex(/^project:[1-9][0-9]*$/u)]),
  expiresAt: z.number().int().positive(),
}).strict()

/** Original authorized selection and a fixed deadline; this value never authorizes execution. */
export type RuntimeStartObservation = z.infer<typeof observationSchema>

/** A Gateway owns its signing key; restarting it invalidates unfinished observations. */
export class RuntimeStartObservations {
  private readonly key = randomBytes(32)

  /** @param lifetimeMs - configured queue and process-readiness budgets combined. */
  constructor(private readonly lifetimeMs: number) {}

  /**
   * Bind a continuation to the placement already authorized for this start.
   * @param userId - authenticated account, never a browser-supplied identity.
   * @param environment - exact Runtime and computer selected before forwarding.
   * @param target - resolved personal or project owner.
   * @returns a same-origin GET path; it contains no executable start instruction.
   */
  issue(userId: number, environment: RuntimeCatalogEntry, target: RuntimePlacement['target']): string {
    const payload = Buffer.from(JSON.stringify({ userId, runtimeId: environment.id, nodeId: environment.node.id,
      target, expiresAt: Date.now() + this.lifetimeMs })).toString('base64url')
    const signature = createHmac('sha256', this.key).update(payload).digest('base64url')
    return `/account/runtime/wait?observation=${payload}.${signature}`
  }

  /**
   * Verify the original account without retaining an unbounded ticket map.
   * @param token - untrusted query value.
   * @param userId - current authenticated account.
   * @returns a verified selection with its deadline, or null for an altered or foreign continuation.
   */
  read(token: string | null, userId: number): RuntimeStartObservation | null {
    if (token === null || token.length > 2048) return null
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(token)
    if (match === null) return null
    const payload = match[1]!, signature = Buffer.from(match[2]!, 'base64url')
    const expected = createHmac('sha256', this.key).update(payload).digest()
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null
    let decoded: unknown
    try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) }
    catch { return null } // Reject malformed signed data rather than interpreting another selection.
    const parsed = observationSchema.safeParse(decoded)
    if (!parsed.success || parsed.data.userId !== userId) return null
    return parsed.data
  }
}
