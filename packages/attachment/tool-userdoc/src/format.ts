/** Model-facing formatting and validation for personal-document tools. */

import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type { UserDocRef } from '@deepseek-ai/dsh-userdoc'

/** Maximum root-relative identifier length accepted by the tool layer. */
export const MAX_DOCUMENT_ID_LENGTH = 4096
/** Maximum root-relative directory length accepted by the tool layer. */
export const MAX_DIRECTORY_LENGTH = 4096
/** Maximum query length accepted by the tool layer. */
export const MAX_QUERY_LENGTH = 255
/** Maximum page offset accepted by the tool layer. */
export const MAX_PAGE_OFFSET = 1_000_000

const LIST_CAP_MARKER = 'Listing output was capped. Narrow the query or use a later offset.'
// Below the valid ECMAScript Date range, so malformed timestamps sort oldest
// without producing NaN when two invalid values are compared.
const INVALID_MODIFIED_AT = -Number.MAX_SAFE_INTEGER

/** A list row rendered for the model without exposing the host path. */
export interface PersonalDocumentRow {
  readonly docId: string
  readonly name: string
  readonly folder: string
  readonly bytes: number
  readonly mediaType: string
  readonly modifiedAt: number
}

/**
 * Validate and normalize an optional document-name query.
 * @param value - model-supplied query text.
 * @returns trimmed query text, or an empty string when omitted.
 */
export function normalizeQuery(value: string | undefined): string {
  if (value === undefined) return ''
  const query = value.trim()
  if (query.length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/u.test(query)) {
    throw new Error('query must be printable text no longer than 255 characters')
  }
  return query
}

/**
 * Validate and normalize an optional root-relative directory.
 * @param value - model-supplied directory text.
 * @returns normalized root-relative directory, or an empty string for the root.
 */
export function normalizeDirectory(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return ''
  const directory = value.trim()
  if (directory.length > MAX_DIRECTORY_LENGTH || directory.startsWith('/') || directory.includes('\\')) {
    throw new Error('directory must be a root-relative path')
  }
  const parts = directory.split('/')
  if (parts.some(part => part.length === 0 || part === '.' || part === '..' || /[\u0000-\u001f\u007f]/u.test(part))) {
    throw new Error('directory must contain only normal path segments')
  }
  return parts.join('/')
}

/**
 * Validate a model-supplied root-relative document id.
 * @param value - model-supplied document id.
 * @returns normalized document id.
 */
export function normalizeDocumentId(value: string): string {
  const docId = value.trim()
  if (docId.length === 0 || docId.length > MAX_DOCUMENT_ID_LENGTH || docId.startsWith('/') || docId.includes('\\')) {
    throw new Error('doc_id must be a root-relative document id')
  }
  const parts = docId.split('/')
  if (parts.some(part => part.length === 0 || part === '.' || part === '..' || /[\u0000-\u001f\u007f]/u.test(part))) {
    throw new Error('doc_id must contain only normal path segments')
  }
  return parts.join('/')
}

/**
 * Validate a positive model-supplied integer with an optional upper bound.
 * @param value - value supplied by the model.
 * @param name - field name used in the failure message.
 * @param maximum - optional inclusive upper bound.
 * @returns the value, or `undefined` when omitted.
 */
export function positiveInteger(value: number | undefined, name: string, maximum?: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1 || maximum !== undefined && value > maximum) {
    throw new Error(maximum === undefined
      ? `${name} must be a positive integer`
      : `${name} must be a positive integer no greater than ${maximum}`)
  }
  return value
}

/**
 * Validate a non-negative model-supplied integer with an optional upper bound.
 * @param value - value supplied by the model.
 * @param name - field name used in the failure message.
 * @param maximum - inclusive upper bound.
 * @returns the value, or zero when omitted.
 */
export function nonNegativeInteger(value: number | undefined, name: string, maximum = MAX_PAGE_OFFSET): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be a non-negative integer no greater than ${maximum}`)
  }
  return value
}

/**
 * Convert a stored reference to the path-free row exposed to the model.
 * @param ref - stored document reference.
 * @returns metadata safe to include in a model result.
 */
export function rowFor(ref: UserDocRef): PersonalDocumentRow {
  const docId = String(ref.docId)
  const slash = docId.lastIndexOf('/')
  return {
    docId,
    name: ref.name,
    folder: slash < 0 ? '' : docId.slice(0, slash),
    bytes: ref.bytes,
    mediaType: ref.mediaType,
    modifiedAt: ref.modifiedAt,
  }
}

/**
 * Test whether a row is below a root-relative directory.
 * @param row - document metadata row.
 * @param directory - normalized directory, with an empty string for root.
 * @returns whether the row belongs to the directory subtree.
 */
export function inDirectory(row: PersonalDocumentRow, directory: string): boolean {
  return directory === '' || row.docId.startsWith(`${directory}/`)
}

/**
 * Test whether a row matches a case-insensitive name or id query.
 * @param row - document metadata row.
 * @param query - normalized query, or an empty string.
 * @returns whether the name or id contains the query.
 */
export function matchesQuery(row: PersonalDocumentRow, query: string): boolean {
  if (query === '') return true
  const needle = query.toLowerCase()
  return row.name.toLowerCase().includes(needle) || row.docId.toLowerCase().includes(needle)
}

/** Compare two strings by code unit so ordering is independent of host locale. */
function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Sort rows newest first with deterministic name and id tie-breakers.
 * @param rows - rows to order.
 * @returns a new ordered array.
 */
export function orderRows(rows: readonly PersonalDocumentRow[]): PersonalDocumentRow[] {
  return [...rows].sort((left, right) => {
    const leftModified = Number.isFinite(left.modifiedAt) ? left.modifiedAt : INVALID_MODIFIED_AT
    const rightModified = Number.isFinite(right.modifiedAt) ? right.modifiedAt : INVALID_MODIFIED_AT
    const modified = rightModified - leftModified
    if (modified !== 0) return modified
    const name = compareStrings(left.name, right.name)
    if (name !== 0) return name
    return compareStrings(left.docId, right.docId)
  })
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/**
 * Bound a complete model result while preserving UTF-8 boundaries.
 * @param value - complete model-facing text.
 * @param maxBytes - maximum UTF-8 bytes in the returned text.
 * @param marker - recovery marker appended when content is omitted.
 * @returns bounded text with a marker when truncation occurs.
 */
export function boundOutput(value: string, maxBytes: number, marker: string): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer')
  if (byteLength(value) <= maxBytes) return value
  const suffix = `\n${marker}`
  const suffixBytes = byteLength(suffix)
  if (suffixBytes >= maxBytes) {
    const retainer = new TextRetainer({ kind: 'tail', maxBytes })
    retainer.push(suffix)
    return retainer.finish().text
  }
  const retainer = new TextRetainer({ kind: 'head', maxBytes: maxBytes - suffixBytes })
  retainer.push(value)
  return `${retainer.finish().text}${suffix}`
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) > 8.64e15) return 'unknown'
  return new Date(value).toISOString()
}

/** Quote model-supplied filter text without allowing punctuation to alter the result layout. */
function quoted(value: string): string {
  return JSON.stringify(value)
}

/**
 * Render one bounded personal-document listing.
 * @param rows - page rows to render.
 * @param total - total rows matching the query.
 * @param offset - zero-based offset of the page.
 * @param query - normalized query text.
 * @param directory - normalized directory text.
 * @param maxBytes - complete output byte cap.
 * @returns model-facing listing text.
 */
export function formatList(
  rows: readonly PersonalDocumentRow[],
  total: number,
  offset: number,
  query: string,
  directory: string,
  maxBytes: number,
): string {
  if (total === 0) {
    const message = query === ''
      ? directory === '' ? 'No personal documents found.' : `No personal documents found under ${quoted(directory)}.`
      : `No personal documents matched ${quoted(query)}.`
    return boundOutput(message, maxBytes, LIST_CAP_MARKER)
  }
  if (offset >= total || rows.length === 0) {
    return boundOutput(
      `No personal documents are available at offset ${String(offset)}; total matching documents: ${String(total)}.`,
      maxBytes,
      LIST_CAP_MARKER,
    )
  }
  const first = offset + 1
  const last = offset + rows.length
  const lines = [`Personal documents (${first}-${last} of ${total}):`]
  for (const [index, row] of rows.entries()) {
    lines.push(
      '',
      `${offset + index + 1}. ${row.name}`,
      `   id: ${row.docId}`,
      `   folder: ${row.folder === '' ? '(root)' : row.folder}`,
      `   size: ${String(row.bytes)} bytes`,
      `   type: ${row.mediaType}`,
      `   modified: ${formatTime(row.modifiedAt)}`,
    )
  }
  if (last < total) {
    lines.push('', `More documents are available. Call userdoc_list with offset=${last}.`)
  }
  return boundOutput(lines.join('\n'), maxBytes, LIST_CAP_MARKER)
}

/** One decoded text window returned by the bounded document reader. */
export interface TextWindow {
  readonly text: string
  readonly truncatedBytes: boolean
}

/**
 * Render one bounded, line-numbered personal-document read.
 * @param ref - document metadata.
 * @param window - decoded bounded text and byte-truncation state.
 * @param offset - one-based first line requested.
 * @param limit - maximum lines requested.
 * @param maxBytes - complete output byte cap.
 * @returns model-facing read text.
 */
export function formatRead(
  ref: UserDocRef,
  window: TextWindow,
  offset: number,
  limit: number,
  maxBytes: number,
): string {
  const normalized = window.text.replace(/\r\n?/gu, '\n')
  const allLines = normalized.length === 0
    ? []
    : normalized.endsWith('\n')
      ? normalized.slice(0, -1).split('\n')
      : normalized.split('\n')
  const selected = allLines.slice(offset - 1, offset - 1 + limit)
  const byteLimitEndedInsideLine = window.truncatedBytes && normalized.length > 0 && !normalized.endsWith('\n')
  const lines = [
    `Personal document: ${ref.name}`,
    `Document id: ${String(ref.docId)}`,
    `Media type: ${ref.mediaType}`,
    `Bytes: ${String(ref.bytes)}`,
    'Content:',
  ]
  if (selected.length === 0) {
    lines.push(`(No lines available at offset ${String(offset)}.)`)
  } else {
    for (const [index, line] of selected.entries()) lines.push(`${offset + index}: ${line}`)
  }
  const nextOffset = offset + selected.length
  if (byteLimitEndedInsideLine) {
    lines.push('', 'More content is available. The byte limit ended inside the last line; increase maxReadBytes to continue.')
  } else if (window.truncatedBytes || offset - 1 + selected.length < allLines.length) {
    lines.push('', `More content is available. Call userdoc_read with offset=${String(Math.max(nextOffset, offset + 1))}.`)
  }
  return boundOutput(lines.join('\n'), maxBytes, 'Document output was capped. Use a smaller window or a later offset.')
}
