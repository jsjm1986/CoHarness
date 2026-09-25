/** Canonical projected layout helpers for repository session fixtures. */

import { deepStrictEqual } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  decodeSeqRanges,
  decodeStorageRecord,
  encodeSeqRanges,
  isChunkRow,
  SessionLogOffset,
  type SessionEvent,
  type SessionSeq,
} from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type { SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'

/** Whether a path intentionally preserves physical persistence bytes. */
export function isPhysicalSessionFixture(path: string): boolean {
  return path.startsWith('scripts/snapshots/python-sdk-single-exe/')
    && /\/session(?:\.\d+)?\.jsonl$/.test(path)
}

/** One repository session fixture and its canonical projected representation. */
export interface SessionFixtureLayout {
  /** Repository-relative path with `/` separators. */
  path: string
  /** Current fixture bytes decoded as UTF-8. */
  source: string
  /** Canonical projected fixture bytes. */
  canonical: string
}

function isSessionHeader(value: unknown): boolean {
  return value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 'session'
}

/** Whether any body record stores `sourceEventSeqs` in the v3 range form. */
function usesSourceEventRanges(content: string): boolean {
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record: unknown
    try {
      record = JSON.parse(line) as unknown
    } catch {
      continue
    }
    const seqs = (record as { sourceEventSeqs?: unknown } | null)?.sourceEventSeqs
    if (Array.isArray(seqs) && seqs.some(entry => Array.isArray(entry))) return true
  }
  return false
}

/** The number of events one stored row represents; a packed row covers its member count. */
function rowCardinality(record: Readonly<Record<string, unknown>>): number {
  const data = record.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return 1
  const key = record.type === 'tool-call-chunks' ? 'args' : 'texts'
  const values = (data as Record<string, unknown>)[key]
  return Array.isArray(values) && values.length > 0 ? values.length : 1
}

function parseFixtureObjectLine(line: string, lineNumber: number): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch (error) {
    throw new Error(`session snapshot line ${lineNumber} contains invalid JSON`, { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`session snapshot line ${lineNumber} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

/**
 * Decode the body rows of one session fixture without migrating them. Rows
 * that omit the `seq`/`time` (or packed `seq0`/`time0`) envelope receive
 * deterministic dense values. A predecessor generation's physical rows decode
 * through the released storage codec so packed chunk rows validate; current
 * and versionless fixtures store one scalar event per row and reject packed
 * rows outright.
 */
function parseFixtureRows(content: string, headerValue: unknown): SessionEvent[] {
  const rows: Record<string, unknown>[] = []
  const rowLines: number[] = []
  let nextSeq: SessionLogOffsetType = SessionLogOffset(0)
  let headerSkipped = false
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue
    if (!headerSkipped) {
      headerSkipped = true
      continue
    }
    const record = parseFixtureObjectLine(line, index + 1)
    const packed = isChunkRow(record)
    const seqKey = packed ? 'seq0' : 'seq'
    const timeKey = packed ? 'time0' : 'time'
    if (!Object.hasOwn(record, seqKey)) record[seqKey] = nextSeq
    if (!Object.hasOwn(record, timeKey)) record[timeKey] = 0
    rows.push(record)
    rowLines.push(index + 1)
    nextSeq = SessionLogOffset(nextSeq + rowCardinality(record))
  }
  const storedVersion = headerValue !== null && typeof headerValue === 'object' && !Array.isArray(headerValue)
    ? (headerValue as Record<string, unknown>).version
    : undefined
  const predecessor = typeof storedVersion === 'number' && storedVersion < sessionFormatCatalog.currentVersion
  const events: SessionEvent[] = []
  for (const [index, record] of rows.entries()) {
    try {
      if (!predecessor && isChunkRow(record)) {
        throw new Error('current projected fixtures cannot contain legacy packed rows')
      }
      if (Object.hasOwn(record, 'sourceEventSeqs')) {
        record.sourceEventSeqs = decodeSeqRanges(record.sourceEventSeqs)
      }
      events.push(...(predecessor ? decodeStorageRecord(record) : [record as unknown as SessionEvent]))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`session snapshot line ${rowLines[index] ?? 1}: ${detail}`, { cause: error })
    }
  }
  return events
}

function renderFixture(headerLine: string, events: readonly SessionEvent[], sourceEventForm: 'ranges' | 'flat'): string {
  return [
    headerLine,
    ...events.map((event) => {
      const record = { ...event } as Record<string, unknown>
      // Web/ACP fixtures are projected transcripts. Sequence and timestamp
      // envelopes are regenerated by the replay parser, while the physical
      // Python snapshots remain outside this helper's scope.
      delete record.seq
      delete record.time
      if (sourceEventForm === 'ranges' && 'sourceEventSeqs' in record) {
        record.sourceEventSeqs = encodeSeqRanges(record.sourceEventSeqs as SessionSeq[])
      }
      return JSON.stringify(record)
    }),
    '',
  ].join('\n')
}

/** Remove sequence/time metadata before comparing a projected transcript. */
function withoutEnvelope(events: readonly SessionEvent[]): Array<Omit<SessionEvent, 'seq' | 'time'>> {
  return events.map((event) => {
    const { seq: _seq, time: _time, ...projected } = event
    return projected
  })
}

/**
 * Canonicalize one JSONL document when its first record is a session header.
 * Released predecessor generations are immutable compatibility fixtures: their
 * physical rows are validated but the committed bytes return unchanged.
 * Current and versionless bodies re-encode one event per row without storage
 * sequence/time envelopes; the header line stays byte-identical. Non-session
 * JSONL returns undefined.
 *
 * @param content - JSONL source text.
 * @param label - path-like diagnostic label.
 * @returns Canonical text for a session fixture, otherwise undefined.
 */
export function canonicalSessionFixture(content: string, label = '<session-fixture>'): string | undefined {
  const headerLine = content.split(/\r?\n/).find(line => line.trim().length > 0)
  if (headerLine === undefined) return undefined

  let headerValue: unknown
  try {
    headerValue = JSON.parse(headerLine) as unknown
  } catch {
    return undefined
  }
  if (!isSessionHeader(headerValue)) return undefined

  let events: SessionEvent[]
  try {
    events = parseFixtureRows(content, headerValue)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label}: ${detail}`, { cause: error })
  }
  const storedVersion = headerValue !== null && typeof headerValue === 'object' && !Array.isArray(headerValue)
    ? (headerValue as Record<string, unknown>).version
    : undefined
  if (typeof storedVersion === 'number' && storedVersion < sessionFormatCatalog.currentVersion) {
    return content
  }
  const sourceEventForm: 'ranges' | 'flat' = usesSourceEventRanges(content) ? 'ranges' : 'flat'
  const canonical = renderFixture(headerLine, events, sourceEventForm)
  const decoded = parseFixtureRows(canonical, headerValue)
  try {
    deepStrictEqual(withoutEnvelope(decoded), withoutEnvelope(events))
  } catch (error) {
    throw new Error(`${label}: snapshot rewrite changed the event payload stream`, { cause: error })
  }
  if (renderFixture(headerLine, decoded, sourceEventForm) !== canonical) {
    throw new Error(`${label}: rewrite is not idempotent`)
  }
  return canonical
}

/**
 * Discover tracked and unignored untracked JSONL files through Git.
 *
 * @param root - repository root.
 * @returns Stable repository-relative paths.
 */
function discoverJsonlFiles(root: string): string[] {
  return execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.jsonl'],
    { cwd: root, encoding: 'utf8' },
  ).split('\0')
    .filter(path => path.length > 0 && existsSync(resolve(root, path)))
    .sort()
}

/**
 * Inspect every repository JSONL whose first record is a session header.
 *
 * @param root - repository root.
 * @returns Session fixtures with current and canonical text.
 */
export function inspectSessionFixtureLayouts(root: string): SessionFixtureLayout[] {
  return discoverJsonlFiles(root).flatMap((path) => {
    if (isPhysicalSessionFixture(path)) return []
    const source = readFileSync(resolve(root, path), 'utf8')
    const canonical = canonicalSessionFixture(source, path)
    return canonical === undefined ? [] : [{ path, source, canonical }]
  })
}
