/** Lossless NUL representation and literal patterns for PostgreSQL conversation indexes. @module */
import { literalLikePattern } from './literal-like-pattern.ts'

/**
 * @param content - original indexed text.
 * @returns PostgreSQL-safe trigram text and optional pieces joined by NUL when reading.
 */
export function encodeSearchText(content: string): { text: string; nulParts: string[] | null } {
  const parts = content.split('\u0000')
  return { text: parts.join('\n'), nulParts: parts.length === 1 ? null : parts }
}

/**
 * @param query - literal query, including any NUL separators.
 * @returns escaped patterns for consecutive stored pieces, with only the outer ends unanchored.
 */
export function literalSearchParts(query: string): string[] {
  const parts = query.split('\u0000')
  return parts.map((part, index) => {
    const prefix = index === 0 ? '%' : ''
    const suffix = index === parts.length - 1 ? '%' : ''
    return prefix + literalLikePattern(part).slice(1, -1) + suffix
  })
}
