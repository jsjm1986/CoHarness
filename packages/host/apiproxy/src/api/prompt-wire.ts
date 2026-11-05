/** Bytes identified by a durable prompt receipt on the Host and in a recovering browser. */
import type { RequestPayload } from './rpc-map.ts'
import type { RpcId } from './rpc.ts'
import { z } from 'zod'
import type { UserDocIdType } from '@deepseek-ai/dsh-userdoc'

/** Raster image media types accepted by the version-one browser wire. */
export const imageMediaTypeSchema = z.union([
  z.literal('image/png'),
  z.literal('image/jpeg'),
  z.literal('image/webp'),
  z.literal('image/gif'),
])

/** Prompt wire content is intentionally narrower than merge-extensible durable core content. */
export const promptContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), mediaType: imageMediaTypeSchema, data: z.string(), name: z.string().optional() }),
  z.object({ type: z.literal('document'), docId: z.string().min(1) as unknown as z.ZodType<UserDocIdType> }),
])

/**
 * Serialize the validated mode, browser time zone and ordered content used by the Host's persisted input digest.
 * @param mode - queue or steering delivery.
 * @param zone - original IANA time zone, or null when omitted.
 * @param content - wire content parts. The protocol schema owns the fields and their order.
 * @returns UTF-8 JSON to hash with SHA-256.
 */
export function promptInputJson(
  mode: RequestPayload<'session.prompt'>['mode'],
  zone: string | null,
  content: RequestPayload<'session.prompt'>['content'],
): string {
  return JSON.stringify([mode, zone, content.map(part => promptContentPartSchema.parse(part))])
}

/**
 * Produce the request-specific proof input so persisted browser metadata does not contain a reusable content digest.
 * @param id - opaque original submission identity.
 * @param digest - SHA-256 of the validated input JSON.
 * @returns UTF-8 JSON to hash with SHA-256.
 */
export function promptProofJson(id: RpcId, digest: string): string {
  return JSON.stringify([id, digest])
}
