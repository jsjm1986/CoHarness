/** Recover browser input acceptance from the same Session event that enqueued it. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { RpcId } from './api/rpc.ts'

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Bind an input receipt to its submitter and Session.
 * @param session - addressed conversation.
 * @param actor - project participant, or undefined for the sole personal owner.
 * @param id - original browser admission ID.
 * @returns a key that can only be reconciled for this submitter and Session.
 */
export function promptReceiptKey(session: SessionId, actor: number | undefined, id: RpcId): string {
  return hash([session, actor ?? null, id])
}

/** Detect reuse of an admission ID with different input.
 * @param input - canonical UTF-8 JSON from the wire codec.
 * @returns a fingerprint checked before replay.
 */
export function promptFingerprint(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

const receipt = z.object({ key: z.string().regex(/^[0-9a-f]{64}$/u), digest: z.string().regex(/^[0-9a-f]{64}$/u) })

/** Extract the input receipts committed by an inbox insertion.
 * @param event - one logical Session event.
 * @returns the stored receipt keys and input fingerprints.
 */
export function admittedPrompts(event: SessionEvent): Array<{ key: string; digest: string }> {
  if (event.type !== 'agent/inbox/spliced') return []
  return event.data.inserted.flatMap(({ source }) => {
    if (source.kind !== 'user' || !('admission' in source)) return []
    const parsed = receipt.safeParse(source.admission)
    return parsed.success ? [parsed.data] : []
  })
}

/** Private Host projection; recovery metadata never enters an RPC history projection. */
export const promptReceiptProjection = {
  key: 'acceptedPromptReceipts',
  stateVersion: 1,
  stateSchema: z.record(z.string(), z.object({ digest: z.string(), seq: z.number().int().nonnegative() })),
  init: () => ({}),
  apply: (state, event) => {
    const added = admittedPrompts(event)
    if (added.length === 0) return state
    return { ...state, ...Object.fromEntries(added.map(item => [item.key, { digest: item.digest, seq: event.seq }])) }
  },
} satisfies ProjectionDefinition<'acceptedPromptReceipts'>
