/**
 * Conversation-tier history split: omit completed historical `assistant/chunk`
 * runs from an already-paginated page and report them as inclusive seq spans.
 * Persistence, pagination, and Fetch packing are unchanged.
 *
 * @module @deepseek-ai/dsh-host-apiproxy/fetch/history-detail
 */

import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { HistoryDetail, HistoryEntry, HistoryOmittedSpan } from '../api/sessions.ts'

/** Result of {@link applyHistoryDetail}: the kept page plus optional omitted spans. */
export interface HistoryDetailPage {
  events: HistoryEntry[]
  omittedSpans?: readonly HistoryOmittedSpan[]
}

/**
 * Inclusive first seq of an append-origin message group (`seq` and
 * `sourceEventSeqs`). Walks sources pairwise so a long provenance list does
 * not expand into a variadic `Math.min`.
 * @param event - one session event, typically an append-origin message.
 * @returns the group's first seq.
 */
export function appendOriginGroupStart(event: SessionEvent): number {
  const sources = (event as SessionEvent & { sourceEventSeqs?: number[] }).sourceEventSeqs
  let start: number = event.seq
  if (sources === undefined) return start
  for (const seq of sources) {
    if (seq < start) start = seq
  }
  return start
}

function coalesceSpans(seqs: readonly number[]): HistoryOmittedSpan[] {
  if (seqs.length === 0) return []
  const ordered = [...new Set(seqs)].sort((left, right) => left - right)
  const spans: HistoryOmittedSpan[] = []
  let startSeq = ordered[0] as number
  let endSeq = startSeq
  for (let index = 1; index < ordered.length; index++) {
    const seq = ordered[index] as number
    if (seq === endSeq + 1) {
      endSeq = seq
      continue
    }
    spans.push({ startSeq, endSeq })
    startSeq = seq
    endSeq = seq
  }
  spans.push({ startSeq, endSeq })
  return spans
}

/**
 * Omit historical chunk runs that sit under a completed append-origin
 * `assistant/message`. Missing `detail` and `'full'` return the page unchanged.
 *
 * @param entries - one already-paginated history page.
 * @param detail - omit gear; omitted or `'full'` keeps every event.
 * @returns kept entries and coalesced omitted spans, when any chunks were dropped.
 */
export function applyHistoryDetail(
  entries: readonly HistoryEntry[],
  detail: HistoryDetail | undefined,
): HistoryDetailPage {
  if (detail !== 'conversation') return { events: [...entries] }

  const ranges: Array<{ start: number; end: number }> = []
  for (const { event } of entries) {
    if (event.type !== 'assistant/message' || !isAppendSurfaceEvent(event)) continue
    ranges.push({ start: appendOriginGroupStart(event), end: event.seq })
  }
  if (ranges.length === 0) return { events: [...entries] }

  const omit = new Set<number>()
  for (const { event } of entries) {
    if (event.type !== 'assistant/chunk') continue
    if (!ranges.some(range => event.seq >= range.start && event.seq <= range.end)) continue
    omit.add(event.seq)
  }

  const omittedSpans = coalesceSpans([...omit])
  return omittedSpans.length === 0
    ? { events: [...entries] }
    : { events: entries.filter(({ event }) => !omit.has(event.seq)), omittedSpans }
}

/**
 * Restrict omitted spans to seqs at or after a suffix cut. Spans wholly
 * before `cutSeq` drop; a straddling span is clipped so `startSeq >= cutSeq`.
 *
 * @param spans - omitted ranges from the pre-cut page.
 * @param cutSeq - inclusive first seq of the returned suffix.
 * @returns clipped spans, or `undefined` when none remain.
 */
export function clipOmittedSpans(
  spans: readonly HistoryOmittedSpan[] | undefined,
  cutSeq: number,
): readonly HistoryOmittedSpan[] | undefined {
  if (spans === undefined || spans.length === 0) return undefined
  const clipped: HistoryOmittedSpan[] = []
  for (const span of spans) {
    if (span.endSeq < cutSeq) continue
    clipped.push({
      startSeq: Math.max(span.startSeq, cutSeq),
      endSeq: span.endSeq,
    })
  }
  return clipped.length === 0 ? undefined : clipped
}
