/**
 * Released-v0/v1 JSONL storage rows for `assistant/chunk` delta runs. Those
 * generations packed each run of consecutive same-block delta chunks into ONE
 * storage row — `text-chunks`, `reasoning-chunks`, or `tool-call-chunks` —
 * whose `seq0`/`time0` envelope anchors members reconstructed as `seq0 + k`
 * and `time0` plus the first `k` `dt` gaps. This module decodes those rows
 * back to the exact original events; v2/v3/v4 writers never pack.
 *
 * Storage rows are a durable-encoding vocabulary, NOT session events: they
 * never enter `Session.snapshotEvents()`, have no `SessionEventMap` entry, and
 * use bare (slash-less) type tags so a reader cannot confuse them with the event
 * taxonomy (precedent: the JSONL header line's `session` tag). The decoder
 * validates before expanding and fails loud on a malformed row-tagged value
 * instead of silently dropping a whole run.
 *
 * Expanded values carry the released-v3 `assistant/chunk` event type, which the
 * current taxonomy no longer knows: a v3 body must pass through the v3→v4
 * migration (which folds chunks into embedded Assistant streams) before any
 * current consumer reads it. The v4 generation never writes or accepts these
 * rows.
 *
 * @module @deepseek-ai/dsh-session/chunk-rows
 */

import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'
import { SessionSeq } from './types.ts'
import type { SessionEvent, SessionSeq as SessionSeqType } from './types.ts'

/**
 * Fields shared by every packed run: placement, block correlation, and member
 * timestamps as gaps. Member `k` reconstructs as seq `seq0 + k` and time
 * `time0` plus the first `k` gaps; a gap may be negative when the wall clock
 * stepped backwards between events.
 */
interface RunDataBase {
  turn: number
  step: number
  /** The stream block index every member shares. */
  index: number
  /** Epoch-ms gaps between consecutive members; length is one less than the member count. */
  dt: number[]
}

/** Payload of a `text-chunks`/`reasoning-chunks` row: one entry per member, never joined — token boundaries are data. */
interface TextRunData extends RunDataBase {
  texts: string[]
}

/** Payload of a `tool-call-chunks` row: the run-constant call identity plus each member's raw arguments fragment. */
interface ToolCallRunData extends RunDataBase {
  id: ToolCallId
  /** Present iff every member carried it, with one uniform value (a mixed run never packs). */
  name?: string
  args: string[]
}

/**
 * A packed run of consecutive delta chunk events, discriminated on `type`.
 * `seq0`/`time0` anchor the first member; text and reasoning rows share the
 * {@link TextRunData} payload, tool-call rows carry {@link ToolCallRunData}.
 */
export type ChunkRow =
  | { type: 'text-chunks'; seq0: SessionSeqType; time0: number; data: TextRunData }
  | { type: 'reasoning-chunks'; seq0: SessionSeqType; time0: number; data: TextRunData }
  | { type: 'tool-call-chunks'; seq0: SessionSeqType; time0: number; data: ToolCallRunData }

/** One released-v3 durable log line's JSON value: a session event verbatim, or a packed chunk row. */
export type StorageRecord = SessionEvent | ChunkRow

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/* v8 ignore start -- closed-union exhaustiveness; local to stay off the Node-facing LLM package root */
function assertNever(value: never, context?: string): never {
  const rendered = (JSON.stringify(value) as string | undefined) ?? String(value)
  throw new Error(`unreachable variant${context ? ` in ${context}` : ''}: ${rendered}`)
}
/* v8 ignore stop */

/**
 * Whether a parsed value carries a packed chunk-row tag (`text-chunks`,
 * `reasoning-chunks`, or `tool-call-chunks`). Tag-only: does not validate
 * envelope or payload fields — use {@link decodeChunkRow} (which calls
 * `validateRow`) for full structural checks before expansion.
 * @param value - a parsed JSON value (wire or storage vocabulary, not a session event).
 * @returns true when `value.type` is one of the three packed-row tags.
 */
export function isChunkRow(value: unknown): value is ChunkRow {
  if (!isRecord(value)) return false
  return value.type === 'text-chunks'
    || value.type === 'reasoning-chunks'
    || value.type === 'tool-call-chunks'
}

/** Exact-key check: `value` has every key in `keys` and nothing else. */
function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k))
}

/** Throw the uniform malformed-row diagnostic. */
function malformed(tag: string, why: string): never {
  throw new Error(`malformed ${tag} storage row: ${why}`)
}

/** Validate the shared run-data fields and the payload/dt arity; returns the member payload. */
function validateRunData(tag: string, data: Record<string, unknown>, payloadKey: 'texts' | 'args'): string[] {
  if (typeof data.turn !== 'number' || typeof data.step !== 'number' || typeof data.index !== 'number') {
    malformed(tag, 'turn/step/index must be numbers')
  }
  const payload = data[payloadKey]
  if (!Array.isArray(payload) || payload.length === 0 || payload.some(entry => typeof entry !== 'string')) {
    malformed(tag, `${payloadKey} must be a non-empty string array`)
  }
  const dt = data.dt
  if (!Array.isArray(dt) || dt.some(gap => !Number.isSafeInteger(gap))) {
    malformed(tag, 'dt must be an array of safe integers')
  }
  if (dt.length !== payload.length - 1) {
    malformed(tag, `dt length ${dt.length} does not match ${payload.length} members`)
  }
  return payload as string[]
}

/** Validate a row-tagged parsed value's envelope and data, throwing on any malformation. */
function validateRow(value: Record<string, unknown>, tag: ChunkRow['type']): ChunkRow {
  if (!hasExactKeys(value, ['type', 'seq0', 'time0', 'data'])) {
    malformed(tag, 'envelope must be exactly {type, seq0, time0, data}')
  }
  if (!Number.isSafeInteger(value.seq0) || (value.seq0 as number) < 0 || Object.is(value.seq0, -0)) {
    malformed(tag, 'seq0 must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(value.time0)) {
    malformed(tag, 'time0 must be a safe integer')
  }
  const data = value.data
  if (!isRecord(data)) malformed(tag, 'data must be an object')
  let payload: string[]
  if (tag === 'tool-call-chunks') {
    const withName = hasExactKeys(data, ['turn', 'step', 'index', 'id', 'name', 'dt', 'args'])
    if (!withName && !hasExactKeys(data, ['turn', 'step', 'index', 'id', 'dt', 'args'])) {
      malformed(tag, 'data must be exactly {turn, step, index, id, name?, dt, args}')
    }
    if (typeof data.id !== 'string' || (withName && typeof data.name !== 'string')) {
      malformed(tag, 'id (and name when present) must be strings')
    }
    payload = validateRunData(tag, data, 'args')
  } else {
    if (!hasExactKeys(data, ['turn', 'step', 'index', 'dt', 'texts'])) {
      malformed(tag, 'data must be exactly {turn, step, index, dt, texts}')
    }
    payload = validateRunData(tag, data, 'texts')
  }
  // Reconstruction bounds. The released encoder only packed runs whose member
  // seqs and times are all safe integers, so a running value that leaves safe
  // range is outside any encoder's image: float arithmetic would round it to
  // a different number than exact arithmetic, a silent corruption. Within safe
  // range every step is exact, so the first departure is always caught.
  if (!Number.isSafeInteger((value.seq0 as number) + payload.length - 1)) {
    malformed(tag, 'member seqs must stay safe integers')
  }
  let time = value.time0 as number
  for (const gap of data.dt as number[]) {
    time += gap
    if (!Number.isSafeInteger(time)) malformed(tag, 'member times must stay safe integers')
  }
  SessionSeq(value.seq0 as number)
  return value as unknown as ChunkRow
}

/** Expand a validated row back into its exact original released-v3 events, in order. */
function expandRow(row: ChunkRow): SessionEvent[] {
  const members = row.type === 'tool-call-chunks' ? row.data.args : row.data.texts
  const events: SessionEvent[] = []
  let time = row.time0
  for (let k = 0; k < members.length; k++) {
    if (k > 0) time += row.data.dt[k - 1] as number
    let chunk: StreamChunk
    switch (row.type) {
      case 'text-chunks':
        chunk = { type: 'text-delta', index: row.data.index, text: members[k] as string }
        break
      case 'reasoning-chunks':
        chunk = { type: 'reasoning-delta', index: row.data.index, text: members[k] as string }
        break
      case 'tool-call-chunks':
        chunk = {
          type: 'tool-call-delta',
          index: row.data.index,
          id: row.data.id,
          ...Object.hasOwn(row.data, 'name') ? { name: row.data.name as string } : {},
          argumentsDelta: members[k] as string,
        }
        break
      /* v8 ignore next 2 -- validateRow only returns the three row tags */
      default:
        return assertNever(row, 'chunk-rows expandRow')
    }
    events.push({
      type: 'assistant/chunk',
      seq: SessionSeq(row.seq0 + k),
      time,
      data: { turn: row.data.turn, step: row.data.step, chunk },
    } as unknown as SessionEvent)
  }
  return events
}

/**
 * Decode one packed chunk row into its exact original released-v3 events.
 * A value that is not a `text-chunks`, `reasoning-chunks`, or
 * `tool-call-chunks` row throws `value is not a packed chunk row` and does
 * not call the row validator. A row-tagged value that fails validation throws
 * `malformed <tag> storage row: …` before any event is expanded.
 * @param value - a parsed row value (typically from JSON).
 * @returns the expanded released-v3 events, in log order.
 */
export function decodeChunkRow(value: unknown): SessionEvent[] {
  if (!isChunkRow(value)) throw new Error('value is not a packed chunk row')
  return expandRow(validateRow(value, value.type))
}

/**
 * Decode one parsed JSONL line value of a released (≤v3) generation into the
 * session event(s) it stores. Chunk-row-tagged values validate and expand (a
 * malformed row throws — it is corrupt storage, and treating it as an event
 * would silently drop a whole run); every other value passes through as a
 * single event after admitting a numeric `seq` through the Session-sequence
 * constructor.
 *
 * @param value - one line's `JSON.parse` result.
 * @returns the stored events, in log order.
 */
export function decodeStorageRecord(value: unknown): SessionEvent[] {
  if (isChunkRow(value)) return decodeChunkRow(value)
  // A plain event row keeps the released admission check: a `seq` that is not a
  // non-negative safe integer fails loud here instead of poisoning the log.
  if (isRecord(value) && typeof value.seq === 'number') SessionSeq(value.seq)
  return [value as SessionEvent]
}
