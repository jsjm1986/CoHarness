/** Decode optional document incarnation metadata at JSON and durable-file readers. */
import { UserDocIncarnationId, UserDocUploadOwnerId } from './brand.ts'
import type { UserDocIdentity } from './types.ts'

/**
 * Decode the provider's document version without deriving authority from it.
 * @param value - identity metadata read from JSON or a stored reference.
 * @returns normalized known fields, or undefined when the identity is invalid.
 */
export function decodeUserDocIdentity(value: unknown): UserDocIdentity | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  const { incarnationId, revision, origin, createdBy } = item
  if (typeof incarnationId !== 'string' || incarnationId.length === 0 || incarnationId.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(incarnationId)
    || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1
    || (origin !== 'upload' && origin !== 'transfer' && origin !== 'legacy' && origin !== 'admin')
    || (createdBy !== undefined && (typeof createdBy !== 'string' || createdBy.length === 0 || createdBy.length > 4096
      || /[\u0000-\u001f\u007f]/u.test(createdBy)))) return undefined
  return { incarnationId: UserDocIncarnationId(incarnationId), revision, origin,
    ...(createdBy === undefined ? {} : { createdBy: UserDocUploadOwnerId(createdBy) }) }
}

export { userDocLocationUrl } from './location.ts'
