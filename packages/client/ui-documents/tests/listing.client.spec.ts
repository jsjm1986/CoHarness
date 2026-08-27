import { describe, expect, it } from 'vitest'
import {
  PAGE_SIZE,
  clampPage,
  documentTypeBucket,
  filterDocuments,
  groupDocumentsByDate,
  pageCount,
  pageSelectionState,
  pageSlice,
  pruneSelection,
  sortDocuments,
  type ListingDoc,
} from '../src/client/listing.ts'

function doc(ref: Partial<ListingDoc> & Pick<ListingDoc, 'docId' | 'name'>): ListingDoc {
  return {
    bytes: 100,
    mediaType: 'text/plain',
    modifiedAt: Date.UTC(2026, 7, 1),
    ...ref,
  }
}

const mixed: ListingDoc[] = [
  doc({ docId: 'archive/brief.txt', name: 'brief.txt', bytes: 21, mediaType: 'text/plain', modifiedAt: Date.UTC(2026, 7, 14, 12) }),
  doc({ docId: 'notes.txt', name: 'notes.txt', bytes: 30_720, mediaType: 'text/plain', modifiedAt: Date.UTC(2026, 7, 16, 12) }),
  doc({ docId: 'photos/photo.png', name: 'photo.png', bytes: 4096, mediaType: 'image/png', modifiedAt: Date.UTC(2026, 7, 18, 10) }),
  doc({ docId: 'reports/spec.pdf', name: 'spec.pdf', bytes: 2048, mediaType: 'application/pdf', modifiedAt: Date.UTC(2026, 7, 18, 11) }),
  doc({ docId: 'blob.bin', name: 'blob.bin', bytes: 8, mediaType: 'application/octet-stream', modifiedAt: Date.UTC(2026, 7, 19, 10) }),
  doc({ docId: 'data/data.json', name: 'data.json', bytes: 12, mediaType: 'application/json', modifiedAt: Date.UTC(2026, 7, 19, 11) }),
]

describe('documentTypeBucket', () => {
  it('classifies image, pdf, text family, and other', () => {
    expect(documentTypeBucket('image/png')).toBe('image')
    expect(documentTypeBucket('application/pdf')).toBe('pdf')
    expect(documentTypeBucket('text/plain')).toBe('text')
    expect(documentTypeBucket('application/json')).toBe('text')
    expect(documentTypeBucket('application/xml')).toBe('text')
    expect(documentTypeBucket('application/x-yaml')).toBe('text')
    expect(documentTypeBucket('application/javascript')).toBe('text')
    expect(documentTypeBucket('application/vnd.api+json')).toBe('text')
    expect(documentTypeBucket('application/octet-stream')).toBe('other')
  })
})

describe('filterDocuments', () => {
  it('filters by name substring without regard to case', () => {
    expect(filterDocuments(mixed, 'NOTE', 'all').map(d => d.name)).toEqual(['notes.txt'])
  })

  it('filters by type bucket independently of the name query', () => {
    expect(filterDocuments(mixed, '', 'image').map(d => d.name)).toEqual(['photo.png'])
    expect(filterDocuments(mixed, '', 'pdf').map(d => d.name)).toEqual(['spec.pdf'])
    expect(filterDocuments(mixed, '', 'text').map(d => d.name)).toEqual(['brief.txt', 'notes.txt', 'data.json'])
    expect(filterDocuments(mixed, '', 'other').map(d => d.name)).toEqual(['blob.bin'])
  })

  it('applies name and type together', () => {
    expect(filterDocuments(mixed, 'spec', 'pdf').map(d => d.name)).toEqual(['spec.pdf'])
    expect(filterDocuments(mixed, 'spec', 'image')).toEqual([])
  })
})

describe('sortDocuments', () => {
  it('sorts by modification time independently of the document id', () => {
    expect(sortDocuments(mixed, { key: 'date', dir: 'desc' }).map(d => d.docId)).toEqual([
      'data/data.json',
      'blob.bin',
      'reports/spec.pdf',
      'photos/photo.png',
      'notes.txt',
      'archive/brief.txt',
    ])
  })

  it('sorts by name and size in either direction', () => {
    expect(sortDocuments(mixed, { key: 'name', dir: 'asc' }).map(d => d.name)).toEqual([
      'blob.bin', 'brief.txt', 'data.json', 'notes.txt', 'photo.png', 'spec.pdf',
    ])
    expect(sortDocuments(mixed, { key: 'size', dir: 'desc' }).map(d => d.name)).toEqual([
      'notes.txt', 'photo.png', 'spec.pdf', 'brief.txt', 'data.json', 'blob.bin',
    ])
  })
})

describe('pagination', () => {
  it('exposes a page size of 20', () => {
    expect(PAGE_SIZE).toBe(20)
  })

  it('counts pages and clamps an empty or overflow page', () => {
    expect(pageCount(0)).toBe(1)
    expect(pageCount(20)).toBe(1)
    expect(pageCount(21)).toBe(2)
    expect(clampPage(1, 0)).toBe(1)
    expect(clampPage(9, 21)).toBe(2)
    expect(clampPage(0, 21)).toBe(1)
  })

  it('slices the requested page', () => {
    const items = Array.from({ length: 21 }, (_, i) => i)
    expect(pageSlice(items, 1)).toEqual(items.slice(0, 20))
    expect(pageSlice(items, 2)).toEqual([20])
  })
})

describe('groupDocumentsByDate', () => {
  it('groups in list order by modification date', () => {
    const grouped = groupDocumentsByDate([
      mixed[2]!,
      mixed[3]!,
      mixed[0]!,
    ])
    expect(grouped.map(g => g.date)).toEqual(['2026-08-18', '2026-08-14'])
    expect(grouped[0]?.documents.map(d => d.name)).toEqual(['photo.png', 'spec.pdf'])
  })
})

describe('selection', () => {
  it('prunes ids that are no longer in the visible set', () => {
    const next = pruneSelection(new Set(['a', 'b', 'c']), ['a', 'c'])
    expect([...next].sort()).toEqual(['a', 'c'])
  })

  it('reports none, some, or all of the current page selected', () => {
    const selected = new Set(['a', 'b'])
    expect(pageSelectionState(['a', 'b'], selected)).toBe('all')
    expect(pageSelectionState(['a', 'c'], selected)).toBe('some')
    expect(pageSelectionState(['c', 'd'], selected)).toBe('none')
    expect(pageSelectionState([], selected)).toBe('none')
  })
})
