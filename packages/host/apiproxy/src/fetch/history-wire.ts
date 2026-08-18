/**
 * Fetch-carrier physical codec for `session.history` / `subagent.history`
 * success values. Logical `{ events, hasMore, projections? }` pages become
 * `{ records, hasMore, projections? }` with eligible `assistant/chunk` delta
 * runs packed via {@link packChunkRuns}; the client schema expands records
 * back to `events`. Page reduction measures the complete `server-response`
 * UTF-8 JSON and cuts only at append-origin `user/message` /
 * `assistant/message` group starts. Persistence is unchanged.
 *
 * @module @deepseek-ai/dsh-host-apiproxy/fetch/history-wire
 */

import { z } from 'zod'
import { decodeChunkRow, isChunkRow, packChunkRuns } from '@deepseek-ai/dsh-session/chunk-rows'
import type { ChunkRow, StorageRecord } from '@deepseek-ai/dsh-session/chunk-rows'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { RpcId, ServerResponse } from '../api/rpc.ts'
import type { ResponseValue } from '../api/rpc-map.ts'
import type { Wire } from '../api/rpc.schema.ts'
import type { HistoryEntry, HistoryOmittedSpan, SessionProjectionsBlock } from '../api/sessions.ts'
import { historyEntrySchema, historyOmittedSpanSchema, sessionProjectionsBlockSchema } from '../api/sessions.schema.ts'
import { appendOriginGroupStart, clipOmittedSpans } from './history-detail.ts'

type HistoryValue = ResponseValue<'session.history'>

/** One physical history record: an ordinary entry, or a packed chunk-run wrapper. */
type HistoryWireRecord =
  | HistoryEntry
  | { chunks: ChunkRow }

interface HistoryWireValue {
  records: HistoryWireRecord[]
  hasMore: boolean
  projections?: SessionProjectionsBlock
  omittedSpans?: readonly HistoryOmittedSpan[]
}

const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * Default uncompressed UTF-8 JSON size for one complete history
 * `server-response`, including the RPC envelope, packed records, views, and
 * projections. A latency target, not a truncation limit: an indivisible
 * suffix is returned even when it exceeds this value.
 */
export const DEFAULT_HISTORY_PAGE_TARGET_BYTES = 128 * 1024

function utf8JsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function packEntries(entries: readonly HistoryEntry[]): HistoryWireRecord[] {
  const views = new Map(entries.flatMap(({ event, view }) => view === undefined ? [] : [[event.seq, view]]))
  return packChunkRuns(entries.map(entry => entry.event)).map((record: StorageRecord): HistoryWireRecord => {
    if (isChunkRow(record)) return { chunks: record }
    const view = views.get(record.seq)
    return view === undefined ? { event: record } : { event: record, view }
  })
}

function appendGroupStarts(entries: readonly HistoryEntry[]): number[] {
  const starts: number[] = []
  for (const { event } of entries) {
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    starts.push(appendOriginGroupStart(event))
  }
  return starts
}

function toWireValue(
  entries: readonly HistoryEntry[],
  hasMore: boolean,
  projections: SessionProjectionsBlock | undefined,
  omittedSpans: readonly HistoryOmittedSpan[] | undefined,
): HistoryWireValue {
  return {
    records: packEntries(entries),
    hasMore,
    ...projections === undefined ? {} : { projections },
    ...omittedSpans === undefined || omittedSpans.length === 0 ? {} : { omittedSpans },
  }
}

function envelope(rpcId: RpcId, wireValue: HistoryWireValue): ServerResponse {
  return {
    type: 'server-response',
    rpcId,
    result: { ok: true, value: wireValue },
  }
}

function suffixEntries(entries: readonly HistoryEntry[], cutSeq: number): HistoryEntry[] {
  return entries.filter(entry => entry.event.seq >= cutSeq)
}

function omittedPrefix(entries: readonly HistoryEntry[], cutSeq: number): boolean {
  return entries.some(entry => entry.event.seq < cutSeq)
}

function appendMessageCount(entries: readonly HistoryEntry[]): number {
  return appendGroupStarts(entries).length
}

function seqSet(entries: readonly HistoryEntry[]): Set<number> {
  return new Set(entries.map(entry => entry.event.seq))
}

/** Whether `bigger` contains every seq in `smaller` plus at least one more. */
function isStrictEventSuperset(bigger: readonly HistoryEntry[], smaller: readonly HistoryEntry[]): boolean {
  const small = seqSet(smaller)
  const big = seqSet(bigger)
  if (big.size <= small.size) return false
  for (const seq of small) {
    /* v8 ignore next -- suffix candidates nest by cut seq, so a larger set always contains the previous */
    if (!big.has(seq)) return false
  }
  return true
}

interface SuffixCandidate {
  entries: HistoryEntry[]
  groupCount: number
  omitsPrefix: boolean
  cutSeq: number
}

/**
 * Distinct suffix candidates from newest append message to older ones.
 * Each step accumulates `min(seq, ...sourceEventSeqs)` so a later message that
 * cites an earlier seq cannot drop that seq; a step is kept only when it is a
 * strict event-set superset of the previous candidate.
 */
function suffixCandidates(entries: readonly HistoryEntry[]): SuffixCandidate[] {
  const starts = appendGroupStarts(entries)
  const out: SuffixCandidate[] = []
  let accCut = Number.POSITIVE_INFINITY
  for (let i = starts.length - 1; i >= 0; i--) {
    accCut = Math.min(accCut, starts[i] as number)
    const suffix = suffixEntries(entries, accCut)
    const prev = out[out.length - 1]
    if (prev !== undefined && !isStrictEventSuperset(suffix, prev.entries)) continue
    out.push({
      entries: suffix,
      groupCount: appendMessageCount(suffix),
      omitsPrefix: omittedPrefix(entries, accCut),
      cutSeq: accCut,
    })
  }
  return out
}

function candidate(
  rpcId: RpcId,
  value: HistoryValue,
  entries: readonly HistoryEntry[],
  cutOmitsPrefix: boolean,
  cutSeq?: number,
): ServerResponse {
  return envelope(rpcId, toWireValue(
    entries,
    value.hasMore || cutOmitsPrefix,
    value.projections,
    cutSeq === undefined ? value.omittedSpans : clipOmittedSpans(value.omittedSpans, cutSeq),
  ))
}

interface SizedPage {
  body: ServerResponse
  groupCount: number
  eventCount: number
}

function preferPage(current: SizedPage, next: SizedPage): SizedPage {
  if (next.groupCount !== current.groupCount) return next.groupCount > current.groupCount ? next : current
  /* v8 ignore next -- later candidates with equal group count cannot gain events under nested suffixes */
  return next.eventCount > current.eventCount ? next : current
}

/**
 * Pack a logical history page into a complete `server-response` and, when the
 * UTF-8 JSON exceeds `targetBytes`, replace it with the largest append-origin
 * message-group suffix that fits. The newest group (plus any in-flight tail
 * sharing its seq range) is always returned; a page with no append-origin
 * message stays whole. Starts are accumulated as a running minimum so
 * non-monotonic `sourceEventSeqs` cannot drop a newer message's cited prefix.
 *
 * @param rpcId - echoed request id on the envelope.
 * @param value - logical history page (`events`, `hasMore`, optional
 *   `projections` and `omittedSpans`). Byte-target suffix cuts clip
 *   `omittedSpans` to seqs inside the returned suffix.
 * @param targetBytes - complete-envelope UTF-8 JSON latency target.
 * @returns the packed success envelope; `hasMore` is true when this encoder
 *   dropped a logical prefix or the input page already had `hasMore`.
 */
export function encodeHistoryServerResponse(
  rpcId: RpcId,
  value: HistoryValue,
  targetBytes: number,
): ServerResponse {
  const full: SizedPage = {
    body: candidate(rpcId, value, value.events, false),
    groupCount: appendMessageCount(value.events),
    eventCount: value.events.length,
  }
  const suffixes = suffixCandidates(value.events)
  if (suffixes.length === 0) return full.body

  const indivisible = suffixes[0] as SuffixCandidate
  const indivisiblePage: SizedPage = {
    body: candidate(rpcId, value, indivisible.entries, indivisible.omitsPrefix, indivisible.cutSeq),
    groupCount: indivisible.groupCount,
    eventCount: indivisible.entries.length,
  }

  const pages: SizedPage[] = [full]
  for (const suffix of suffixes) {
    pages.push({
      body: candidate(rpcId, value, suffix.entries, suffix.omitsPrefix, suffix.cutSeq),
      groupCount: suffix.groupCount,
      eventCount: suffix.entries.length,
    })
  }

  let best: SizedPage | undefined
  for (const page of pages) {
    if (utf8JsonBytes(page.body) > targetBytes) continue
    best = best === undefined ? page : preferPage(best, page)
  }
  return best?.body ?? indivisiblePage.body
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Expand one physical record. Packed rows are exactly `{ chunks }`; ordinary
 * rows are exactly `{ event }` or `{ event, view }`. Any other key set fails
 * before expansion so mixed `{ chunks, event }` / `{ chunks, view }` cannot
 * drop fields. Malformed packed payloads still throw from {@link decodeChunkRow}.
 */
function expandWireRecord(record: unknown): HistoryEntry[] {
  if (!isRecordObject(record)) throw new Error('history wire record must be an object')
  const keys = Object.keys(record)
  if (keys.length === 1 && keys[0] === 'chunks') {
    return decodeChunkRow(record.chunks).map((event: SessionEvent): HistoryEntry => ({ event }))
  }
  const ordinary = Object.hasOwn(record, 'event')
    && keys.every(key => key === 'event' || key === 'view')
  if (ordinary) return [historyEntrySchema.parse(record) as HistoryEntry]
  throw new Error('history wire record must be exactly { chunks } or { event, view? }')
}

/**
 * Client-side history success schema: physical `records` expand to logical
 * `events`. A packed record is exactly `{ chunks }` and expands through
 * {@link decodeChunkRow}; an ordinary record is exactly `{ event, view? }`.
 * Extra keys fail parse before any expanded events are produced.
 */
export const historyWireValueSchema: z.ZodType<Wire<HistoryValue>> = z.object({
  records: z.array(z.unknown()),
  hasMore: z.boolean(),
  projections: sessionProjectionsBlockSchema.optional(),
  omittedSpans: z.array(historyOmittedSpanSchema).optional(),
}).transform(value => ({
  events: value.records.flatMap(expandWireRecord),
  hasMore: value.hasMore,
  ...value.projections === undefined ? {} : { projections: value.projections },
  ...value.omittedSpans === undefined || value.omittedSpans.length === 0
    ? {}
    : { omittedSpans: value.omittedSpans },
})) as unknown as z.ZodType<Wire<HistoryValue>>
