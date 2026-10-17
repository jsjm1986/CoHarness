/**
 * `@deepseek-ai/dsh-memory` — the host-plane durable memory service. It owns
 * the `memory` storage domain (one record per entry, `per-record` layout,
 * `backup-and-skip`), validates and serializes every write, resolves which
 * scopes a session may address, authorizes project writes through the
 * execution-authority capability, and ranks bounded search results.
 * @module @deepseek-ai/dsh-memory
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CollaborationError, collaborationRemoteRefusal, type CollaborationParticipant } from '@deepseek-ai/dsh-collaboration'
import { executionAuthorityOf } from '@deepseek-ai/dsh-execution-authority'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { rankEntries, summaryOf } from './search.ts'
import {
  memoryConsolidationCursorKey,
  memoryDomain,
  memoryRecordKey,
  memoryScopeId,
  memoryScopePrefix,
  type MemoryCursorRecord,
  type MemoryRecord,
} from './storage.ts'
import type {
  MemoryCursor,
  MemoryDeleteRequest,
  MemoryEntry,
  MemoryEntrySummary,
  MemoryInvalidReason,
  MemoryKey,
  MemoryReadRequest,
  MemoryRevision,
  MemorySaveRequest,
  MemoryScope,
  MemoryScopeCatalog,
  MemoryScopeRequest,
  MemoryScopeView,
  MemorySearchHit,
  MemoryWriteResult,
} from './types.ts'

export * from './types.ts'

/**
 * Who is writing. `agent` writes through the model tools under the
 * `memory` execution authorization; `member` writes through the browser
 * Remote methods under the captured collaboration participant — an absent
 * participant means a runtime with no collaboration provider, which keeps
 * owner semantics. `signal` is the agent operation's cancellation carried
 * into the project authorization call; `source` stamps `extraction` or
 * `consolidation` on curation writes and defaults to `agent`. Host-only
 * vocabulary: it names the `Agent` runtime type, so it is exported from
 * the service entry rather than the client-safe `./types`.
 */
export type MemoryWriter =
  | { readonly kind: 'agent'; readonly agent: Agent; readonly signal?: AbortSignal; readonly source?: 'extraction' | 'consolidation' }
  | { readonly kind: 'member'; readonly participant?: CollaborationParticipant }
export {
  memoryConsolidationCursorKey,
  memoryDomain,
  memoryExtractionCursorKey,
  memoryRecordKey,
  memoryScopeId,
  memoryScopePrefix,
} from './storage.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable memory service registered as `memory`; see {@link MemoryService}. */
    memory: MemoryService
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
  /** Enable the background extraction curation pass; default off. */
  extraction: boolean
  /** Enable the scheduled consolidation curation pass; default off. */
  consolidation: boolean
  /** Enable per-question recall injection in `memory-context`; default off. */
  recall: boolean
}

/**
 * The `memory` settings namespace owns the feature's master switch and the
 * three user-level curation/recall switches. Composition supplies the base
 * value; a settings provider may override it live. Curation and recall are
 * off by default.
 */
export const MEMORY_SETTINGS_NAMESPACE = settingsNamespace('memory')

/** Resolved feature switches from the `memory` settings namespace. */
export interface MemorySwitches {
  /** `false` hides the scopes from agents and refuses every write; stored entries stay readable. */
  readonly enabled: boolean
  /** Turn-end extraction curation pass. */
  readonly extraction: boolean
  /** Interval-gated consolidation curation pass. */
  readonly consolidation: boolean
  /** Per-question recall injection. */
  readonly recall: boolean
}

/** Schema of the `memory` settings section. */
export const MEMORY_SETTINGS_SCHEMA: z<MemorySwitches> = z.object({
  enabled: z.boolean().default(true),
  extraction: z.boolean().default(false),
  consolidation: z.boolean().default(false),
  recall: z.boolean().default(false),
})

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
 * The recall/extraction word proxy: whitespace-separated tokens plus each
 * Han ideograph as one unit, so CJK prose measures by characters the same
 * way Latin prose measures by words. Extraction and recall thresholds
 * consume this count, not raw length.
 * @param text - The prose to measure.
 * @returns the signal-word count.
 */
export function memorySignalWordCount(text: string): number {
  return text.match(/[^\s\p{Script=Han}]+|\p{Script=Han}/gu)?.length ?? 0
}

/**
 * Durable per-scope memory. Read paths (`scopesFor`, `read`, `list`,
 * `search`) are lock-free; writes serialize on a single chain inside the
 * service so create/duplicate, revision, and full checks stay atomic.
 *
 * The `memory/*` Remote methods serve the browser surface: reads are
 * member-wide inside a project runtime, while member writes capture the
 * request's collaboration participant and require `rw` project
 * membership — a runtime with no collaboration provider keeps owner
 * semantics. The `memory` settings section switches the whole feature
 * off: scopes vanish for agents and every write refuses
 * `scope-unavailable`, while stored entries stay readable for the owner.
 */
export default class MemoryService extends TypertRemoteService {
  static inject = ['storageDomain']

  /** Validated config bound to this runtime's space. */
  static Config: z<Config> = z.object({
    space: z.union(['personal', 'project']).default('personal'),
    entryMaxBytes: z.number().step(1).min(256).max(65536).default(8192),
    summaryMaxChars: z.number().step(1).min(20).max(500).default(150),
    maxEntriesPerScope: z.number().step(1).min(1).max(10000).default(200),
    searchMaxResults: z.number().step(1).min(1).max(50).default(10),
    extraction: z.boolean().default(false),
    consolidation: z.boolean().default(false),
    recall: z.boolean().default(false),
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

  /** Live feature-switch source; falls back to the composition entry. */
  private switchSource: () => MemorySwitches

  constructor(ctx: Context, config: Config) {
    super(ctx, 'memory')
    this.space = config.space
    this.limits = Object.freeze({
      entryMaxBytes: config.entryMaxBytes,
      summaryMaxChars: config.summaryMaxChars,
      maxEntriesPerScope: config.maxEntriesPerScope,
      searchMaxResults: config.searchMaxResults,
    })
    const entry: MemorySwitches = {
      enabled: true,
      extraction: config.extraction,
      consolidation: config.consolidation,
      recall: config.recall,
    }
    this.switchSource = () => entry
    installSettingsSection(ctx, MEMORY_SETTINGS_NAMESPACE, MEMORY_SETTINGS_SCHEMA, entry, {
      label: { en: 'Memory', zh: '记忆' },
      owner: 'project',
      projectWrite: 'manager',
      setSource: (source) => {
        this.switchSource = source
      },
      onChange: () => {
        /* Reads are per-decision through {@link switches}; nothing memoizes. */
      },
    })
    this.ready = ctx.storageDomain.open(memoryDomain)
    ctx.effect(async () => {
      const domain = await this.ready
      return ctx.effect(() => async () => { await domain.close() })
    })
  }

  /**
   * The resolved curation/recall switches. Consumers read this at each
   * decision point so a live settings change takes effect on the next pass.
   * @returns the active switch values.
   */
  switches(): MemorySwitches {
    return this.switchSource()
  }

  /** The open `entries` table. */
  private async entriesTable(): Promise<KvTable<string, MemoryRecord>> {
    return (await this.ready).table('entries')
  }

  /** The open `cursors` table. */
  private async cursorsTable(): Promise<KvTable<string, MemoryCursorRecord>> {
    return (await this.ready).table('cursors')
  }

  /**
   * The scopes this space offers a session. `personal` space returns the
   * personal scope plus, when the session header carries `cwd`, the workspace
   * scope keyed by `(cwd, sshTarget)`; `project` space returns the shared
   * project scope only. A disabled `memory` section offers nothing, which
   * empties the injected catalog and refuses every agent write.
   * @param agent - The session's agent.
   * @returns scopes in catalog order.
   */
  scopesFor(agent: Agent): readonly MemoryScope[] {
    if (!this.switchSource().enabled) return []
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
    return (await this.entriesTable()).get(memoryRecordKey(scope, key)) as MemoryEntry | undefined
  }

  /**
   * Catalog rows of one scope in catalog order: kind (guidance, profile,
   * background, resource), then `updated.at` desc, then key asc.
   * @param scope - The scope to list.
   * @returns the ordered catalog rows (entries without bodies).
   */
  async list(scope: MemoryScope): Promise<MemoryEntrySummary[]> {
    return (await this.entries(scope)).map(summaryOf)
  }

  /**
   * Full entries of one scope in catalog order — the same order as
   * {@link list}. Consolidation uses this for its content digest and the
   * whole-scope review input.
   * @param scope - The scope to list.
   * @returns the ordered entries with bodies.
   */
  async entries(scope: MemoryScope): Promise<MemoryEntry[]> {
    const prefix = memoryScopePrefix(scope)
    const entries: MemoryEntry[] = []
    for (const [recordKey, entry] of (await this.entriesTable()).entries()) {
      if (recordKey.startsWith(prefix)) entries.push(entry as MemoryEntry)
    }
    entries.sort((a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
      || b.updated.at.localeCompare(a.updated.at)
      || a.key.localeCompare(b.key))
    return entries
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
    for (const [recordKey, entry] of (await this.entriesTable()).entries()) {
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
   * @param writer - Who is writing (agent or member).
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
      const userId = await this.authorizeWrite(request.scope, writer)
      const table = await this.entriesTable()
      const existing = table.get(recordKey) as MemoryEntry | undefined
      if (request.expectedRevision === undefined && existing !== undefined) {
        return { ok: false, code: 'memory_exists' }
      }
      if (request.expectedRevision !== undefined && existing === undefined) {
        return { ok: false, code: 'memory_not_found' }
      }
      if (request.expectedRevision !== undefined && existing !== undefined && existing.revision !== request.expectedRevision) {
        return { ok: false, code: 'memory_stale' }
      }
      if (existing === undefined && this.scopeSize(table, request.scope) >= this.limits.maxEntriesPerScope) {
        return { ok: false, code: 'memory_full' }
      }
      const attribution: MemoryEntry['updated'] = writer.kind === 'agent'
        ? {
          source: writer.source ?? 'agent',
          sessionId: writer.agent.id,
          ...(userId !== undefined ? { userId } : {}),
          at: new Date().toISOString(),
        }
        : {
          source: 'member' as const,
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
      await this.noteScopeChange(request.scope)
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
      await this.authorizeWrite(request.scope, writer)
      const table = await this.entriesTable()
      const existing = table.get(recordKey) as MemoryEntry | undefined
      if (existing === undefined) return { ok: false, code: 'memory_not_found' }
      if (request.expectedRevision !== undefined && existing.revision !== request.expectedRevision) {
        return { ok: false, code: 'memory_stale' }
      }
      await table.delete(recordKey)
      await this.noteScopeChange(request.scope)
      this.ctx.emit('memory/changed', memoryScopeId(request.scope), existing.key)
      return { ok: true, operation: 'delete', entry: existing }
    })
  }

  /**
   * The member-facing scope catalog. In `personal` space it lists the
   * personal scope plus every workspace scope that holds entries; in
   * `project` space the shared project scope alone. Each view answers
   * whether the calling member may write it, so the browser only offers
   * edit controls the caller is entitled to.
   * @returns the scope catalog plus the `memory` section's enabled flag.
   */
  @Remote('scopes')
  async memberScopes(): Promise<MemoryScopeCatalog> {
    const enabled = this.switchSource().enabled
    const scopes: MemoryScopeView[] = []
    const view = (scope: MemoryScope, entries: number): MemoryScopeView => ({
      scope, writable: this.memberWritable(scope, enabled), entries,
    })
    if (this.space === 'project') {
      const table = await this.entriesTable()
      return { enabled, scopes: [view({ kind: 'project' }, this.scopeSize(table, { kind: 'project' }))] }
    }
    const workspaces = new Map<string, { scope: MemoryScope; entries: number }>()
    let personalEntries = 0
    for (const [, record] of (await this.entriesTable()).entries()) {
      const scope = (record as MemoryEntry).scope
      /* v8 ignore next -- the write boundary refuses project records into a personal-runtime table. */
      if (scope.kind !== 'personal' && scope.kind !== 'workspace') continue
      if (scope.kind === 'personal') personalEntries += 1
      else {
        const id = memoryScopeId(scope)
        const known = workspaces.get(id)
        if (known === undefined) workspaces.set(id, { scope, entries: 1 })
        else workspaces.set(id, { scope, entries: known.entries + 1 })
      }
    }
    scopes.push(view({ kind: 'personal' }, personalEntries))
    for (const workspace of workspaces.values()) scopes.push(view(workspace.scope, workspace.entries))
    return { enabled, scopes }
  }

  /**
   * Read one scope's entries for the member browser surface. Reads are
   * member-wide inside a project runtime; a scope the space does not offer
   * simply has no records, so the answer is an empty list rather than a
   * refusal.
   * @param request - the scope to list.
   * @returns every stored entry, content included, in catalog order.
   */
  @Remote('list')
  async memberList(request: MemoryScopeRequest): Promise<MemoryEntry[]> {
    if (!this.scopeOffered(request.scope)) return []
    return this.entries(request.scope)
  }

  /**
   * Read one entry's full body for the member browser surface.
   * @param request - the scope and raw key to read.
   * @returns the stored entry, or undefined for a missing or out-of-space key.
   */
  @Remote('read')
  async memberRead(request: MemoryReadRequest): Promise<MemoryEntry | undefined> {
    if (!this.scopeOffered(request.scope)) return undefined
    return this.read(request.scope, request.key)
  }

  /**
   * Create or replace one entry as the calling member. The service
   * captures the request's collaboration participant itself: `rw` project
   * membership is required for the project scope, and a runtime with no
   * collaboration provider keeps owner semantics. Validation, revision,
   * and capacity refusals return in the ordinary write result; a missing
   * principal or read-only membership rejects with the shared
   * `collaboration-forbidden` refusal.
   * @param request - the save input.
   * @returns the committed entry and the replaced record, or a refusal.
   */
  @Remote('save')
  async memberSave(request: MemorySaveRequest): Promise<MemoryWriteResult> {
    return this.save(request, this.memberWriter())
  }

  /**
   * Remove one entry as the calling member, under the same participant
   * rules as {@link memberSave}.
   * @param request - the delete input.
   * @returns the removed entry, or a refusal.
   */
  @Remote('delete')
  async memberDelete(request: MemoryDeleteRequest): Promise<MemoryWriteResult> {
    return this.delete(request, this.memberWriter())
  }

  /**
   * Whether the space offers a scope to member reads at all, independent
   * of the `memory` section's enabled flag — a disabled feature hides its
   * scopes from agents but keeps stored entries inspectable.
   */
  private scopeOffered(scope: MemoryScope): boolean {
    return this.space === 'project'
      ? scope.kind === 'project'
      : scope.kind === 'personal' || scope.kind === 'workspace'
  }

  /**
   * Resolve the member writer for one Remote write call. A runtime with no
   * collaboration provider is the owner's, so the writer carries no
   * participant; a capture failure means no verified caller stands behind
   * the call and rejects with the shared refusal.
   */
  private memberWriter(): MemoryWriter {
    const collaboration = this.ctx.get('collaboration')
    if (collaboration === undefined) return { kind: 'member' }
    try {
      return { kind: 'member', participant: collaboration.capture().participant }
    } catch (error: unknown) {
      throw collaborationRemoteRefusal(error, 'write')
    }
  }

  /**
   * Whether the member behind the current Remote call may write `scope`.
   * Mirrors {@link memberWriter}: absent collaboration means the owner,
   * a capture failure means no verified caller — not writable.
   */
  private memberWritable(scope: MemoryScope, enabled: boolean): boolean {
    if (!enabled) return false
    const collaboration = this.ctx.get('collaboration')
    if (collaboration === undefined) return true
    let participant: CollaborationParticipant
    try {
      participant = collaboration.capture().participant
    } catch {
      // No verified request principal: the caller is not entitled to write.
      return false
    }
    return scope.kind === 'project'
      ? participant.scope.kind === 'project' && participant.scope.mode === 'rw'
      : participant.scope.kind === 'personal'
  }

  /**
   * Read a durable curation cursor by its record key. Cursors live in the
   * memory domain's `cursors` table so the service stays the sole write
   * owner; the caller chooses the key via the exported helpers.
   * @param key - Cursor record key (see {@link memoryExtractionCursorKey} / {@link memoryConsolidationCursorKey}).
   * @returns the stored cursor, if any.
   */
  async getCursor(key: string): Promise<MemoryCursor | undefined> {
    const record = (await this.cursorsTable()).get(key)
    if (record === undefined) return undefined
    return { ...record }
  }

  /**
   * Commit a curation cursor, serialized on the same write chain as entry
   * writes so an interleaved save cannot lose the advancement.
   * @param key - Cursor record key.
   * @param cursor - The complete next cursor record.
   */
  async writeCursor(key: string, cursor: MemoryCursor): Promise<void> {
    await this.serialize(async () => {
      await (await this.cursorsTable()).put(key, { ...cursor })
    })
  }

  /**
   * Bump the consolidation `changedSince` counter for one scope inside the
   * current serialized write. Runs only after the entry mutation commits.
   */
  private async noteScopeChange(scope: MemoryScope): Promise<void> {
    const key = memoryConsolidationCursorKey(scope)
    const cursors = await this.cursorsTable()
    const existing = cursors.get(key)
    await cursors.put(key, { ...existing, changedSince: (existing?.changedSince ?? 0) + 1 })
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
   * only its own session's workspace scope; a member writer reaches every
   * workspace scope the personal space lists. A disabled `memory` section
   * offers no scope at all.
   */
  private scopeRefusal(scope: MemoryScope, writer: MemoryWriter): MemoryWriteResult | undefined {
    const available = this.switchSource().enabled && (this.space === 'project'
      ? scope.kind === 'project'
      : scope.kind === 'personal' || scope.kind === 'workspace')
    if (!available) return { ok: false, code: 'memory_invalid', reason: 'scope-unavailable' }
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
   * Authorize one write and return the user id recorded in attribution.
   * An agent's project write runs the `memory` execution-authority check —
   * a missing provider under `executionAuthorityRequired` throws
   * `execution/forbidden`, and a policy denial (a member who lost the
   * grant, or a private conversation, which is read-only for project
   * memory) propagates the authority's `RemoteError` unchanged. A member
   * write needs a captured collaboration participant: `rw` project
   * membership for the project scope, the personal participant for
   * personal/workspace scopes, and nothing when the runtime has no
   * collaboration provider — owner semantics. Every denial throws the
   * shared `collaboration-forbidden` refusal rather than a refusal result,
   * because the caller is not entitled to the write at all.
   */
  private async authorizeWrite(scope: MemoryScope, writer: MemoryWriter): Promise<number | undefined> {
    if (writer.kind === 'agent') {
      if (scope.kind !== 'project') return undefined
      const state = await executionAuthorityOf(this.ctx)
        ?.authorize('memory', writer.agent, writer.signal)
      return state?.primaryActorUserId
    }
    const participant = writer.participant
    if (participant === undefined) return undefined
    if (scope.kind === 'project'
      ? participant.scope.kind !== 'project' || participant.scope.mode !== 'rw'
      : participant.scope.kind !== 'personal') {
      throw collaborationRemoteRefusal(new CollaborationError('forbidden'), 'write')
    }
    return participant.userId
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
