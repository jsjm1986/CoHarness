/** Provider-wide accounting for immutable events awaiting durable JSONL writes. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Default provider-wide pending-event capacity, including active writes. */
export const DEFAULT_MAX_PENDING_EVENTS = 100_000
/** Default provider-wide UTF-8 JSON capacity, including active writes. */
export const DEFAULT_MAX_PENDING_BYTES = 64 * 1024 * 1024

/** Deployment limits shared by every write handle belonging to one JSONL provider. */
export interface JsonlRetentionLimits {
  /** Maximum events retained across pending queues, reservations, and active writes. */
  readonly maxPendingEvents?: number
  /** Maximum complete UTF-8 JSON event bytes retained across those writes. */
  readonly maxPendingBytes?: number
}

/** Provider-wide admission account; releases are idempotent across rollback and close. */
export class JsonlRetentionBudget {
  private events = 0
  private bytes = 0
  private readonly maxEvents: number
  private readonly maxBytes: number

  /** @param limits - positive safe-integer capacities, defaulted once per provider. */
  constructor(limits: JsonlRetentionLimits = {}) {
    this.maxEvents = limits.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS
    this.maxBytes = limits.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES
    for (const [name, value] of [['maxPendingEvents', this.maxEvents], ['maxPendingBytes', this.maxBytes]] as const) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`)
    }
  }

  /**
   * Reserve one immutable event before it enters a live queue or explicit append.
   * @param event - complete event whose serialized bytes count against the account.
   * @returns an idempotent release after durable completion or reservation rollback.
   * @throws when either provider-wide capacity would be exceeded; the account stays unchanged.
   */
  reserve(event: SessionEvent): () => void {
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
    if (this.events >= this.maxEvents) throw new Error(`JSONL pending-event limit exceeded (${this.maxEvents})`)
    if (bytes > this.maxBytes - this.bytes) throw new Error(`JSONL pending-byte limit exceeded (${this.maxBytes})`)
    this.events++
    this.bytes += bytes
    let released = false
    return () => {
      if (released) return
      released = true
      this.events--
      this.bytes -= bytes
    }
  }
}
