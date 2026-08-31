import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionHistoryIndex, SessionHistoryIndexItem } from './api/sessions.ts'

/** Maximum marker count accepted by the browser navigation surface. */
export const HISTORY_INDEX_MAX_ITEMS = 2_000
/** Maximum code points retained for one navigation preview. */
export const HISTORY_INDEX_PREVIEW_MAX_CODE_POINTS = 160

interface TurnStart {
  turn: number
  startSeq: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function eventTurn(event: SessionEvent): number | undefined {
  const data = record(event.data)
  const value = data?.turn
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function preview(value: string): string | undefined {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (normalized === '') return undefined
  return Array.from(normalized).slice(0, HISTORY_INDEX_PREVIEW_MAX_CODE_POINTS).join('')
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return []
    const block = candidate as { type?: unknown; text?: unknown; content?: unknown }
    if (block.type === 'text' && typeof block.text === 'string') return [block.text]
    if (block.type === 'tool-result') return [contentText(block.content)]
    return []
  }).filter(value => value !== '').join('\n')
}

function eventText(event: SessionEvent): string {
  const data = record(event.data)
  if (data === undefined) return ''
  if (event.type === 'user/message') return contentText(data.content)
  if (event.type === 'assistant/message') {
    const message = record(data.message)
    return message === undefined
      ? ''
      : contentText(message.content)
  }
  return ''
}

function ordinalAtSeq(starts: readonly TurnStart[], seq: number): number {
  let low = 0
  let high = starts.length - 1
  let found = -1
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2)
    const candidate = starts[middle]
    if (candidate === undefined || candidate.startSeq > seq) high = middle - 1
    else {
      found = middle
      low = middle + 1
    }
  }
  return found
}

function sampledOrdinals(total: number, maximum: number): number[] {
  if (total <= maximum) return Array.from({ length: total }, (_, index) => index)
  if (maximum === 1) return [0]
  const result = new Set<number>([0, total - 1])
  for (let index = 0; index < maximum; index++) {
    result.add(Math.round(index * (total - 1) / (maximum - 1)))
  }
  return [...result].sort((left, right) => left - right)
}

/**
 * Build a bounded navigation index from an already resident session view.
 * The result contains turn ranges and short previews only; stream chunks and
 * other event payloads never cross this helper's output boundary.
 * @param events - ordered session events.
 * @param revision - source revision represented by the events.
 * @param maxItems - maximum markers to return.
 * @returns bounded navigation metadata.
 */
export function historyIndexFromEvents(
  events: readonly SessionEvent[],
  revision: string,
  maxItems = HISTORY_INDEX_MAX_ITEMS,
): SessionHistoryIndex & { revision: string } {
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > HISTORY_INDEX_MAX_ITEMS) {
    throw new RangeError('history index maxItems is outside the supported range')
  }
  const starts: TurnStart[] = events.flatMap((event) => {
    if (event.type !== 'turn/start') return []
    const turn = eventTurn(event)
    return turn === undefined ? [] : [{ turn, startSeq: event.seq }]
  })
  const ordinals = sampledOrdinals(starts.length, maxItems)
  const byOrdinal = new Map(ordinals.map((ordinal, index) => [ordinal, index]))
  const byTurn = new Map(starts.map((start, index) => [start.turn, index]))
  const items: SessionHistoryIndexItem[] = ordinals.map((ordinal) => {
    const start = starts[ordinal]
    if (start === undefined) throw new RangeError('history index ordinal is outside the turn list')
    const next = starts[ordinal + 1]
    return {
      turn: start.turn,
      startSeq: start.startSeq,
      endSeq: (next?.startSeq ?? (events.at(-1)?.seq ?? start.startSeq) + 1) - 1,
    }
  })
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const ordinal = byTurn.get(eventTurn(event) ?? -1) ?? ordinalAtSeq(starts, event.seq)
    const index = byOrdinal.get(ordinal)
    if (index === undefined) continue
    const text = preview(eventText(event))
    if (text === undefined) continue
    const item = items[index]
    if (item === undefined) throw new RangeError('history index item ordinal is outside the result list')
    if (event.type === 'user/message' && item.prompt === undefined) item.prompt = text
    if (event.type === 'assistant/message') item.response = text
  }
  return {
    revision,
    asOfSeq: events.at(-1)?.seq ?? -1,
    totalTurns: starts.length,
    items,
    truncated: items.length < starts.length,
  }
}
