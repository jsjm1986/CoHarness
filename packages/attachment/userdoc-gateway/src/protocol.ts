/** Closed Gateway document operations and validators for both directions of the private wire protocol. */
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ExecutionScopeId } from '@deepseek-ai/dsh-execution-authority/types'
import {
  UserDocDirectoryId, UserDocId, UserDocIncarnationId, UserDocTrashId, UserDocUploadId, UserDocUploadOwnerId,
  USERDOC_ERROR_CODES,
} from '@deepseek-ai/dsh-userdoc'

/** Exact authenticated streaming endpoint; bodies begin with bounded protocol metadata. */
export const GATEWAY_DOCUMENT_STORE_PATH = '/internal/runtime/documents/store'

type ExactOptional<T> = T extends string | number | boolean | null | undefined ? T
  : T extends readonly (infer V)[] ? ExactOptional<V>[]
    : T extends object ? {
      [K in keyof T as undefined extends T[K] ? never : K]: ExactOptional<T[K]>
    } & { [K in keyof T as undefined extends T[K] ? K : never]?: ExactOptional<Exclude<T[K], undefined>> } : T

function omitUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUndefined)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, omitUndefined(item)]))
}

// JSON optional properties are absent rather than present with an undefined value.
function exactSchema<S extends z.ZodType>(schema: S): z.ZodType<ExactOptional<z.output<S>>> {
  return schema.transform(value => omitUndefined(value) as ExactOptional<z.output<S>>)
}
function exactSchemas<S extends Record<string, z.ZodType>>(schemas: S): {
  [K in keyof S]: z.ZodType<ExactOptional<z.output<S[K]>>>
} {
  return Object.fromEntries(Object.entries(schemas).map(([key, schema]) => [key, exactSchema(schema)])) as {
    [K in keyof S]: z.ZodType<ExactOptional<z.output<S[K]>>>
  }
}
const text = z.string().max(4096), required = text.min(1)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), time = z.number()
const docId = required.transform(UserDocId), directoryId = text.transform(UserDocDirectoryId)
const uploadId = required.transform(UserDocUploadId), ownerId = required.transform(UserDocUploadOwnerId)
const digest = z.string().regex(/^[0-9a-f]{64}$/u)
const identity = z.strictObject({
  incarnationId: required.transform(UserDocIncarnationId), revision: count.min(1),
  createdBy: ownerId.optional(), origin: z.enum(['upload', 'transfer', 'legacy', 'admin']),
})
const selection = z.strictObject({ docId, incarnationId: required.transform(UserDocIncarnationId), revision: count.min(1) })
const trashSelection = selection.extend({ trashId: required.transform(UserDocTrashId) })
const ref = z.strictObject({
  docId, path: required, name: required, bytes: count, mediaType: required, modifiedAt: time, identity: identity.optional(),
})
const directory = z.strictObject({ directoryId, path: required, name: text, modifiedAt: time })
const trash = z.strictObject({
  docId, directoryId, name: required, trashedAt: time, purgeAfter: time, bytes: count, mediaType: required,
  modifiedAt: time, identity: identity.optional(), trashId: required.transform(UserDocTrashId).optional(),
})
const target = z.strictObject({ path: required, name: required, docId })
const session = z.strictObject({
  uploadId, name: required, directoryId, bytes: count, fingerprint: required, chunkBytes: count.min(1),
  receivedBytes: count, expiresAt: time, state: z.enum(['uploading', 'verifying', 'complete', 'failed']),
  ref: ref.optional(), error: z.strictObject({ code: required, message: text }).optional(),
})
const query = z.strictObject({
  limit: count.min(1).max(100).optional(), cursor: required.optional(), query: text.max(255).optional(),
  type: z.enum(['all', 'image', 'pdf', 'text', 'other']).optional(),
  sort: z.enum(['date-desc', 'date-asc', 'name-asc', 'name-desc', 'size-desc', 'size-asc']).optional(),
  state: z.enum(['active', 'trash']).optional(),
})

/** Server-resolved document limits; a client cannot widen them through configuration. */
export const documentLimitsSchema = z.strictObject({
  maxFileBytes: count.nullable(), maxFilesPerMessage: count.min(1), maxMessageBytes: count, maxInlineTextBytes: count,
  upload: z.strictObject({ protocol: z.literal('resumable-v1'), chunkBytes: count.min(1), sessionTtlMs: count.min(1), resumable: z.literal(true) }),
})

/** Caller assertions are separate from execution identity and never choose another runtime root. */
export const documentAuthoritySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('runtime') }),
  z.strictObject({ kind: z.literal('request') }),
  z.strictObject({ kind: z.literal('execution'), sessionId: required.transform(SessionId), scopeId: required.transform(value => value as ExecutionScopeId) }),
])

/** Private store methods; streamed bytes follow metadata only for save and writeUploadChunk. */
export const documentOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('describe') }),
  z.strictObject({ kind: z.literal('resolveTarget'), input: z.strictObject({ name: text, directoryId: directoryId.optional() }) }),
  z.strictObject({ kind: z.literal('save'), target }),
  z.strictObject({ kind: z.literal('beginUpload'), input: z.strictObject({ name: text, directoryId, bytes: count, fingerprint: required }), ownerId: ownerId.optional() }),
  z.strictObject({ kind: z.literal('inspectUpload'), uploadId, ownerId: ownerId.optional() }),
  z.strictObject({ kind: z.literal('writeUploadChunk'), uploadId, ownerId: ownerId.optional(),
    chunk: z.strictObject({ index: count, start: count, end: count, total: count, sha256: digest }) }),
  z.strictObject({ kind: z.literal('completeUpload'), uploadId, sha256: digest, ownerId: ownerId.optional() }),
  z.strictObject({ kind: z.literal('cancelUpload'), uploadId, ownerId: ownerId.optional() }),
  z.strictObject({ kind: z.literal('list') }),
  z.strictObject({ kind: z.literal('listDirectory'), directoryId }),
  z.strictObject({ kind: z.literal('listDirectoryPage'), directoryId, query }),
  z.strictObject({ kind: z.literal('listTrash') }),
  z.strictObject({ kind: z.literal('listTrashPage'), query }),
  z.strictObject({ kind: z.literal('trash'), docId, expected: selection.optional() })
    .refine(value => value.expected === undefined || value.expected.docId === value.docId),
  z.strictObject({ kind: z.literal('restore'), docId, directoryId: directoryId.optional(), name: text.optional(),
    trashId: required.transform(UserDocTrashId).optional(), expected: trashSelection.optional() })
    .refine(value => value.expected === undefined || value.expected.docId === value.docId
      && (value.trashId === undefined || value.expected.trashId === value.trashId)),
  z.strictObject({ kind: z.literal('purge'), docId, trashId: required.transform(UserDocTrashId).optional(), expected: trashSelection.optional() })
    .refine(value => value.expected === undefined || value.expected.docId === value.docId
      && (value.trashId === undefined || value.expected.trashId === value.trashId)),
  z.strictObject({ kind: z.literal('listDirectories') }),
  z.strictObject({ kind: z.literal('createDirectory'), parentDirectoryId: directoryId, name: text }),
  z.strictObject({ kind: z.literal('renameDirectory'), directoryId, name: text, expected: z.array(selection).max(2000).optional() }),
  z.strictObject({ kind: z.literal('removeDirectory'), directoryId }),
  z.strictObject({ kind: z.literal('move'), docId, directoryId, expected: selection.optional() })
    .refine(value => value.expected === undefined || value.expected.docId === value.docId),
  z.strictObject({ kind: z.literal('stat'), docId }),
  z.strictObject({ kind: z.literal('openRead'), docId }),
  z.strictObject({ kind: z.literal('remove'), docId, expected: selection.optional() })
    .refine(value => value.expected === undefined || value.expected.docId === value.docId),
])

/** Strict request metadata; its authority is rechecked by the Gateway before store dispatch. */
export const documentRequestSchema = exactSchema(z.strictObject({
  version: z.literal(1), authority: documentAuthoritySchema, operation: documentOperationSchema,
}))

/** Validated private request and operation vocabulary. */
export type DocumentStoreRequest = z.infer<typeof documentRequestSchema>
/** One store method with parser-validated arguments. */
export type DocumentStoreOperation = DocumentStoreRequest['operation']
/** Authority references; these fields carry identity and grant no privilege alone. */
export type DocumentStoreAuthority = DocumentStoreRequest['authority']

/** Operation-specific response schemas keep server paths, identities and limits inside their declared vocabulary. */
export const documentResultSchemas = exactSchemas({
  describe: z.strictObject({ root: required, limits: documentLimitsSchema }),
  resolveTarget: target, save: ref, beginUpload: session, inspectUpload: session, writeUploadChunk: session, completeUpload: session,
  cancelUpload: z.null(), list: z.array(ref), listDirectory: z.strictObject({
    directoryId, parentDirectoryId: directoryId.optional(), directories: z.array(directory), documents: z.array(ref),
  }),
  listDirectoryPage: z.strictObject({
    directoryId, parentDirectoryId: directoryId.optional(), directories: z.array(directory), documents: z.array(ref),
    totalDocuments: count, nextCursor: required.optional(),
  }),
  listTrashPage: z.strictObject({ documents: z.array(trash), totalDocuments: count, nextCursor: required.optional() }),
  listTrash: z.array(trash), trash, restore: ref, purge: z.null(), listDirectories: z.array(directory), createDirectory: directory,
  renameDirectory: directory, removeDirectory: z.null(), move: ref, stat: ref, openRead: ref, remove: z.null(),
} satisfies Record<DocumentStoreOperation['kind'], z.ZodType>)

/** Result of one exact store method after private-wire validation. */
export type DocumentStoreResult<K extends DocumentStoreOperation['kind']> = z.infer<(typeof documentResultSchemas)[K]>

/** Versioned successful response; the operation must match the admitted request. */
export const documentSuccessSchema = z.strictObject({
  version: z.literal(1), kind: z.literal('success'), operation: z.object(documentResultSchemas).keyof(),
  result: z.unknown(),
})

/** Bounded stable domain failures; no filesystem paths or input bytes belong in their messages. */
export const documentFailureSchema = z.strictObject({
  version: z.literal(1), kind: z.literal('error'), error: z.strictObject({ code: z.enum(USERDOC_ERROR_CODES), message: text }),
})
