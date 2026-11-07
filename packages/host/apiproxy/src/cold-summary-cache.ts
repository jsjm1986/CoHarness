/** Bounded memoization of verified scalar cold-session summaries owned by one ApiProxy. */
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionSummary } from './api/sessions.ts'

/** Default maximum verified summaries retained by one ApiProxy. */
export const DEFAULT_COLD_SUMMARY_CACHE_MAX_ENTRIES = 512
/** Default maximum encoded identity and summary bytes retained by one ApiProxy. */
export const DEFAULT_COLD_SUMMARY_CACHE_MAX_BYTES = 1024 * 1024

/** List fields derived from a cold log, before projections and authorization enrichment. */
export type ColdSessionSummary = Pick<SessionSummary,
  'sessionId' | 'updatedAt' | 'running' | 'blank' | 'visibleContentSeq'
  | 'parentSessionId' | 'origin' | 'cwd' | 'agentPreset' | 'sshTarget'>

/** Fresh source identity supplied by the owning persistence provider. */
export interface ColdSummarySource {
  header: SessionHeader
  revision?: SessionPersistenceRevision
}

interface Entry {
  identity: string
  summary: ColdSessionSummary
  bytes: number
}

/** One ApiProxy lifetime owns these summaries; no event bodies or access decisions are stored. */
export class ColdSummaryCache {
  private entries: Map<SessionId, Entry> | undefined
  private bytes = 0

  /**
   * @param maxEntries - maximum retained summaries; zero disables reuse.
   * @param maxBytes - maximum combined UTF-8 JSON bytes; zero disables reuse.
   */
  constructor(private readonly maxEntries: number, private readonly maxBytes: number) {
    if (maxEntries > 0 && maxBytes > 0) this.entries = new Map()
  }

  /** Whether an active cache can retain verified results. */
  get enabled(): boolean { return this.entries !== undefined }

  /** Number of summaries retained by the active owner. */
  get size(): number { return this.entries?.size ?? 0 }

  /**
   * Return an independent row only for the freshly listed source identity.
   * @param source - current provider snapshot; missing revisions never reuse a row.
   * @returns a scalar summary, or undefined for a miss or disposed owner.
   */
  get(source: ColdSummarySource): ColdSessionSummary | undefined {
    const entries = this.entries
    if (entries === undefined || source.revision === undefined) return undefined
    const entry = entries.get(source.header.id)
    if (entry === undefined) return undefined
    const identity = JSON.stringify([source.header, source.revision])
    if (entry.identity !== identity) {
      entries.delete(source.header.id)
      this.bytes -= entry.bytes
      return undefined
    }
    entries.delete(source.header.id)
    entries.set(source.header.id, entry)
    return { ...entry.summary }
  }

  /**
   * Retain metadata whose header and source revision were verified after the body read.
   * @param source - validated source identity.
   * @param summary - scalar list metadata; callers keep ownership of their row.
   */
  set(source: ColdSummarySource, summary: ColdSessionSummary): void {
    const entries = this.entries
    if (entries === undefined || source.revision === undefined) return
    const identity = JSON.stringify([source.header, source.revision])
    const bytes = Buffer.byteLength(identity) + Buffer.byteLength(JSON.stringify(summary))
    const previous = entries.get(source.header.id)
    if (previous !== undefined) {
      entries.delete(source.header.id)
      this.bytes -= previous.bytes
    }
    if (bytes > this.maxBytes) return
    for (const [id, entry] of entries) {
      if (entries.size < this.maxEntries && this.bytes + bytes <= this.maxBytes) break
      entries.delete(id)
      this.bytes -= entry.bytes
    }
    entries.set(source.header.id, { identity, bytes, summary: { ...summary } })
    this.bytes += bytes
  }

  /** Release retained rows and prevent late completed reads from retaining new rows. */
  close(): void {
    this.entries = undefined
    this.bytes = 0
  }
}
