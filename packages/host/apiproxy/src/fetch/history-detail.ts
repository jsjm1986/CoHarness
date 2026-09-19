/**
 * Conversation-tier history split: omit `assistant/attempt` records a
 * completed append-origin `assistant/message` in the same turn and step has
 * already superseded, and report them as inclusive seq spans. A retried or
 * superseded attempt's embedded stream is diagnostic bulk the conversation
 * first paint does not need; the client's `'full'` pass restores it.
 * Persistence, pagination, and Fetch packing are unchanged.
 *
 * @module @deepseek-ai/dsh-host-apiproxy/fetch/history-detail
 */

import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { HistoryDetail, HistoryEntry, HistoryOmittedSpan } from '../api/sessions.ts'

/** Result of {@link applyHistoryDetail}: the kept page plus optional omitted spans. */
export interface HistoryDetailPage {
  events: HistoryEntry[]
  omittedSpans?: readonly HistoryOmittedSpan[]
}

/**
 * Inclusive first seq of an append-origin message group. An
 * `assistant/message` group is the same-turn-and-step run directly preceding
 * it — the step frame, retries, and superseded `assistant/attempt` records —
 * plus the message itself; other messages carry `sourceEventSeqs` citations
 * whose earliest seq opens the group. Walks sources pairwise so a long
 * provenance list does not expand into a variadic `Math.min`.
 * @param entries - one ordered history page containing the event.
 * @param index - position of the append-origin message within `entries`.
 * @returns the group's first seq.
 */
export function appendOriginGroupStart(entries: readonly HistoryEntry[], index: number): number {
  // oxlint-disable-next-line typescript/no-non-null-assertion -- Callers pass an in-range index.
  const event = entries[index]!.event
  const sources = event.sourceEventSeqs
  let start: number = event.seq
  if (sources !== undefined) {
    for (const seq of sources) {
      if (seq < start) start = seq
    }
    return start
  }
  if (event.type !== 'assistant/message') return start
  const { turn, step } = event.data
  for (let i = index - 1; i >= 0; i -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- i stays inside the scanned range.
    const prior = entries[i]!.event.data as { turn?: number; step?: number }
    if (prior.turn !== turn || prior.step !== step) break
    // oxlint-disable-next-line typescript/no-non-null-assertion -- i stays inside the scanned range.
    start = entries[i]!.event.seq
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
 * Omit `assistant/attempt` records whose turn and step completed with an
 * append-origin `assistant/message` on the same page. Attempts without that
 * message — failed steps, cancellations, the in-flight tail — stay. Missing
 * `detail` and `'full'` return the page unchanged.
 *
 * @param entries - one already-paginated history page.
 * @param detail - omit gear; omitted or `'full'` keeps every event.
 * @returns kept entries and coalesced omitted spans, when any attempts were dropped.
 */
export function applyHistoryDetail(
  entries: readonly HistoryEntry[],
  detail: HistoryDetail | undefined,
): HistoryDetailPage {
  if (detail !== 'conversation') return { events: [...entries] }

  const completedSteps = new Set<string>()
  const attempts: Array<{ seq: number; key: string }> = []
  for (const { event } of entries) {
    if (event.type === 'assistant/message' && isAppendSurfaceEvent(event)) {
      completedSteps.add(`${event.data.turn}:${event.data.step}`)
    } else if (event.type === 'assistant/attempt') {
      attempts.push({ seq: event.seq, key: `${event.data.turn}:${event.data.step}` })
    }
  }

  const omit = new Set<number>()
  for (const attempt of attempts) {
    if (completedSteps.has(attempt.key)) omit.add(attempt.seq)
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
