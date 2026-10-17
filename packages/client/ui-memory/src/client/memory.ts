/**
 * Memory page view model: scope identity, kind grouping, search filtering,
 * and attribution labels — pure functions over wire types.
 */
import type {
  MemoryAttribution, MemoryEntry, MemoryKind, MemoryScope, MemoryScopeView,
} from '@deepseek-ai/dsh-memory/client'

/**
 * Stable per-scope selection key; unique across every scope a catalog offers.
 * @param scope - the scope to identify.
 * @returns the key a `MemorySnapshot` stores as `selected`.
 */
export function scopeKeyOf(scope: MemoryScope): string {
  switch (scope.kind) {
    case 'personal': return 'personal'
    case 'project': return 'project'
    case 'workspace': return `workspace:${scope.sshTarget ?? ''}:${scope.directory}`
  }
}

/**
 * The locale key naming one scope kind; workspace scopes append their directory.
 * @param scope - the scope being labelled.
 * @returns the kind's copy key, or undefined when the scope needs its own caption.
 */
export function scopeLabelKey(scope: MemoryScope): 'scope.personal' | 'scope.project' | undefined {
  if (scope.kind === 'personal') return 'scope.personal'
  if (scope.kind === 'project') return 'scope.project'
  return undefined
}

/**
 * Short scope caption: the workspace basename, or undefined for fixed scopes.
 * @param scope - the scope being captioned.
 * @returns the directory's leaf segment for workspaces.
 */
export function scopeCaption(scope: MemoryScope): string | undefined {
  if (scope.kind !== 'workspace') return undefined
  const trimmed = scope.directory.replace(/[/\\]+$/, '')
  const leaf = trimmed.split(/[/\\]/).pop()
  return leaf === undefined || leaf === '' ? scope.directory : leaf
}

/**
 * Full scope title: the workspace path, or undefined for fixed scopes.
 * @param scope - the scope being titled.
 * @returns the untrimmed directory for workspaces.
 */
export function scopeTitle(scope: MemoryScope): string | undefined {
  return scope.kind === 'workspace' ? scope.directory : undefined
}

/** Catalog display order for kind groups. */
export const MEMORY_KINDS: readonly MemoryKind[] = ['guidance', 'profile', 'background', 'resource']

/** One rendered section: a kind header plus its entries in catalog order. */
export interface MemorySection {
  readonly kind: MemoryKind
  readonly rows: readonly MemoryEntry[]
}

/**
 * Group entries into kind sections in catalog order, dropping empty kinds.
 * @param entries - scope entries already filtered by search.
 * @returns sections in `MEMORY_KINDS` order.
 */
export function groupEntries(entries: readonly MemoryEntry[]): MemorySection[] {
  return MEMORY_KINDS.flatMap((kind) => {
    const rows = entries.filter(entry => entry.kind === kind)
    return rows.length === 0 ? [] : [{ kind, rows }]
  })
}

/**
 * Client-side filter over key, summary, and content, case-insensitive.
 * @param entries - scope entries.
 * @param query - raw search text; blank keeps everything.
 * @returns the matching subset in input order.
 */
export function filterEntries(entries: readonly MemoryEntry[], query: string): MemoryEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...entries]
  return entries.filter(entry =>
    entry.key.toLowerCase().includes(needle)
    || entry.summary.toLowerCase().includes(needle)
    || entry.content.toLowerCase().includes(needle))
}

/** One rendered timeline section: a day key plus its entries, newest first. */
export interface MemoryDaySection {
  /** `YYYY-MM-DD` of the section's day, used as the React key and the today check. */
  readonly day: string
  readonly rows: readonly MemoryEntry[]
}

/** The local `YYYY-MM-DD` of an attribution timestamp, for day grouping. */
function dayOf(iso: string): string {
  const date = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Group entries into day sections newest-first for the timeline tab. Entries
 * sort by `updated.at` descending inside and across sections; equal stamps
 * keep catalog order.
 * @param entries - scope entries already filtered by search.
 * @returns day sections newest-first.
 */
export function groupEntriesByDay(entries: readonly MemoryEntry[]): MemoryDaySection[] {
  const sorted = [...entries].sort((a, b) => Date.parse(b.updated.at) - Date.parse(a.updated.at))
  const byDay = new Map<string, MemoryEntry[]>()
  for (const entry of sorted) {
    const day = dayOf(entry.updated.at)
    const rows = byDay.get(day)
    if (rows === undefined) byDay.set(day, [entry])
    else rows.push(entry)
  }
  return [...byDay].map(([day, rows]) => ({ day, rows }))
}

/**
 * Find the scope view carrying `key`, falling back to the first offered scope.
 * @param views - the catalog's scope list.
 * @param key - the selection key produced by {@link scopeKeyOf}.
 * @returns the selected view, or undefined when the catalog is empty.
 */
export function selectedScope(views: readonly MemoryScopeView[], key: string | undefined): MemoryScopeView | undefined {
  return views.find(view => scopeKeyOf(view.scope) === key) ?? views[0]
}

/**
 * The locale key for an attribution's write source.
 * @param source - who wrote the entry.
 * @returns the copy key under the `entry.source` group.
 */
export function sourceLabelKey(source: MemoryAttribution['source']): `entry.source.${MemoryAttribution['source']}` {
  return `entry.source.${source}`
}

/**
 * First content line for row previews, bounded so a huge entry stays a preview.
 * @param content - the entry's Markdown body.
 * @returns at most 160 characters, ellipsis-marked when truncated.
 */
export function contentPreview(content: string): string {
  const text = content.trim()
  return text.length <= 160 ? text : `${text.slice(0, 160)}…`
}
