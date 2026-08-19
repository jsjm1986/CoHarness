/**
 * Client-side filter, sort, page, and selection helpers for the document manager.
 * The Host list endpoint returns the full store; this module never talks to HTTP.
 */
import { getDateGroup } from './format.ts'

/** Rows shown on one manager page. */
export const PAGE_SIZE = 20

/** Document fields needed to filter, sort, and group a row. */
export interface ListingDoc {
  docId: string
  name: string
  bytes: number
  mediaType: string
  modifiedAt: number
}

/** Type chip value, including the unfiltered option. */
export type DocumentTypeFilter = 'all' | DocumentTypeBucket

/** Presentation bucket derived from `mediaType`. */
export type DocumentTypeBucket = 'image' | 'pdf' | 'text' | 'other'

/** Column the manager can order by. */
export type DocumentSortKey = 'date' | 'name' | 'size'

/** Sort direction. */
export type DocumentSortDir = 'asc' | 'desc'

/** Combined sort applied after filtering. */
export interface DocumentSort {
  key: DocumentSortKey
  dir: DocumentSortDir
}

/** Date-grouped slice of a date-sorted list. */
export interface DatedDocGroup<T extends ListingDoc = ListingDoc> {
  date: string
  documents: T[]
}

/** Header-checkbox tri-state for the current page. */
export type PageSelectionState = 'none' | 'some' | 'all'

const TEXT_MEDIA = new Set(['application/json', 'application/xml'])

/* v8 ignore next -- closed DocumentSortKey union */
function assertNever(value: never): never {
  throw new Error(`unexpected listing discriminant: ${String(value)}`)
}

/**
 * Map a media type onto a type-filter chip.
 * @param mediaType - `UserDocRef.mediaType` from the list payload.
 * @returns image, pdf, text (including JSON and XML), or other.
 */
export function documentTypeBucket(mediaType: string): DocumentTypeBucket {
  if (mediaType.startsWith('image/')) return 'image'
  if (mediaType === 'application/pdf') return 'pdf'
  if (mediaType.startsWith('text/') || TEXT_MEDIA.has(mediaType)) return 'text'
  return 'other'
}

/**
 * Keep documents whose name matches `query` and whose type matches `type`.
 * @param documents - full list from the current store.
 * @param query - case-insensitive name substring; empty keeps every name.
 * @param type - chip value; `all` skips the type check.
 * @returns a new array in the input order.
 */
export function filterDocuments<T extends ListingDoc>(
  documents: readonly T[],
  query: string,
  type: DocumentTypeFilter,
): T[] {
  const needle = query.trim().toLowerCase()
  return documents.filter((doc) => {
    if (needle !== '' && !doc.name.toLowerCase().includes(needle)) return false
    if (type !== 'all' && documentTypeBucket(doc.mediaType) !== type) return false
    return true
  })
}

/**
 * Order documents by modification time, display name, or byte size.
 * @param documents - filtered list.
 * @param sort - column and direction; date desc is the manager default.
 * @returns a new array. Equal values retain their input order.
 */
export function sortDocuments<T extends ListingDoc>(
  documents: readonly T[],
  sort: DocumentSort,
): T[] {
  return documents
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      let cmp = 0
      switch (sort.key) {
        case 'date':
          cmp = a.item.modifiedAt - b.item.modifiedAt
          break
        case 'name':
          cmp = a.item.name.localeCompare(b.item.name)
          break
        case 'size':
          cmp = a.item.bytes - b.item.bytes
          break
        /* v8 ignore next -- closed DocumentSortKey union */
        default:
          assertNever(sort.key)
      }
      if (cmp === 0) return a.index - b.index
      return sort.dir === 'asc' ? cmp : -cmp
    })
    .map(entry => entry.item)
}

/**
 * Number of pages for a filtered length.
 * @param length - filtered document count.
 * @param pageSize - rows per page; defaults to {@link PAGE_SIZE}.
 * @returns at least 1 so an empty list still clamps to page 1.
 */
export function pageCount(length: number, pageSize: number = PAGE_SIZE): number {
  if (length <= 0) return 1
  return Math.ceil(length / pageSize)
}

/**
 * Force a 1-based page index into the valid range for `length`.
 * @param page - requested page.
 * @param length - filtered document count.
 * @param pageSize - rows per page; defaults to {@link PAGE_SIZE}.
 * @returns 1 when the list is empty or `page` is below 1; last page when `page` overflows.
 */
export function clampPage(page: number, length: number, pageSize: number = PAGE_SIZE): number {
  const pages = pageCount(length, pageSize)
  if (page < 1) return 1
  if (page > pages) return pages
  return page
}

/**
 * Take one page of an already filtered and sorted list.
 * @param items - filtered+sorted documents.
 * @param page - 1-based page; clamped when empty or past the end.
 * @param pageSize - rows per page; defaults to {@link PAGE_SIZE}.
 * @returns the slice for that page.
 */
export function pageSlice<T>(items: readonly T[], page: number, pageSize: number = PAGE_SIZE): T[] {
  const current = clampPage(page, items.length, pageSize)
  const start = (current - 1) * pageSize
  return items.slice(start, start + pageSize)
}

/**
 * Group a date-sorted page by modification date.
 * @param documents - current page, already ordered.
 * @returns groups in encounter order; invalid timestamps use `Unknown`.
 */
export function groupDocumentsByDate<T extends ListingDoc>(documents: readonly T[]): DatedDocGroup<T>[] {
  const groups: DatedDocGroup<T>[] = []
  const seen = new Map<string, DatedDocGroup<T>>()
  for (const item of documents) {
    const date = getDateGroup(item.modifiedAt)
    let group = seen.get(date)
    if (group === undefined) {
      group = { date, documents: [] }
      seen.set(date, group)
      groups.push(group)
    }
    group.documents.push(item)
  }
  return groups
}

/**
 * Drop selected ids that are not in the current filtered id list.
 * @param selected - ids checked across pages.
 * @param visibleIds - ids remaining after the latest query/type filter.
 * @returns a new set containing only still-visible ids.
 */
export function pruneSelection(
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
): Set<string> {
  const visible = new Set(visibleIds)
  const next = new Set<string>()
  for (const id of selected) {
    if (visible.has(id)) next.add(id)
  }
  return next
}

/**
 * Header-checkbox state for the documents on the current page.
 * @param pageIds - ids rendered on this page.
 * @param selected - ids checked across pages.
 * @returns `none` when the page is empty or nothing on it is selected.
 */
export function pageSelectionState(
  pageIds: readonly string[],
  selected: ReadonlySet<string>,
): PageSelectionState {
  if (pageIds.length === 0) return 'none'
  let selectedCount = 0
  for (const id of pageIds) {
    if (selected.has(id)) selectedCount += 1
  }
  if (selectedCount === 0) return 'none'
  if (selectedCount === pageIds.length) return 'all'
  return 'some'
}
