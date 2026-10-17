/**
 * Memory entry vocabulary shared by the service, its storage schema, and the
 * agent-plane consumers. Types only — no runtime code.
 * @module @deepseek-ai/dsh-memory/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Emitted after a memory write commits. Consumers re-read through the
     * service; the payload names the touched scope id and key only.
     * @mode emit
     * @param scope - The scope id of the written entry.
     * @param key - The entry key.
     */
    'memory/changed'(scope: string, key: string): void
  }
}

/**
 * Which scope families a runtime offers, selected by the `space` config:
 * `personal` runtimes offer personal plus per-directory workspace scopes,
 * `project` runtimes offer one shared project scope.
 */
export type MemoryScopeKind = 'personal' | 'workspace' | 'project'

/**
 * One addressing unit for memory entries. `personal` covers facts about the
 * user that apply in every workspace; `workspace` covers facts specific to
 * one working directory on one execution target (`directory` is the session
 * header's `cwd`, `sshTarget` its managed SSH target id when present, so an
 * SSH directory never aliases a host directory); `project` is the shared
 * scope of a managed project runtime.
 */
export type MemoryScope =
  | { readonly kind: 'personal' }
  | { readonly kind: 'workspace'; readonly directory: string; readonly sshTarget?: number }
  | { readonly kind: 'project' }

/**
 * The closed fact classification. `profile` records who the user or team is;
 * `guidance` records how the agent should work, with the reason; `background`
 * records goals, constraints, decisions, and deadlines the code does not
 * show; `resource` records where outside information lives.
 */
export type MemoryKind = 'profile' | 'guidance' | 'background' | 'resource'

/** Stable per-scope entry identity: lowercase letters, digits, single hyphens, at most 64 characters. */
export type MemoryKey = Branded<'MemoryKey'>

/** Opaque write-generation token; a new value is minted on every write. */
export type MemoryRevision = Branded<'MemoryRevision'>

/**
 * Who produced one entry version. `sessionId` records the writing Session
 * when the runtime knows it; `userId` records the public user id the
 * execution authority attested on an authorized project write; `at` is the
 * ISO-8601 UTC instant at millisecond precision.
 */
export interface MemoryAttribution {
  readonly source: 'agent' | 'extraction' | 'consolidation' | 'member'
  readonly sessionId?: SessionId
  readonly userId?: number
  readonly at: string
}

/** One durable memory entry: the catalog row plus its full Markdown body and change metadata. */
export interface MemoryEntry {
  readonly scope: MemoryScope
  readonly key: MemoryKey
  readonly kind: MemoryKind
  readonly summary: string
  readonly content: string
  readonly revision: MemoryRevision
  readonly created: MemoryAttribution
  readonly updated: MemoryAttribution
}

/** A catalog row: the entry without its body. */
export type MemoryEntrySummary = Omit<MemoryEntry, 'content'>

/** One ranked search result: the catalog row, a bounded content excerpt, and the relevance score. */
export interface MemorySearchHit {
  readonly entry: MemoryEntrySummary
  readonly excerpt: string
  readonly score: number
}

/** Validated save input. `expectedRevision` absent means create-only; present means replace-only. */
export interface MemorySaveRequest {
  scope: MemoryScope
  key: string
  kind: MemoryKind
  summary: string
  content: string
  expectedRevision?: MemoryRevision
}

/** Validated delete input; `expectedRevision` guards against removing a newer change. */
export interface MemoryDeleteRequest {
  scope: MemoryScope
  key: string
  expectedRevision?: MemoryRevision
}

/** Stable machine-routable refusal classes returned by {@link MemoryWriteResult}; never parse messages. */
export type MemoryRefusalCode = 'memory_exists' | 'memory_not_found' | 'memory_stale' | 'memory_full' | 'memory_invalid'

/**
 * The write outcome. `operation` distinguishes create from replace for save
 * and carries the removed record for delete; `previous` holds the replaced
 * record on update only. Refusals carry the failure class; `reason` is set
 * only for `memory_invalid`.
 */
export type MemoryWriteResult =
  | { readonly ok: true; readonly operation: 'create' | 'update' | 'delete'; readonly entry: MemoryEntry; readonly previous?: MemoryEntry }
  | { readonly ok: false; readonly code: MemoryRefusalCode; readonly reason?: MemoryInvalidReason }

/** Which write rule rejected a `memory_invalid` request; set only for that code. */
export type MemoryInvalidReason = 'key' | 'summary' | 'content' | 'query' | 'scope-unavailable' | 'workspace-mismatch'

/**
 * One scope as the member-facing browser surface sees it: the addressing
 * unit, whether the calling member may create, edit, and delete inside it,
 * and its live entry count. `writable` is `false` for a read-only project
 * member, for a member call without a bound request principal, and while
 * the `memory` settings section disables the feature.
 */
export interface MemoryScopeView {
  readonly scope: MemoryScope
  readonly writable: boolean
  readonly entries: number
}

/**
 * The scope catalog the `memory/scopes` Remote method serves. `enabled`
 * mirrors the `memory` settings section so the browser can explain why
 * every `writable` flag is down; in a `personal` runtime `scopes` lists
 * the personal scope plus each workspace scope that holds entries, and in
 * a `project` runtime it lists the shared project scope alone.
 */
export interface MemoryScopeCatalog {
  readonly enabled: boolean
  readonly scopes: readonly MemoryScopeView[]
}

/** Wire request selecting one scope for the member `list` method. */
export interface MemoryScopeRequest {
  readonly scope: MemoryScope
}

/** Wire request selecting one entry for the member `read` method. */
export interface MemoryReadRequest {
  readonly scope: MemoryScope
  readonly key: string
}
