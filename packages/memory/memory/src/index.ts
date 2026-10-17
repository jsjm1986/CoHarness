/**
 * `@deepseek-ai/dsh-memory` — the host-plane durable memory service. It owns
 * the `memory` storage domain (one record per entry, `per-record` layout,
 * `backup-and-skip`), validates and serializes every write, resolves which
 * scopes a session may address, authorizes project writes through the
 * execution-authority capability, and ranks bounded search results.
 * @module @deepseek-ai/dsh-memory
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { executionAuthorityOf } from '@deepseek-ai/dsh-execution-authority'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { rankEntries, summaryOf } from './search.ts'
import { memoryDomain, memoryRecordKey, memoryScopeId, memoryScopePrefix, type MemoryRecord } from './storage.ts'
import type {
  MemoryDeleteRequest,
  MemoryEntry,
  MemoryEntrySummary,
  MemoryInvalidReason,
  MemoryKey,
  MemoryRevision,
  MemorySaveRequest,
  MemoryScope,
  MemorySearchHit,
  MemoryWriteResult,
  MemoryWriter,
} from './types.ts'

export * from './types.ts'
export { memoryDomain, memoryRecordKey, memoryScopeId, memoryScopePrefix } from './storage.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable memory service registered as `memory`; see {@link MemoryService}. */
    memory: MemoryService
  }
  interface Events {
    /**
     * Emitted after a memory write commits. Consumers re-read through the
     * service; the payload names the touched scope id and key only.
     * @mode emit
     * @param scope - The scope id of the written entry.
     * @param key - The entry key.
     */
    'memory/changed'(this: Context, scope: string, key: string): void
  }
}

/** The key grammar: lowercase letters, digits, single hyphens, at most 64 characters. */
const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Catalog order inside a scope: guidance, profile, background, resource. */
const KIND_ORDER = { guidance: 0, profile: 1, background: 2, resource: 3 } as const

/** Validated service configuration; field docs are the model-facing meaning. */
export interface Config {
  /** `personal` offers personal+workspace scopes, `project` one shared scope. */
  space: 'personal' | 'project'
  /** Content bound in UTF-8 bytes, inclusive. */
  entryMaxBytes: number
  /** Summary bound in Unicode code points, inclusive. */
  summaryMaxChars: number
  /** Entry cap per scope; creates refuse at the limit, replaces and deletes never do. */
  maxEntriesPerScope: number
  /** Search result cap. */
  searchMaxResults: number
}

/**
 * Validate and brand a key candidate. Throws `TypeError` on an invalid slug —
 * callers at untyped boundaries validate first and surface `memory_invalid`.
 * @param value - The raw key.
 * @returns the branded key.
 */
export function MemoryKey(value: string): MemoryKey {
  if (!KEY_PATTERN.test(value) || value.length > 64) {
    throw new TypeError(`invalid memory key '${value}': use lowercase letters, digits, and single hyphens, at most 64 characters`)
  }
  return brandString<MemoryKey>(value)
}

/**
 * Brand an opaque revision token from storage or an `expectedRevision` input.
 * @param value - The raw token text to brand.
 * @returns the branded revision.
 */
export function MemoryRevision(value: string): MemoryRevision {
  return brandString<MemoryRevision>(value)
}

/**
 * Durable per-scope memory. Read paths (`scopesFor`, `read`, `list`,
 * `search`) are lock-free; writes serialize on a single chain inside the
 * service so create/duplicate, revision, and full checks stay atomic.
 */
export default class MemoryService extends Service {
  static inject = ['storageDomain']

  /** Validated config bound to this runtime's space. */
  static Config: z<Config> = z.object({
    space: z.union(['personal', 'project']).default('personal'),
    entryMaxBytes: z.number().step(1).min(256).max(65536).default(8192),
    summaryMaxChars: z.number().step(1).min(20).max(500).default(150),
    maxEntriesPerScope: z.number().step(1).min(1).max(10000).default(200),
    searchMaxResults: z.number().step(1).min(1).max(50).default(10),
  })

  /** The space selected at composition (`personal` or `project`). */
  readonly space: 'personal' | 'project'

  /** Resolved write/search bounds. */
  readonly limits: {
    readonly entryMaxBytes: number
    readonly summaryMaxChars: number
    readonly maxEntriesPerScope: number
    readonly searchMaxResults: number
  }

  /** Domain open is asynchronous; every access resolves through `ready`. */
  private readonly ready: Promise<Domain<typeof memoryDomain>>

  /** Head of the serialized write chain. */
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'memory')
    this.space = config.space
    this.limits = Object.freeze({
      entryMaxBytes: config.entryMaxBytes,
      summaryMaxChars: config.summaryMaxChars,
      maxEntriesPerScope: config.maxEntriesPerScope,
      searchMaxResults: config.searchMaxResults,
    })
    this.ready = ctx.storageDomain.open(memoryDomain)
    ctx.effect(async () => {
      const domain = await this.ready
      return ctx.effect(() => async () => { await domain.close() })
    })
  }

  /** The open `entries` table. */
  private async entries(): Promise<KvTable<string, MemoryRecord>> {
    return (await this.ready).table('entries')
  }

  /**
   * The scopes this space offers a session. `personal` space returns the
   * personal scope plus, when the session header carries `cwd`, the workspace
   * scope keyed by `(cwd, sshTarget)`; `project` space returns the shared
   * project scope only.
   * @param agent - The session's agent.
   * @returns scopes in catalog order.
   */
  scopesFor(agent: Agent): readonly MemoryScope[] {
    if (this.space === 'project') return [{ kind: 'project' }]
    const header = agent.session.header
    const scopes: MemoryScope[] = [{ kind: 'personal' }]
    if (header.cwd !== undefined && header.cwd !== '') {
      scopes.push(header.sshTarget === undefined
        ? { kind: 'workspace', directory: header.cwd }
        : { kind: 'workspace', directory: header.cwd, sshTarget: header.sshTarget })
    }
    return scopes
  }

  /**
   * Look up one entry by scope and raw key. A malformed key simply cannot
   * exist, so this resolves `undefined` rather than raising.
   * @param scope - The scope to read.
   * @param key - Raw key text.
   * @returns the stored entry, if any.
   */
  async read(scope: MemoryScope, key: string): Promise<MemoryEntry | undefined> {
    if (!KEY_PATTERN.test(key) || key.length > 64) return undefined
    return (await this.entries()).get(memoryRecordKey(scope, key)) as MemoryEntry | undefined
  }

  /**
   * Catalog rows of one scope in catalog order: kind (guidance, profile,
   * background, resource), then `updated.at` desc, then key asc.
   * @param scope - The scope to list.
   * @returns the ordered catalog rows (entries without bodies).
   */
  async list(scope: MemoryScope): Promise<MemoryEntrySummary[]> {
    const prefix = memoryScopePrefix(scope)
    const entries: MemoryEntry[] = []
    for (const [recordKey, entry] of (await this.entries()).entries()) {
      if (recordKey.startsWith(prefix)) entries.push(entry as MemoryEntry)
    }
    entries.sort((a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
      || b.updated.at.localeCompare(a.updated.at)
      || a.key.localeCompare(b.key))
    return entries.map(summaryOf)
  }

  /**
   * Bounded term search across scopes. Scores every entry (key ×3, summary
   * ×2, content ×1; whole-query containment `+10×w`, per contained term
   * `+w×(1+min(occurrences,5))`), keeps score > 0, orders score desc,
   * `updated.at` desc, key asc, caps at `searchMaxResults`.
   * @param scopes - Scopes to search (typically {@link scopesFor}).
   * @param query - Raw query; NFKC-folded and lowercased.
   * @returns ranked hits, or a `memory_invalid`/`query` refusal on empty input.
   */
  async search(
    scopes: readonly MemoryScope[],
    query: string,
  ): Promise<MemorySearchHit[] | { ok: false; code: 'memory_invalid'; reason: 'query' }> {
    if (query.trim().length === 0) {
      return { ok: false, code: 'memory_invalid', reason: 'query' }
    }
    const ids = new Set(scopes.map(scope => memoryScopeId(scope)))
    const entries: MemoryEntry[] = []
    for (const [recordKey, entry] of (await this.entries()).entries()) {
      const scopeId = recordKey.slice(0, recordKey.indexOf('_'))
      if (ids.has(scopeId)) entries.push(entry as MemoryEntry)
    }
    return rankEntries(entries, query, this.limits.searchMaxResults)
  }

  /**
   * Create or replace an entry. Without `expectedRevision` the write is
   * create-only (`memory_exists` when the key is used); with it the write is
   * replace-only (`memory_not_found`, `memory_stale`). Replaces are immune to
   * the scope cap; creates refuse `memory_full` at it.
   * @param request - The save input.
   * @param writer - Who is writing (agent today).
   * @returns the committed entry and the replaced record, or a refusal.
   */
  save(request: MemorySaveRequest, writer: MemoryWriter): Promise<MemoryWriteResult> {
    return this.serialize(async () => {
      const scopeError = this.scopeRefusal(request.scope, writer)
      if (scopeError !== undefined) return scopeError
      const invalid = this.validateSave(request)
      if (invalid !== undefined) return invalid
      const key = MemoryKey(request.key)
      const recordKey = memoryRecordKey(request.scope, key)
      const userId = await this.authorizeProject(request.scope, writer)
      const table = await this.entries()
      const existing = table.get(recordKey) as MemoryEntry | undefined
      if (request.expectedRevision === undefined && existing !== undefined) {
        return { ok: false, code: 'memory_exists', reason: undefined }
      }
      if (request.expectedRevision !== undefined && existing === undefined) {
        return { ok: false, code: 'memory_not_found', reason: undefined }
      }
      if (request.expectedRevision !== undefined && existing !== undefined && existing.revision !== request.expectedRevision) {
        return { ok: false, code: 'memory_stale', reason: undefined }
      }
      if (existing === undefined && this.scopeSize(table, request.scope) >= this.limits.maxEntriesPerScope) {
        return { ok: false, code: 'memory_full', reason: undefined }
      }
      const attribution = {
        source: 'agent' as const,
        sessionId: writer.agent.id,
        ...(userId !== undefined ? { userId } : {}),
        at: new Date().toISOString(),
      }
      const entry: MemoryEntry = {
        scope: request.scope,
        key,
        kind: request.kind,
        summary: request.summary.trim(),
        content: request.content.trim(),
        revision: MemoryRevision(randomUUID()),
        created: existing === undefined ? attribution : existing.created,
        updated: attribution,
      }
      await table.put(recordKey, entry)
      this.ctx.emit('memory/changed', memoryScopeId(request.scope), entry.key)
      return existing === undefined
        ? { ok: true, operation: 'create', entry }
        : { ok: true, operation: 'update', entry, previous: existing }
    })
  }

  /**
   * Remove an entry. `expectedRevision` absent deletes unconditionally;
   * present deletes only on a match (`memory_stale` otherwise). A missing key
   * is always `memory_not_found`.
   * @param request - The delete input.
   * @param writer - Who is deleting.
   * @returns the removed entry, or a refusal.
   */
  delete(request: MemoryDeleteRequest, writer: MemoryWriter): Promise<MemoryWriteResult> {
    return this.serialize(async () => {
      const scopeError = this.scopeRefusal(request.scope, writer)
      if (scopeError !== undefined) return scopeError
      if (!KEY_PATTERN.test(request.key) || request.key.length > 64) {
        return { ok: false, code: 'memory_invalid', reason: 'key' }
      }
      const recordKey = memoryRecordKey(request.scope, MemoryKey(request.key))
      await this.authorizeProject(request.scope, writer)
      const table = await this.entries()
      const existing = table.get(recordKey) as MemoryEntry | undefined
      if (existing === undefined) return { ok: false, code: 'memory_not_found', reason: undefined }
      if (request.expectedRevision !== undefined && existing.revision !== request.expectedRevision) {
        return { ok: false, code: 'memory_stale', reason: undefined }
      }
      await table.delete(recordKey)
      this.ctx.emit('memory/changed', memoryScopeId(request.scope), existing.key)
      return { ok: true, operation: 'delete', entry: existing }
    })
  }

  /** Queue `work` behind the in-flight write; failures never wedge the chain. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(work, work)
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * Write-scope admission. In `personal` space only personal+workspace are
   * addressable; in `project` space only project. An agent writer may touch
   * only its own session's workspace scope.
   */
  private scopeRefusal(scope: MemoryScope, writer: MemoryWriter): MemoryWriteResult | undefined {
    const available = this.space === 'project'
      ? scope.kind === 'project'
      : scope.kind === 'personal' || scope.kind === 'workspace'
    if (!available) return { ok: false, code: 'memory_invalid', reason: 'scope-unavailable' }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- MemoryWriter is an open union; the workspace rule is agent-only.
    if (writer.kind === 'agent' && scope.kind === 'workspace') {
      const own = this.scopesFor(writer.agent).find(candidate => candidate.kind === 'workspace')
      if (own === undefined) return { ok: false, code: 'memory_invalid', reason: 'scope-unavailable' }
      if (own.directory !== scope.directory || own.sshTarget !== scope.sshTarget) {
        return { ok: false, code: 'memory_invalid', reason: 'workspace-mismatch' }
      }
    }
    return undefined
  }

  /** Field bounds for save; returns the first failing reason. */
  private validateSave(request: MemorySaveRequest):
    { ok: false; code: 'memory_invalid'; reason: MemoryInvalidReason } | undefined {
    if (!KEY_PATTERN.test(request.key) || request.key.length > 64) {
      return { ok: false, code: 'memory_invalid', reason: 'key' }
    }
    const summary = request.summary.trim()
    if (summary.length === 0 || summary.includes('\n') || summary.includes('\r')
      || Array.from(summary).length > this.limits.summaryMaxChars) {
      return { ok: false, code: 'memory_invalid', reason: 'summary' }
    }
    const content = request.content.trim()
    if (content.length === 0 || Buffer.byteLength(content, 'utf8') > this.limits.entryMaxBytes) {
      return { ok: false, code: 'memory_invalid', reason: 'content' }
    }
    return undefined
  }

  /**
   * Run the execution-authority check on an agent project write and return
   * the attested primary-actor user id for attribution. Personal/workspace
   * writes skip authorization; a missing provider under
   * `executionAuthorityRequired` throws `execution/forbidden`; a policy
   * denial propagates the authority's `RemoteError` unchanged.
   */
  private async authorizeProject(scope: MemoryScope, writer: MemoryWriter): Promise<number | undefined> {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- MemoryWriter is an open union; authorization is agent-only today.
    if (scope.kind !== 'project' || writer.kind !== 'agent') return undefined
    const state = await executionAuthorityOf(this.ctx)
      ?.authorize('memory', writer.agent, writer.signal)
    return state?.primaryActorUserId
  }

  /** Count live records of one scope (creates compare against the cap). */
  private scopeSize(table: KvTable<string, MemoryRecord>, scope: MemoryScope): number {
    const prefix = memoryScopePrefix(scope)
    let count = 0
    for (const recordKey of table.keys()) {
      if (recordKey.startsWith(prefix)) count += 1
    }
    return count
  }
}
