/** Gateway archive-state synchronization provider for Gateway-launched runtimes. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { readGatewayResponseJson } from '@deepseek-ai/dsh-gateway-runtime'
import type {} from '@deepseek-ai/dsh-gateway-runtime'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { ArchivedSessionEntry, WorkspaceArchiveSnapshot, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'

export const name = 'archive-gateway'
export const inject = ['connection', 'gatewayRuntime', 'workspaceRegistry']

const ARCHIVE_HTTP_PATH = '/api/internal/archive'
const ARCHIVE_READ_LIMIT = 100_000
const ARCHIVE_MAX_DESCENDANTS = 10_000
const ARCHIVE_MAX_EVENT_RECORDS = 100_000
const ARCHIVE_MAX_EVENT_BYTES = 64 * 1024 * 1024
const ARCHIVE_SYNC_SESSION_BATCH_SIZE = 1_000
const ARCHIVE_SYNC_SEARCH_ROW_BATCH_SIZE = 5_000
const ARCHIVE_SYNC_SEARCH_BYTE_BATCH_SIZE = 4 * 1024 * 1024
const ARCHIVE_SYNC_SEARCH_ROW_BYTES = 64 * 1024
const ARCHIVE_COMMAND_BATCH_SIZE = 1_000
const ARCHIVE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024
const ARCHIVE_PROJECTION_CACHE_MAX_BYTES = 32 * 1024 * 1024
const ARCHIVE_TITLE_CACHE_MAX_ENTRIES = 10_000

interface ArchiveSearchRow {
  sessionId: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  occurredAt: number
}

interface ArchiveSessionPayload {
  sessionId: string
  rootSessionId: string
  header: ArchivedSessionEntry['header']
  title?: string
  messageCount: number
  rootMessageCount?: number
  workspace?: { path: string; title: string; position: number }
}

interface ArchiveSyncBatch {
  archivedSessionIds: string[]
  sessions: ArchiveSessionPayload[]
  search: ArchiveSearchRow[]
}

interface MutableArchiveSyncBatch extends ArchiveSyncBatch {
  readonly sessionIds: Set<string>
  searchBytes: number
}

interface CachedArchiveProjection {
  readonly title: string | undefined
  readonly messageCount: number
  /** Mutable only through {@link ArchiveProjectionCache.append}; sync passes snapshot it before yielding. */
  readonly search: ArchiveSearchRow[]
  /** Highest logical event sequence folded into this projection. */
  readonly lastSeq: number
  readonly bytes: number
}

/** Bounded per-session archive projection cache; invalidated by session events. */
class ArchiveProjectionCache {
  private readonly values = new Map<string, CachedArchiveProjection>()
  private readonly generations = new Map<string, symbol>()
  private bytes = 0

  /** Return a cached projection and refresh its recency. */
  get(sessionId: string): CachedArchiveProjection | undefined {
    const value = this.values.get(sessionId)
    if (value === undefined) return undefined
    this.values.delete(sessionId)
    this.values.set(sessionId, value)
    return value
  }

  /** Return the invalidation generation used to fence an asynchronous load. */
  generation(sessionId: string): symbol {
    let generation = this.generations.get(sessionId)
    if (generation === undefined) {
      generation = Symbol()
      this.generations.set(sessionId, generation)
    }
    return generation
  }

  /** Insert one projection and evict least-recently-used entries above the byte cap. */
  set(sessionId: string, value: CachedArchiveProjection, expectedGeneration: symbol): void {
    if (this.generations.get(sessionId) !== expectedGeneration) return
    this.dropValue(sessionId)
    if (value.bytes > ARCHIVE_PROJECTION_CACHE_MAX_BYTES) return
    this.values.set(sessionId, value)
    this.bytes += value.bytes
    while (this.bytes > ARCHIVE_PROJECTION_CACHE_MAX_BYTES) {
      const oldest = this.values.keys().next().value
      if (oldest === undefined) break
      this.dropValue(oldest)
      this.generations.delete(oldest)
    }
  }

  /** Append one contiguous live event without rereading the session prefix. */
  append(sessionId: string, event: SessionEvent): boolean {
    const prior = this.values.get(sessionId)
    const eventType = event.type as string
    if (prior === undefined || event.seq !== prior.lastSeq + 1 || eventType === 'session/title') return false
    const row = searchRow(sessionId, event)
    const title = prior.title ?? (row?.role === 'user' ? row.content.trim().slice(0, 120) || undefined : undefined)
    // Estimate the incremental serialized footprint instead of stringifying
    // the complete search array on every live event. The conservative fixed
    // allowance covers the enclosing JSON punctuation and counter digits.
    const addedBytes = 64 + (row === undefined ? 0 : Buffer.byteLength(JSON.stringify(row), 'utf8'))
    const bytes = prior.bytes + addedBytes
    if (bytes > ARCHIVE_PROJECTION_CACHE_MAX_BYTES) return false
    if (row !== undefined) prior.search.push(row)
    this.dropValue(sessionId)
    this.values.set(sessionId, {
      title,
      messageCount: prior.messageCount + (event.type === 'user/message' || event.type === 'assistant/message' ? 1 : 0),
      search: prior.search,
      lastSeq: event.seq,
      bytes,
    })
    this.bytes += bytes
    return true
  }

  /** Drop one projection after a durable session event. */
  delete(sessionId: string): void {
    this.dropValue(sessionId)
    this.generations.set(sessionId, Symbol())
  }

  private dropValue(sessionId: string): void {
    const prior = this.values.get(sessionId)
    if (prior !== undefined) {
      this.values.delete(sessionId)
      this.bytes = Math.max(0, this.bytes - prior.bytes)
    }
  }

  /** Remove projections for sessions no longer in the archive set. */
  retain(sessionIds: ReadonlySet<string>): void {
    for (const sessionId of this.values.keys()) {
      if (!sessionIds.has(sessionId)) this.delete(sessionId)
    }
    for (const sessionId of this.generations.keys()) {
      if (!sessionIds.has(sessionId)) this.generations.delete(sessionId)
    }
  }
}

interface ArchiveCommand {
  id: string
  rootSessionId: string
  action: 'restore' | 'trash' | 'purge'
}

function textFromContent(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const item = block as { type?: unknown; text?: unknown; content?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') return [item.text]
    if (item.type === 'tool-result') return [textFromContent(item.content)]
    return []
  }).filter(text => text !== '').join('\n')
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.length <= maximumBytes) return value
  let end = maximumBytes
  while (end > 0 && ((encoded[end] as number) & 0xc0) === 0x80) end--
  return encoded.subarray(0, end).toString('utf8')
}

function searchRow(sessionId: string, event: SessionEvent): ArchiveSearchRow | undefined {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return undefined
  const data = event.data as { content?: unknown; message?: { content?: unknown } }
  const raw = textFromContent(event.type === 'user/message' ? data.content : data.message?.content)
  if (raw === '') return undefined
  return {
    sessionId,
    seq: event.seq,
    role: event.type === 'user/message' ? 'user' : 'assistant',
    content: truncateUtf8(raw, ARCHIVE_SYNC_SEARCH_ROW_BYTES),
    occurredAt: event.time,
  }
}

function explicitTitleFromEvents(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index] as { type: string; data?: unknown } | undefined
    if (event?.type !== 'session/title' || typeof event.data !== 'object' || event.data === null) continue
    const title = (event.data as { title?: unknown }).title
    if (typeof title === 'string' && title.trim() !== '') return title.trim()
  }
  return undefined
}

function titleFromEvents(events: readonly SessionEvent[]): string | undefined {
  const explicit = explicitTitleFromEvents(events)
  if (explicit !== undefined) return explicit
  for (const event of events) {
    const row = searchRow('title', event)
    if (row?.role !== 'user') continue
    const title = row.content.trim()
    return title === '' ? undefined : title.slice(0, 120)
  }
  return undefined
}

/** Keep the read-path title cache from becoming a second unbounded archive catalog. */
function rememberTitle(cache: Map<string, string>, sessionId: string, title: string): void {
  cache.delete(sessionId)
  cache.set(sessionId, title)
  while (cache.size > ARCHIVE_TITLE_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) return
    cache.delete(oldest)
  }
}

function emptySyncBatch(): MutableArchiveSyncBatch {
  return { archivedSessionIds: [], sessions: [], search: [], sessionIds: new Set(), searchBytes: 0 }
}

function takeSyncBatch(batch: MutableArchiveSyncBatch): ArchiveSyncBatch {
  return {
    archivedSessionIds: batch.archivedSessionIds,
    sessions: batch.sessions,
    search: batch.search,
  }
}

function sessionPayload(
  entry: ArchivedSessionEntry,
  title: string | undefined,
  messageCount: number,
): ArchiveSessionPayload {
  return {
    sessionId: String(entry.sessionId),
    rootSessionId: String(entry.rootSessionId),
    header: entry.header,
    ...(title === undefined ? {} : { title }),
    messageCount,
    ...(entry.workspace === undefined ? {} : {
      workspace: {
        path: entry.workspace.path,
        title: entry.workspace.title,
        position: entry.workspace.position,
      },
    }),
  }
}

/** Read and compact one archived session for reuse across synchronization passes. */
async function loadArchiveProjection(
  ctx: Context,
  entry: ArchivedSessionEntry,
): Promise<CachedArchiveProjection> {
  const stored = await ctx.sessionPersistence.readFrom(entry.sessionId, SessionLogOffset(0))
  const title = titleFromEvents(stored.events)
  const search = stored.events.flatMap((event) => {
    const row = searchRow(String(entry.sessionId), event)
    return row === undefined ? [] : [row]
  })
  const messageCount = stored.events.reduce((count, event) => (
    event.type === 'user/message' || event.type === 'assistant/message' ? count + 1 : count
  ), 0)
  const lastSeq = stored.events.reduce((last, event) => Math.max(last, event.seq), -1)
  const bytes = Buffer.byteLength(JSON.stringify({ title, messageCount, search }), 'utf8')
  return { title, messageCount, search, lastSeq, bytes }
}

async function* archiveSyncBatches(
  ctx: Context,
  snapshot: WorkspaceArchiveSnapshot,
  entries: readonly ArchivedSessionEntry[],
  titleCache: Map<string, string>,
  projectionCache: ArchiveProjectionCache,
): AsyncGenerator<ArchiveSyncBatch> {
  const byId = new Map(entries.map(entry => [String(entry.sessionId), entry]))
  const archivedIds = new Set<string>()
  const roots = new Map<string, { payload: ArchiveSessionPayload; messageCount: number }>()
  const rootBatch = new Map<string, number>()
  const rootsNeedingSummary = new Set<string>()
  let batch = emptySyncBatch()
  let batchNumber = 0
  let emitted = false

  const hasPayload = (): boolean => batch.archivedSessionIds.length > 0
    || batch.sessions.length > 0 || batch.search.length > 0
  const addSession = (payload: ArchiveSessionPayload): void => {
    if (batch.sessionIds.has(payload.sessionId)) return
    const priorBatch = rootBatch.get(payload.rootSessionId)
    if (priorBatch === undefined) rootBatch.set(payload.rootSessionId, batchNumber)
    else if (priorBatch !== batchNumber) rootsNeedingSummary.add(payload.rootSessionId)
    batch.sessionIds.add(payload.sessionId)
    batch.archivedSessionIds.push(payload.sessionId)
    batch.sessions.push(payload)
  }

  for (const archivedId of snapshot.archivedSessionIds) {
    const id = String(archivedId)
    if (archivedIds.has(id)) throw new Error(`archive snapshot contains duplicate session '${id}'`)
    archivedIds.add(id)
    const entry = byId.get(id)
    if (entry === undefined) {
      if (batch.archivedSessionIds.length >= ARCHIVE_SYNC_SESSION_BATCH_SIZE) {
        emitted = true
        yield takeSyncBatch(batch)
        batch = emptySyncBatch()
        batchNumber++
      }
      batch.archivedSessionIds.push(id)
      continue
    }

    const generation = projectionCache.generation(id)
    const cached = projectionCache.get(id)
    const projection = cached ?? await loadArchiveProjection(ctx, entry)
    if (cached === undefined) projectionCache.set(id, projection, generation)
    const title = projection.title
    if (title === undefined) titleCache.delete(id)
    else rememberTitle(titleCache, id, title)
    const messageCount = projection.messageCount
    const payload = sessionPayload(entry, title, messageCount)
    const rootId = payload.rootSessionId
    const aggregate = roots.get(rootId)
    if (aggregate === undefined) roots.set(rootId, { payload, messageCount })
    else {
      aggregate.messageCount += messageCount
      if (payload.sessionId === rootId) aggregate.payload = payload
    }
    let rowCount = 0
    // A live event may append to the cached array after this generator yields;
    // snapshot the rows once so this revision's payload stays stable.
    for (const row of projection.search.slice()) {
      rowCount++
      const rowBytes = Buffer.byteLength(row.content, 'utf8')
      const sessionMissing = !batch.sessionIds.has(id)
      const exceedsSessionLimit = sessionMissing
        && batch.archivedSessionIds.length >= ARCHIVE_SYNC_SESSION_BATCH_SIZE
      const exceedsSearchLimit = batch.search.length >= ARCHIVE_SYNC_SEARCH_ROW_BATCH_SIZE
        || (batch.search.length > 0 && batch.searchBytes + rowBytes > ARCHIVE_SYNC_SEARCH_BYTE_BATCH_SIZE)
      if (exceedsSessionLimit || exceedsSearchLimit) {
        emitted = true
        yield takeSyncBatch(batch)
        batch = emptySyncBatch()
        batchNumber++
      }
      addSession(payload)
      batch.search.push(row)
      batch.searchBytes += rowBytes
    }
    if (rowCount === 0) {
      if (!batch.sessionIds.has(id)
        && batch.archivedSessionIds.length >= ARCHIVE_SYNC_SESSION_BATCH_SIZE) {
        emitted = true
        yield takeSyncBatch(batch)
        batch = emptySyncBatch()
        batchNumber++
      }
      addSession(payload)
    }
  }

  if (hasPayload() || !emitted) {
    emitted = true
    yield takeSyncBatch(batch)
  }

  let summaries = emptySyncBatch()
  for (const rootId of rootsNeedingSummary) {
    const aggregate = roots.get(rootId)
    if (aggregate === undefined) continue
    if (summaries.sessions.length >= ARCHIVE_SYNC_SESSION_BATCH_SIZE) {
      yield takeSyncBatch(summaries)
      summaries = emptySyncBatch()
    }
    const payload = { ...aggregate.payload, rootMessageCount: aggregate.messageCount }
    summaries.sessionIds.add(payload.sessionId)
    summaries.archivedSessionIds.push(payload.sessionId)
    summaries.sessions.push(payload)
  }
  if (summaries.sessions.length > 0) yield takeSyncBatch(summaries)
}

function archiveCommands(value: unknown): readonly ArchiveCommand[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('archive snapshot returned invalid JSON')
  }
  const commands = (value as { commands?: unknown }).commands
  if (commands === undefined) return []
  if (!Array.isArray(commands) || commands.length > ARCHIVE_COMMAND_BATCH_SIZE) {
    throw new Error('archive snapshot returned an invalid command batch')
  }
  return commands.map((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new Error('archive snapshot returned an invalid command')
    }
    const command = candidate as { id?: unknown; rootSessionId?: unknown; action?: unknown }
    if (typeof command.id !== 'string' || command.id === ''
      || typeof command.rootSessionId !== 'string' || command.rootSessionId === ''
      || (command.action !== 'restore' && command.action !== 'trash' && command.action !== 'purge')) {
      throw new Error('archive snapshot returned an invalid command')
    }
    return { id: command.id, rootSessionId: command.rootSessionId, action: command.action }
  })
}

function rootOf(
  id: string,
  parents: ReadonlyMap<string, string | undefined>,
  cache = new Map<string, string>(),
): string {
  const cached = cache.get(id)
  if (cached !== undefined) return cached
  const seen = new Set<string>()
  const path: string[] = []
  let current = id
  while (true) {
    if (seen.has(current)) throw new Error(`session lineage cycle at '${current}'`)
    seen.add(current)
    path.push(current)
    const known = cache.get(current)
    if (known !== undefined) {
      for (const member of path) cache.set(member, known)
      return known
    }
    const parent = parents.get(current)
    if (parent === undefined) {
      for (const member of path) cache.set(member, current)
      return current
    }
    current = parent
  }
}

function compareArchiveEvents(
  left: { sessionId: string; seq: number; time: number },
  right: { sessionId: string; seq: number; time: number },
): number {
  if (left.time !== right.time) return left.time < right.time ? -1 : 1
  const sessionOrder = left.sessionId.localeCompare(right.sessionId)
  if (sessionOrder !== 0) return sessionOrder
  if (left.seq === right.seq) return 0
  return left.seq < right.seq ? -1 : 1
}

function heapUp<T>(heap: T[], index: number, compare: (left: T, right: T) => number): void {
  let child = index
  while (child > 0) {
    const parent = Math.floor((child - 1) / 2)
    if (compare(heap[parent] as T, heap[child] as T) >= 0) break
    ;[heap[parent], heap[child]] = [heap[child] as T, heap[parent] as T]
    child = parent
  }
}

function heapDown<T>(heap: T[], index: number, compare: (left: T, right: T) => number): void {
  let parent = index
  for (;;) {
    const left = parent * 2 + 1
    if (left >= heap.length) return
    const right = left + 1
    let largest = left
    if (right < heap.length && compare(heap[right] as T, heap[left] as T) > 0) largest = right
    if (compare(heap[parent] as T, heap[largest] as T) >= 0) return
    ;[heap[parent], heap[largest]] = [heap[largest] as T, heap[parent] as T]
    parent = largest
  }
}

function retainEarliest<T>(
  heap: T[],
  value: T,
  capacity: number,
  compare: (left: T, right: T) => number,
): void {
  if (heap.length < capacity) {
    heap.push(value)
    heapUp(heap, heap.length - 1, compare)
    return
  }
  if (capacity === 0 || compare(value, heap[0] as T) >= 0) return
  heap[0] = value
  heapDown(heap, 0, compare)
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function allSessionHeaders(ctx: Context) {
  const persisted = await ctx.sessionPersistence.list()
  const live = ctx.get('sessions')?.list().map(session => session.header) ?? []
  const persistedIds = new Set(persisted.map(header => String(header.id)))
  return [...persisted, ...live.filter(candidate => !persistedIds.has(String(candidate.id)))]
}

interface ArchiveHeaderIndex {
  headers: Awaited<ReturnType<typeof allSessionHeaders>>
  parents: Map<string, string | undefined>
  roots: Map<string, string>
}

/**
 * Cache the persisted-header enumeration until session topology changes. A
 * concurrent load is shared, and an invalidation racing that load prevents
 * its result from becoming the next cached snapshot.
 */
class ArchiveHeaderIndexCache {
  private value: ArchiveHeaderIndex | undefined
  private dirty = true
  private generation = 0
  private loading: Promise<ArchiveHeaderIndex> | undefined
  private loadingToken: symbol | undefined

  constructor(private readonly ctx: Context) {}

  /** Read the current header index, rebuilding it only after invalidation. */
  async get(): Promise<ArchiveHeaderIndex> {
    if (!this.dirty && this.value !== undefined) return this.value
    if (this.loading !== undefined) return this.loading
    const generation = this.generation
    const token = Symbol('archive-header-load')
    this.loadingToken = token
    const loading = allSessionHeaders(this.ctx).then((headers) => {
      const parents = new Map<string, string | undefined>(headers.map(header => [
        String(header.id), header.parentSession === undefined ? undefined : String(header.parentSession),
      ]))
      const index: ArchiveHeaderIndex = { headers, parents, roots: new Map() }
      if (generation === this.generation) {
        this.value = index
        this.dirty = false
      }
      return index
    }).finally(() => {
      if (this.loadingToken === token) {
        this.loading = undefined
        this.loadingToken = undefined
      }
    })
    this.loading = loading
    return loading
  }

  /** Mark the cached topology stale after a session create, dispose, or purge. */
  invalidate(): void {
    this.generation += 1
    this.dirty = true
  }
}

async function readArchive(
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
  titleCache: Map<string, string>,
  headerCache: ArchiveHeaderIndexCache,
): Promise<void> {
  const principal = ctx.gatewayRuntime.requireCurrent()
  if (principal.claims.user.role !== 'admin'
    || (principal.claims as { purpose?: unknown }).purpose !== 'archive-read') {
    sendJson(res, 403, { error: 'forbidden' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://runtime')
  if (url.pathname !== `${ARCHIVE_HTTP_PATH}/read` || req.method !== 'GET') {
    sendJson(res, 404, { error: 'not-found' })
    return
  }
  const sessionId = url.searchParams.get('sessionId')
  const rawFrom = url.searchParams.get('fromSeq')
  const rawLimit = url.searchParams.get('limit')
  const fromSeq = rawFrom === null ? 0 : Number(rawFrom)
  const limit = rawLimit === null ? 200 : Number(rawLimit)
  if (sessionId === null || sessionId === '' || !Number.isSafeInteger(fromSeq) || fromSeq < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > ARCHIVE_READ_LIMIT) {
    sendJson(res, 400, { error: 'invalid-archive-read' })
    return
  }

  const { headers, parents, roots } = await headerCache.get()
  const byId = new Map(headers.map(header => [String(header.id), header]))
  if (byId.get(sessionId) === undefined) {
    sendJson(res, 404, { error: 'archive-session-not-found' })
    return
  }
  const requestedRoot = rootOf(sessionId, parents, roots)
  const entries = headers.filter(header => rootOf(String(header.id), parents, roots) === requestedRoot)
    .sort((left, right) => right.createdAt - left.createdAt || String(left.id).localeCompare(String(right.id)))
  if (entries.length > ARCHIVE_MAX_DESCENDANTS) {
    sendJson(res, 413, { error: 'archive-too-large' })
    return
  }
  const events: Array<{ sessionId: string; seq: number; type: string; time: number; data: unknown }> = []
  const eventHeap: typeof events = []
  let eventCount = 0
  let eventBytes = 0
  const titles = new Map<string, string>()
  for (const header of entries) {
    const id = String(header.id)
    const cachedTitle = titleCache.get(id)
    const stored = await ctx.sessionPersistence.readFrom(header.id, SessionLogOffset(cachedTitle === undefined ? 0 : fromSeq))
    const title = cachedTitle === undefined
      ? titleFromEvents(stored.events)
      : explicitTitleFromEvents(stored.events) ?? cachedTitle
    if (title !== undefined) rememberTitle(titleCache, id, title)
    if (title !== undefined) titles.set(String(header.id), title)
    for (const event of stored.events) {
      if (event.seq < fromSeq) continue
      eventCount++
      if (eventCount > ARCHIVE_MAX_EVENT_RECORDS) {
        sendJson(res, 413, { error: 'archive-too-large' })
        return
      }
      const candidate = { sessionId: String(header.id), seq: event.seq, type: event.type, time: event.time, data: event.data }
      eventBytes += Buffer.byteLength(JSON.stringify(candidate), 'utf8')
      if (eventBytes > ARCHIVE_MAX_EVENT_BYTES) {
        sendJson(res, 413, { error: 'archive-too-large' })
        return
      }
      retainEarliest(eventHeap, candidate, limit + 1, compareArchiveEvents)
    }
  }
  events.push(...eventHeap.sort(compareArchiveEvents))
  sendJson(res, 200, {
    descendants: entries.map(header => ({
      sessionId: String(header.id),
      parentSessionId: header.parentSession === undefined ? null : String(header.parentSession),
      title: titles.get(String(header.id)) ?? '未命名会话',
    })),
    events: events.slice(0, limit),
    hasMore: eventCount > limit,
  })
}

async function removeTree(
  ctx: Context,
  registry: WorkspaceRegistry,
  rootSessionId: string,
  headerCache: ArchiveHeaderIndexCache,
): Promise<void> {
  const { headers, parents, roots } = await headerCache.get()
  const tree = headers.filter(header => rootOf(String(header.id), parents, roots) === rootSessionId)
  const live = ctx.get('sessions')
  if (live !== undefined && tree.some(header => live.get(header.id) !== undefined)) {
    throw new Error(`cannot purge live archive tree '${rootSessionId}'`)
  }
  for (const header of tree) await ctx.sessionPersistence.remove(header.id)
  for (const header of tree) {
    if (registry.archivedSessionIds.includes(header.id)) await registry.restoreSession(header.id)
  }
  headerCache.invalidate()
}

async function mutateTree(
  registry: WorkspaceRegistry,
  rootSessionId: string,
  action: 'archive' | 'restore',
  headerCache: ArchiveHeaderIndexCache,
): Promise<void> {
  const { headers, parents, roots } = await headerCache.get()
  for (const header of headers) {
    const sessionId = header.id
    if (rootOf(String(sessionId), parents, roots) !== rootSessionId) continue
    if (action === 'restore') {
      if (registry.archivedSessionIds.includes(sessionId)) await registry.restoreSession(sessionId)
    } else {
      await registry.archiveSession(sessionId)
    }
  }
}

/** Synchronize bounded archive projection batches and replay pending Gateway commands. */
export function apply(ctx: Context): void {
  ctx.inject(['connection', 'gatewayRuntime', 'workspaceRegistry', 'sessionPersistence'], (ctx) => {
    const gateway = ctx.gatewayRuntime
    const registry = ctx.workspaceRegistry
    const titleCache = new Map<string, string>()
    const projectionCache = new ArchiveProjectionCache()
    const headerCache = new ArchiveHeaderIndexCache(ctx)
    ctx.connection.http.handlePrefix(
      ARCHIVE_HTTP_PATH,
      (req, res) => readArchive(ctx, req, res, titleCache, headerCache),
      { authority: 'loopback' },
    )
    const abort = new AbortController()
    let requested = false
    let running = false
    let tail: Promise<void> = Promise.resolve()

    const synchronize = async (): Promise<boolean> => {
      const snapshot = registry.archiveSnapshot()
      const entries = await registry.archivedEntries()
      const archived = new Set(snapshot.archivedSessionIds.map(String))
      for (const sessionId of titleCache.keys()) if (!archived.has(sessionId)) titleCache.delete(sessionId)
      projectionCache.retain(archived)
      const commands = new Map<string, ArchiveCommand>()
      for await (const batch of archiveSyncBatches(ctx, snapshot, entries, titleCache, projectionCache)) {
        const response = await gateway.request('/internal/runtime/archive/snapshot', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            revision: snapshot.revision,
            archivedSessionIds: batch.archivedSessionIds,
            sessions: batch.sessions,
            ...(batch.search.length === 0 ? {} : { search: batch.search }),
          }),
          signal: abort.signal,
        })
        if (!response.ok) throw new Error(`archive snapshot rejected with HTTP ${String(response.status)}`)
        for (const command of archiveCommands(await readGatewayResponseJson(response, ARCHIVE_RESPONSE_MAX_BYTES))) {
          commands.set(command.id, command)
        }
      }
      for (const command of commands.values()) {
        let error: string | undefined
        try {
          if (command.action === 'restore') await mutateTree(registry, command.rootSessionId, 'restore', headerCache)
          if (command.action === 'trash') await mutateTree(registry, command.rootSessionId, 'archive', headerCache)
          if (command.action === 'purge') await removeTree(ctx, registry, command.rootSessionId, headerCache)
        } catch (cause: unknown) {
          error = cause instanceof Error ? cause.message : String(cause)
        }
        const ack = await gateway.request('/internal/runtime/archive/ack', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ commandId: command.id, revision: snapshot.revision, ...(error === undefined ? {} : { error }) }),
          signal: abort.signal,
        })
        if (!ack.ok) throw new Error(`archive command acknowledgement failed with HTTP ${String(ack.status)}`)
      }
      return commands.size > 0
    }

    const reportSyncError = (error: unknown): void => {
      if (abort.signal.aborted) return
      ctx.logger.warn(`Gateway archive synchronization deferred: ${String(error)}`)
    }

    const sync = (): void => {
      if (abort.signal.aborted) return
      requested = true
      if (running) return
      running = true
      tail = (async () => {
        for (;;) {
          if (!requested || abort.signal.aborted) break
          requested = false
          try {
            if (await synchronize()) requested = true
          } catch (error: unknown) {
            reportSyncError(error)
          }
        }
      })().finally(() => {
        running = false
        if (requested && !abort.signal.aborted) sync()
      })
    }

    ctx.on('workspace/archive-changed', (_snapshot: WorkspaceArchiveSnapshot) => { sync() })
    ctx.on('session/created', () => { headerCache.invalidate() }, { global: true })
    ctx.on('session/disposed', () => { headerCache.invalidate() }, { global: true })
    ctx.on('session/event', (session, event) => {
      if (registry.archivedSessionIds.includes(session.id)) {
        const id = String(session.id)
        const observedEvent = event as SessionEvent | undefined
        if (observedEvent === undefined || !projectionCache.append(id, observedEvent)) projectionCache.delete(id)
        sync()
      }
    })
    ctx.effect(() => {
      sync()
      return async () => {
        requested = false
        abort.abort()
        await tail
      }
    }, 'archive-gateway:sync')
  })
}

export default apply
