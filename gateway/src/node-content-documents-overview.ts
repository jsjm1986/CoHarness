/** Merge permission-filtered pages from the legacy index and independently addressed computers. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { RuntimeNodeId } from './runtime-catalog.ts'
import {
  DocumentCatalogError,
  type DocumentCatalogMetrics,
  type DocumentCatalogOverviewOptions,
  type DocumentCatalogRow,
} from './postgres/document-catalog-service.ts'

export interface DocumentOverviewPage {
  documents: readonly DocumentCatalogRow[]
  metrics: DocumentCatalogMetrics
  totalDocuments?: number
  revision?: string
}
export interface DocumentOverviewSource {
  id: string
  read(offset: number, limit: number, signal?: AbortSignal): Promise<DocumentOverviewPage>
}

/** Bounded, globally ordered metadata from a fixed set of index sources. */
export interface MergedDocumentOverview extends DocumentOverviewPage {
  readonly version: 1
  readonly totalDocuments: number
  readonly partial?: true
  readonly unavailableNodes?: readonly string[]
  readonly nextCursor?: string
}

/** Publish provisional first-page rows while the rest of the index reads continue. */
export type DocumentOverviewProgress = (page: MergedDocumentOverview, pending: number) => Promise<void>

const continuation = z
  .object({
    v: z.literal(1),
    query: z.string().length(43),
    positions: z
      .array(z.tuple([z.string().max(64), z.number().int().nonnegative(), z.string().max(128).nullable()]))
      .max(4096),
    excluded: z.array(z.uuid()).max(4096).optional(),
  })
  .strict()
const zero = (): DocumentCatalogMetrics => ({
  total: 0,
  active: 0,
  trash: 0,
  purged: 0,
  deleted: 0,
  personal: 0,
  project: 0,
  bytes: 0,
  operations24h: 0,
  failures24h: 0,
})
const metricKeys = Object.keys(zero()) as (keyof DocumentCatalogMetrics)[]
function invalid(): never {
  throw new DocumentCatalogError('DOCUMENT_DIRECTORY_CHANGED', 409, 'The document directory changed. Refresh to continue.')
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const metricSchema = z
  .object({
    total: count,
    active: count,
    trash: count.optional(),
    purged: count.optional(),
    deleted: count,
    personal: count,
    project: count,
    bytes: count,
    operations24h: count,
    failures24h: count,
  })
  .strict()
const entrySchema = z
  .object({
    catalogId: z.uuid(),
    scope: z.object({
      kind: z.enum(['personal', 'project']),
      id: count,
      label: z.string().max(4096),
      mode: z.enum(['ro', 'rw']).optional(),
      nodeId: z.uuid().transform((value) => value as RuntimeNodeId),
    }),
    docId: z.string().min(1).max(4096),
    directoryId: z.string().max(4096),
    name: z.string().min(1).max(255),
    bytes: count,
    mediaType: z.string().max(255),
    modifiedAt: count,
    owner: z.object({ id: count, displayName: z.string().max(4096) }).nullable(),
    identity: z.object({ incarnationId: z.uuid(), revision: count }).nullable(),
    trashId: z.string().nullable(),
    ownerSource: z.enum(['upload', 'transfer', 'legacy', 'admin']),
    state: z.enum(['active', 'trash', 'purged', 'missing', 'deleted']),
    trashedAt: count.nullable(),
    restoredAt: count.nullable(),
    purgeAfter: count.nullable(),
    purgedAt: count.nullable(),
    legacy: z.boolean(),
    lineageRootId: z.uuid().nullable(),
  })
  .strict()
/** Check a receiving computer's bounded response before mixing it with authorized local metadata. */
export function readDocumentNodePage(value: unknown, nodeId: string, limit: number): DocumentOverviewPage {
  const page = z
    .object({
      documents: z.array(entrySchema).max(limit),
      metrics: metricSchema,
      totalDocuments: count,
      revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .optional(),
    })
    .strict()
    .parse(value)
  if (page.documents.some((row) => row.scope.nodeId !== nodeId) || page.totalDocuments < page.documents.length) invalid()
  return page
}

/** Merge source prefixes, and keep cursor positions fixed until a complete page can be published.
 * @param owner - verified organization, account and entry computer.
 * @param options - bounded query, sort and optional prior-page continuation.
 * @param sources - currently authorized index readers, with the entry computer first.
 * @param concurrency - maximum simultaneous reads for this request.
 * @param signal - lifetime of the browser request.
 * @param progress - optional publisher for authorized, provisional first-page rows.
 * @returns a page ordered across all participating sources.
 */
export async function mergeDocumentOverview(
  owner: { organizationId: string; userId: number; entryNodeId: string },
  options: DocumentCatalogOverviewOptions,
  sources: readonly DocumentOverviewSource[],
  concurrency: number,
  signal?: AbortSignal,
  progress?: DocumentOverviewProgress,
): Promise<MergedDocumentOverview> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || sources.length > 4096) {
    throw new DocumentCatalogError(
      'DOCUMENT_SCOPE_UNAVAILABLE',
      503,
      'The document directory exceeds the configured query budget.',
    )
  }
  const limit = options.limit ?? 50,
    sort = options.sort ?? 'date-desc'
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document page size.')
  const query = createHash('sha256')
    .update(
      JSON.stringify([
        owner.organizationId,
        owner.userId,
        owner.entryNodeId,
        options.query?.trim() ?? '',
        options.type ?? 'all',
        sort,
        sources.map((source) => source.id).sort(),
      ]),
    )
    .digest('base64url')
  const offsets = new Map<string, { offset: number; revision: string | null }>()
  const excluded = new Set<string>()
  if (options.cursor) {
    if (options.cursor.length > 512 * 1024) invalid()
    try {
      const previous = continuation.parse(JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')))
      if (previous.query !== query) invalid()
      const ids = new Set(sources.map(source => source.id))
      for (const [id, offset, revision] of previous.positions) {
        if (!ids.has(id) || offsets.has(id)) invalid()
        offsets.set(id, { offset, revision })
      }
      for (const id of previous.excluded ?? []) {
        if (!ids.has(id) || offsets.has(id) || excluded.has(id)) invalid()
        excluded.add(id)
      }
    } catch {
      invalid()
    }
  }
  let visible: Array<{ source: string; row: DocumentCatalogRow }> = []
  const counts = new Map<string, number>(),
    unavailableNodes = [...excluded]
  const metrics = zero()
  let totalDocuments = 0
  let next = 0
  const selected = sources.filter(source => !excluded.has(source.id))
  const publishPartial = progress !== undefined && options.cursor === undefined
  let pending = selected.length
  let wake: (() => void) | undefined
  const changed = (): void => { const notify = wake; wake = undefined; notify?.() }
  const lifetime = new AbortController()
  const readSignal = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
  const desc = sort.endsWith('desc')
  const order = (left: DocumentCatalogRow, right: DocumentCatalogRow) => {
    const cmp = sort.startsWith('size')
      ? left.bytes - right.bytes
      : sort.startsWith('name')
        ? Buffer.compare(Buffer.from(left.name.toLowerCase()), Buffer.from(right.name.toLowerCase()))
        : left.modifiedAt - right.modifiedAt
    return (desc ? -cmp : cmp) || Buffer.compare(Buffer.from(left.catalogId), Buffer.from(right.catalogId))
  }
  const reader = async () => {
    while (next < selected.length) {
      readSignal.throwIfAborted()
      const source = selected[next++]!,
        position = offsets.get(source.id)
      let page: DocumentOverviewPage
      try {
        page = await source.read(position?.offset ?? 0, limit, readSignal)
      } catch (error) {
        readSignal.throwIfAborted()
        if (source.id === 'legacy' || (error instanceof DocumentCatalogError && error.status < 500)) throw error
        if (progress !== undefined && options.cursor !== undefined) {
          throw new DocumentCatalogError('DOCUMENT_SCOPE_UNAVAILABLE', 503, 'A computer required for this page is unavailable.')
        }
        unavailableNodes.push(source.id)
        pending--
        if (publishPartial) changed()
        continue
      }
      readSignal.throwIfAborted()
      if (position?.revision && page.revision !== position.revision) invalid()
      const count = page.totalDocuments ?? page.documents.length
      if (!Number.isSafeInteger(count) || count < 0 || page.documents.length > limit) invalid()
      counts.set(source.id, count)
      totalDocuments += count
      offsets.set(source.id, { offset: position?.offset ?? 0, revision: page.revision ?? null })
      for (const key of metricKeys) {
        const combined = (metrics[key] ?? 0) + (page.metrics[key] ?? 0)
        if (!Number.isSafeInteger(combined) || combined < 0) invalid()
        Object.assign(metrics, { [key]: combined })
      }
      const candidates = [...visible, ...page.documents.map((row) => ({ source: source.id, row }))]
      candidates.sort((a, b) => order(a.row, b.row) || a.source.localeCompare(b.source, 'en'))
      visible = candidates.slice(0, limit)
      pending--
      if (publishPartial) changed()
    }
  }
  const snapshot = (complete: boolean): MergedDocumentOverview => {
    const missing = [...unavailableNodes].sort()
    if (complete) for (const item of visible) offsets.get(item.source)!.offset++
    const more = complete && [...counts].some(([id, count]) => offsets.get(id)!.offset < count)
    return {
      version: 1,
      documents: visible.map((item) => item.row),
      metrics: { ...metrics },
      totalDocuments,
      ...(missing.length ? { partial: true, unavailableNodes: missing } : {}),
      ...(more && visible.length
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({ v: 1, query, positions: [...offsets].map(([id, x]) => [id, x.offset, x.revision]),
                ...(missing.length && (progress !== undefined || excluded.size) ? { excluded: missing } : {}) }),
            ).toString('base64url'),
          }
        : {}),
    }
  }
  let finished = false
  const reads = Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, reader))
  const completion = reads.then(() => { finished = true; changed() }, () => { finished = true; changed() })
  try {
    let publishedPending = pending
    let published: string | undefined
    while (publishPartial && !finished && pending > 0) {
      if (counts.size > 0 && pending < publishedPending) {
        publishedPending = pending
        const keys = visible.map(item => `${item.source}:${item.row.catalogId}`).join(',')
        if (keys === published) continue
        published = keys
        await progress(snapshot(false), pending)
      } else await new Promise<void>(resolve => { wake = resolve })
    }
    await reads
    readSignal.throwIfAborted()
    return snapshot(true)
  } finally {
    lifetime.abort()
    await completion
  }
}
