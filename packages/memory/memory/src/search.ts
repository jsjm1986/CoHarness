/**
 * Term extraction, relevance scoring, and excerpt cutting for
 * {@link MemoryService.search}. Pure functions over normalized text; the
 * service owns entry iteration and the result cap.
 * @module @deepseek-ai/dsh-memory/src/search
 */

import type { MemoryEntry, MemoryEntrySummary, MemorySearchHit } from './types.ts'

/** Script runs that tokenize as CJK: whole run plus its overlapping bigrams. */
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** One token candidate: letters/numbers plus the connector characters that keep paths and names whole. */
const TOKEN_RUN = /[\p{L}\p{N}_./-]+/gu

/** Field weight order: key matters most, content least. */
const FIELD_WEIGHTS = { key: 3, summary: 2, content: 1 } as const

/** Maximum excerpt length in code points. */
const EXCERPT_MAX_LENGTH = 160

/**
 * NFKC-fold + lowercase, the single normalization applied to queries, terms,
 * and searched fields so matching ignores case and compatibility variants.
 */
function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

/**
 * Extract deduplicated search terms from a normalized query, in first-seen
 * order. Each `[\p{L}\p{N}_./-]+` token splits at CJK boundaries: non-CJK
 * segments need length ≥ 2; a CJK run contributes the whole run when it has
 * ≥ 2 characters, plus every 2-character bigram when it is longer than 2.
 * @param normalizedQuery - Query text already through {@link normalizeText}.
 * @returns the deduplicated term list.
 */
export function searchTerms(normalizedQuery: string): string[] {
  const terms: string[] = []
  const seen = new Set<string>()
  const push = (term: string): void => {
    if (Array.from(term).length < 2 || seen.has(term)) return
    seen.add(term)
    terms.push(term)
  }
  for (const match of normalizedQuery.matchAll(TOKEN_RUN)) {
    const token = match[0]
    let cjkRun = ''
    let latinRun = ''
    const flushCjk = (): void => {
      const chars = Array.from(cjkRun)
      if (chars.length >= 2) {
        push(cjkRun)
        if (chars.length > 2) {
          for (let index = 0; index + 1 < chars.length; index += 1) push(chars.slice(index, index + 2).join(''))
        }
      }
      cjkRun = ''
    }
    const flushLatin = (): void => {
      if (Array.from(latinRun).length >= 2) push(latinRun)
      latinRun = ''
    }
    for (const char of token) {
      if (CJK_CHAR.test(char)) {
        flushLatin()
        cjkRun += char
      } else {
        flushCjk()
        latinRun += char
      }
    }
    flushLatin()
    flushCjk()
  }
  return terms
}

/** Count non-overlapping occurrences of `term` inside `field` (both already normalized). */
function occurrences(field: string, term: string): number {
  let count = 0
  let index = field.indexOf(term)
  while (index !== -1) {
    count += 1
    index = field.indexOf(term, index + term.length)
  }
  return count
}

/**
 * Score one entry against the normalized query and terms: for each weighted
 * field, `+10×w` when the field contains the whole query and `+w×(1+min(occurrences,5))`
 * per contained term.
 */
function scoreEntry(
  normalizedQuery: string,
  terms: readonly string[],
  normalized: { key: string; summary: string; content: string },
): number {
  let score = 0
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS) as [keyof typeof FIELD_WEIGHTS, number][]) {
    const text = normalized[field]
    if (text.includes(normalizedQuery)) score += 10 * weight
    for (const term of terms) {
      const found = occurrences(text, term)
      if (found > 0) score += weight * (1 + Math.min(found, 5))
    }
  }
  return score
}

/**
 * Bound text to {@link EXCERPT_MAX_LENGTH} code points, marking each cut edge
 * with `…`.
 * @param text - Whitespace-collapsed source text.
 * @param leadingCut - Whether the window starts inside the source (its left edge was cut).
 * @returns the bounded excerpt.
 */
function cutExcerpt(text: string, leadingCut: boolean): string {
  const chars = Array.from(text)
  const prefix = leadingCut ? '…' : ''
  if (chars.length <= EXCERPT_MAX_LENGTH - prefix.length) return `${prefix}${text}`
  const body = chars.slice(0, EXCERPT_MAX_LENGTH - prefix.length - 1).join('')
  return `${prefix}${body}…`
}

/**
 * Cut a bounded excerpt: content collapsed to single spaces, windowed around
 * the first occurrence of the first term appearing in it (up to 40 code
 * points of leading context), at most {@link EXCERPT_MAX_LENGTH} code points
 * with `…` at a cut edge; falls back to the entry summary under the same
 * collapse and cap when content holds no term.
 * @param entry - The candidate entry.
 * @param terms - Extracted terms in first-seen order.
 * @returns the excerpt text.
 */
function searchExcerpt(entry: MemoryEntry, terms: readonly string[]): string {
  const collapsed = entry.content.replaceAll(/\s+/g, ' ').trim()
  const normalizedCollapsed = normalizeText(collapsed)
  for (const term of terms) {
    const index = normalizedCollapsed.indexOf(term)
    if (index === -1) continue
    // Map the UTF-16 hit offset onto code points, then take up to 40 of
    // leading context so the term lands near the window's start.
    const codePointIndex = Array.from(normalizedCollapsed.slice(0, index)).length
    const start = Math.max(0, codePointIndex - 40)
    return cutExcerpt(Array.from(collapsed).slice(start).join(''), start > 0)
  }
  return cutExcerpt(entry.summary.replaceAll(/\s+/g, ' ').trim(), false)
}

/**
 * Rank entries by {@link scoreEntry}, keeping score > 0, ordered by score
 * desc, `updated.at` desc, key asc, capped at `limit`.
 * @param entries - Candidate stored entries, already filtered to the requested scopes.
 * @param query - The raw query.
 * @param limit - Result cap.
 * @returns ranked hits with excerpts.
 */
export function rankEntries(entries: readonly MemoryEntry[], query: string, limit: number): MemorySearchHit[] {
  const normalizedQuery = normalizeText(query)
  const terms = searchTerms(normalizedQuery)
  const scored: { entry: MemoryEntry; excerpt: string; score: number }[] = []
  for (const entry of entries) {
    const normalized = {
      key: normalizeText(entry.key),
      summary: normalizeText(entry.summary),
      content: normalizeText(entry.content),
    }
    const score = scoreEntry(normalizedQuery, terms, normalized)
    if (score <= 0) continue
    scored.push({ entry, excerpt: searchExcerpt(entry, terms), score })
  }
  scored.sort((a, b) =>
    b.score - a.score
    || b.entry.updated.at.localeCompare(a.entry.updated.at)
    || a.entry.key.localeCompare(b.entry.key))
  return scored.slice(0, limit).map(({ entry, excerpt, score }) => ({
    entry: summaryOf(entry),
    excerpt,
    score,
  }))
}

/**
 * Strip the body for catalog/search surfaces.
 * @param entry - The entry whose body is dropped.
 * @returns the entry's summary fields without `content`.
 */
export function summaryOf(entry: MemoryEntry): MemoryEntrySummary {
  const { content: _content, ...summary } = entry
  return summary
}
