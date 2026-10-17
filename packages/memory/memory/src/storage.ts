/**
 * The `memory` domain declaration: record schema, scope ids, and record-key
 * encoding. One record per entry, in `per-record` layout, so one corrupt file
 * moves aside (`backup-and-skip`) instead of bricking the domain. Record keys
 * must be path-safe (`[a-zA-Z0-9_-]+`), so scope id and entry key join on
 * `_` — a separator neither the scope id (`personal`, `project`,
 * `workspace-<16 lowercase hex>`) nor the entry-key slug can contain; the
 * split is the first `_`.
 * @module @deepseek-ai/dsh-memory/src/storage
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { MemoryKey, MemoryRevision, MemoryScope } from './types.ts'

const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personal') }).strict(),
  z.object({
    kind: z.literal('workspace'),
    directory: z.string().min(1),
    sshTarget: z.number().int().positive().optional(),
  }).strict(),
  z.object({ kind: z.literal('project') }).strict(),
])

const attributionSchema = z.object({
  source: z.enum(['agent', 'extraction', 'consolidation', 'member']),
  sessionId: z.string().min(1).transform(value => brandString<SessionId>(value)).optional(),
  userId: z.number().int().positive().optional(),
  at: z.iso.datetime({ precision: 3 }),
}).strict()

/** Durable record mirroring {@link MemoryEntry}; summary/content keep their stored (already trimmed) text. */
export const memoryEntrySchema = z.object({
  scope: scopeSchema,
  key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64).transform(value => brandString<MemoryKey>(value)),
  kind: z.enum(['profile', 'guidance', 'background', 'resource']),
  summary: z.string(),
  content: z.string(),
  revision: z.string().min(1).transform(value => brandString<MemoryRevision>(value)),
  created: attributionSchema,
  updated: attributionSchema,
}).strict()

/** Stored entry inferred from {@link memoryEntrySchema}. */
export type MemoryRecord = z.infer<typeof memoryEntrySchema>

/**
 * Per-scope address prefix for one runtime's entries: `personal`, `project`,
 * or `workspace-<first 16 hex of sha256(JSON.stringify([sshTarget ?? null, directory]))>`.
 * The identity tuple binds the SSH target first so a remote directory never
 * aliases a host directory with the same path.
 * @param scope - The scope to address.
 * @returns the lowercase scope id used in record keys.
 */
export function memoryScopeId(scope: MemoryScope): string {
  switch (scope.kind) {
    case 'personal': return 'personal'
    case 'project': return 'project'
    case 'workspace': {
      const digest = createHash('sha256')
        .update(JSON.stringify([scope.sshTarget ?? null, scope.directory]))
        .digest('hex')
        .slice(0, 16)
      return `workspace-${digest}`
    }
  }
}

/**
 * The durable record key for one entry: `${scopeId}_${key}`. `_` is the
 * separator because neither component can contain it.
 * @param scope - Entry scope.
 * @param key - Validated entry key.
 * @returns the path-safe table key.
 */
export function memoryRecordKey(scope: MemoryScope, key: string): string {
  return `${memoryScopeId(scope)}_${key}`
}

/**
 * Table-key prefix selecting every record of one scope.
 * @param scope - The scope whose records the prefix selects.
 * @returns the shared record-key prefix for that scope's entries.
 */
export function memoryScopePrefix(scope: MemoryScope): string {
  return `${memoryScopeId(scope)}_`
}

/**
 * The memory domain spec: one `entries` table keyed by record key. Records
 * are disposable-if-corrupt data owned only by this service, so a failed
 * schema parse backs the file up and opens without it.
 */
export const memoryDomain = defineDomain({
  name: 'memory',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { entries: domainTable<string, MemoryRecord>(memoryEntrySchema) },
})
