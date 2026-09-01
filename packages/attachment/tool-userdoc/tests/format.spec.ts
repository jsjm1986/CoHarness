import { describe, expect, it } from 'vitest'
import { UserDocId, type UserDocRef } from '@deepseek-ai/dsh-userdoc'
import {
  MAX_DIRECTORY_LENGTH,
  MAX_DOCUMENT_ID_LENGTH,
  MAX_PAGE_OFFSET,
  MAX_QUERY_LENGTH,
  boundOutput,
  formatList,
  formatRead,
  inDirectory,
  matchesQuery,
  nonNegativeInteger,
  normalizeDirectory,
  normalizeDocumentId,
  normalizeQuery,
  orderRows,
  positiveInteger,
  rowFor,
  type PersonalDocumentRow,
} from '../src/format.ts'

const ref = (docId: string, name = docId, modifiedAt = 0): UserDocRef => ({
  docId: UserDocId(docId),
  path: `/private/documents/${docId}`,
  name,
  bytes: 3,
  mediaType: 'text/plain',
  modifiedAt,
})

const row = (docId: string, name = docId, modifiedAt = 0): PersonalDocumentRow => rowFor(ref(docId, name, modifiedAt))

describe('personal-document formatting helpers', () => {
  it('normalizes query, directory, and document identifiers', () => {
    expect(normalizeQuery(undefined)).toBe('')
    expect(normalizeQuery('  Annual  ')).toBe('Annual')
    expect(() => normalizeQuery('x'.repeat(MAX_QUERY_LENGTH + 1))).toThrow()
    expect(() => normalizeQuery('bad\u007f')).toThrow()

    expect(normalizeDirectory(undefined)).toBe('')
    expect(normalizeDirectory('   ')).toBe('')
    expect(normalizeDirectory(' reports/2026 ')).toBe('reports/2026')
    for (const value of [
      '/reports',
      'reports\\2026',
      'reports//2026',
      'reports/./2026',
      'reports/../2026',
      'reports/\u0000',
      'x'.repeat(MAX_DIRECTORY_LENGTH + 1),
    ]) expect(() => normalizeDirectory(value)).toThrow()

    expect(normalizeDocumentId(' reports/annual.txt ')).toBe('reports/annual.txt')
    for (const value of [
      '',
      '/annual.txt',
      'reports\\annual.txt',
      'reports//annual.txt',
      'reports/./annual.txt',
      'reports/../annual.txt',
      'reports/\u0000',
      'x'.repeat(MAX_DOCUMENT_ID_LENGTH + 1),
    ]) expect(() => normalizeDocumentId(value)).toThrow()
  })

  it('validates integer windows and maps references without host paths', () => {
    expect(positiveInteger(undefined, 'limit')).toBeUndefined()
    expect(positiveInteger(2, 'limit')).toBe(2)
    expect(positiveInteger(2, 'limit', 3)).toBe(2)
    expect(() => positiveInteger(0, 'limit')).toThrow('positive integer')
    expect(() => positiveInteger(4, 'limit', 3)).toThrow('no greater than 3')
    expect(() => positiveInteger(1.5, 'limit')).toThrow()

    expect(nonNegativeInteger(undefined, 'offset')).toBe(0)
    expect(nonNegativeInteger(2, 'offset', 3)).toBe(2)
    expect(() => nonNegativeInteger(-1, 'offset')).toThrow()
    expect(() => nonNegativeInteger(MAX_PAGE_OFFSET + 1, 'offset')).toThrow()
    expect(() => nonNegativeInteger(1.5, 'offset')).toThrow()

    const rootRow = row('annual.txt', 'annual.txt', 1)
    const nestedRow = row('reports/annual.txt', 'annual.txt', 2)
    expect(rootRow.folder).toBe('')
    expect(nestedRow.folder).toBe('reports')
    expect(rootRow).not.toHaveProperty('path')
    expect(inDirectory(rootRow, '')).toBe(true)
    expect(inDirectory(nestedRow, 'reports')).toBe(true)
    expect(inDirectory(nestedRow, 'report')).toBe(false)
  })

  it('matches names and ids and orders ties deterministically', () => {
    const annual = row('reports/annual.txt', 'Annual.txt', 10)
    const budget = row('reports/budget.txt', 'Budget.txt', 10)
    const sameNameLaterId = row('reports/z.txt', 'Budget.txt', 10)
    const old = row('old.txt', 'Old.txt', 1)
    const unknownA = row('unknown-a.txt', 'Unknown A.txt', Number.NaN)
    const unknownB = row('unknown-b.txt', 'Unknown B.txt', Number.NaN)
    expect(matchesQuery(annual, '')).toBe(true)
    expect(matchesQuery(annual, 'annual')).toBe(true)
    expect(matchesQuery(annual, 'REPORTS/')).toBe(true)
    expect(matchesQuery(annual, 'missing')).toBe(false)
    expect(orderRows([old, sameNameLaterId, budget, annual])).toEqual([annual, budget, sameNameLaterId, old])
    expect(orderRows([unknownB, unknownA])).toEqual([unknownA, unknownB])
    // Exercise the greater-than side of the code-unit comparator as well.
    expect(orderRows([annual, budget])).toEqual([annual, budget])
  })

  it('bounds output with a recovery marker and validates the cap', () => {
    expect(boundOutput('short', 10, 'marker')).toBe('short')
    const bounded = boundOutput('abcdefghijklmnop', 8, 'more')
    expect(bounded).toContain('more')
    expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(8)
    const markerOnly = boundOutput('abcdef', 3, 'a long marker')
    expect(new TextEncoder().encode(markerOnly).byteLength).toBeLessThanOrEqual(3)
    expect(() => boundOutput('x', 0, 'marker')).toThrow()
    expect(() => boundOutput('x', 1.5, 'marker')).toThrow()
  })

  it('renders empty, paged, capped, and out-of-range listings', () => {
    expect(formatList([], 0, 0, '', '', 4096)).toBe('No personal documents found.')
    expect(formatList([], 0, 0, '', 'reports', 4096)).toBe('No personal documents found under "reports".')
    expect(formatList([], 0, 0, 'annual', '', 4096)).toBe('No personal documents matched "annual".')
    const rows = [row('annual.txt', 'annual.txt', Number.NaN), row('reports/budget.txt', 'budget.txt', Number.MAX_SAFE_INTEGER)]
    const listing = formatList(rows, 2, 0, '', '', 4096)
    expect(listing).toContain('Personal documents (1-2 of 2):')
    expect(listing).toContain('modified: unknown')
    expect(formatList([rows[1]!], 2, 1, '', '', 4096)).not.toContain('More documents are available.')
    expect(formatList([], 2, 2, '', '', 4096)).toContain('offset 2')
    expect(formatList(rows, 2, 0, '', '', 120)).toContain('Listing output was capped.')
  })

  it('renders normalized line windows and continuation states', () => {
    const document = ref('notes.txt', 'notes.txt', 1)
    const rendered = formatRead(document, { text: 'one\r\ntwo\rthree', truncatedBytes: false }, 1, 2, 4096)
    expect(rendered).toContain('1: one')
    expect(rendered).toContain('2: two')
    expect(rendered).toContain('offset=3')
    const trailingNewline = formatRead(document, { text: 'one\ntwo\n', truncatedBytes: false }, 1, 10, 4096)
    expect(trailingNewline).toContain('2: two')
    expect(trailingNewline).not.toContain('3: ')
    expect(formatRead(document, { text: '', truncatedBytes: false }, 1, 2, 4096)).toContain('(No lines available at offset 1.)')
    expect(formatRead(document, { text: 'one', truncatedBytes: true }, 1, 2, 4096)).toContain('More content is available.')
    expect(formatRead(document, { text: 'one\ntwo-partial', truncatedBytes: true }, 1, 2, 4096)).toContain('increase maxReadBytes')
    expect(formatRead(document, { text: 'one', truncatedBytes: false }, 9, 2, 4096)).not.toContain('More content is available.')
    expect(formatRead(document, { text: 'x'.repeat(100), truncatedBytes: false }, 1, 1, 120)).toContain('Document output was capped.')
  })
})
