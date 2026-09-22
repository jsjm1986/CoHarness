/**
 * {@link SessionHandle} implementation backed by the coordinator-based service
 * primitives every local backend already provides. It carries the upstream
 * handle contract — per-handle open state, lazy-create materialization, and
 * single-writer ownership — while the storage work still routes through the
 * backend's existing `readFrom`/`append`/materialization hooks.
 * @module @deepseek-ai/dsh-session-persistence/contract-handle
 */

import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset,
  SessionSeedEventState,
} from '@deepseek-ai/dsh-session'
import { SessionLogOffset as toLogOffset } from '@deepseek-ai/dsh-session'
import {
  SessionHandleClosedError,
  SessionReadOnlyError,
} from './errors.ts'
import type {
  SessionAccess,
  SessionHandle,
  SessionHandleAppendOptions,
  SessionHandleFlushOptions,
  SessionHandleReadOptions,
  SessionHandleReadResult,
} from './handle.ts'
import type { SessionPersistence } from './index.ts'

/**
 * One open channel onto a stored session, adapted onto the coordinator's
 * detached-session primitives. `pending` marks a `create`-made session whose
 * first append or flush materializes it; closing a still-pending write handle
 * erases the reservation exactly as if the create had never happened.
 */
export class ContractSessionHandle implements SessionHandle {
  private closed = false

  constructor(
    private readonly owner: SessionPersistence,
    readonly id: SessionId,
    readonly header: SessionHeader,
    readonly inheritedEventCount: SessionLogOffset,
    readonly access: SessionAccess,
  ) {}

  async read(
    offset: number = 0,
    length?: number,
    options?: SessionHandleReadOptions,
  ): Promise<SessionHandleReadResult> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError('session handle read offset must be a non-negative safe integer')
    }
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
      throw new TypeError('session handle read length must be a non-negative safe integer')
    }
    if (this.owner.isPending(this.id)) {
      // A pending create has no stored log yet; reads observe the empty prefix
      // until the first append materializes it.
      return { eventState: 'detached' as SessionSeedEventState, events: [] }
    }
    const suffix = await this.owner.readFrom(this.id, toLogOffset(offset), options?.signal)
    return {
      eventState: 'detached' as SessionSeedEventState,
      events: length === undefined ? suffix.events : suffix.events.slice(0, length),
    }
  }

  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    if (this.access === 'read') throw new SessionReadOnlyError(this.id, 'append')
    // Coordinator append validates contiguity, snapshots losslessly, and
    // materializes a pending create atomically with its first batch.
    await this.owner.append(this.id, events)
  }

  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.assertOpen()
    if (this.access === 'read') throw new SessionReadOnlyError(this.id, 'flush')
    options?.signal?.throwIfAborted()
    // Coordinator appends are durable at resolution; only a still-pending
    // create has work to do — write the header-only artifact.
    if (this.owner.isPending(this.id)) await this.owner.materializeDetached(this.id)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      if (this.access === 'write' && this.owner.isPending(this.id)) {
        await this.owner.discardDetached(this.id)
      }
    } finally {
      this.owner.releaseContractHandle(this.id, this)
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new SessionHandleClosedError(this.id, 'operation')
  }
}
