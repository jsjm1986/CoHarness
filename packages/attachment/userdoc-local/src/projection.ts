/** Ordered catalog delivery shares the identity transaction; acknowledgements release only a confirmed prefix. */
import type { DatabaseSync } from 'node:sqlite'
import type { UserDocRootId } from '@deepseek-ai/dsh-userdoc'
import { UserDocUploadOwnerId } from '@deepseek-ai/dsh-userdoc'
import type { DocumentIdentityChange, DocumentIdentityRecord } from './identity.ts'

/** Position within a committed mutation; one directory mutation can contain several document records. */
export interface DocumentProjectionCursor {
  readonly sequence: number
  readonly ordinal: number
}

/** One immutable committed document change, linked to its preceding delivery position. */
export interface DocumentProjectionChange {
  readonly cursor: DocumentProjectionCursor
  readonly previous: DocumentProjectionCursor
  readonly action: DocumentIdentityChange['kind']
  readonly committedAt: number
  /** Original authenticated initiator; absent is unknown, never inferred from the delivery caller. */
  readonly actor?: UserDocUploadOwnerId
  readonly document: DocumentIdentityRecord
}

/** A bounded prefix; a receiver acknowledges `next` only after every included change commits. */
export interface DocumentProjectionBatch {
  readonly rootId: UserDocRootId
  readonly after: DocumentProjectionCursor
  readonly head: DocumentProjectionCursor
  readonly next: DocumentProjectionCursor
  readonly changes: readonly DocumentProjectionChange[]
  readonly hasMore: boolean
}

/** Resolved transport bounds, including the serialized batch metadata. */
export interface DocumentProjectionReadOptions {
  readonly limit: number
  readonly maxBytes: number
}

const ACTIONS: readonly string[] = ['publish', 'adopt', 'trash', 'restore', 'purge', 'move', 'relocate', 'remove', 'observe', 'missing']

function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid document projection counter.')
  return value
}

function cursor(sequence: unknown, ordinal: unknown): DocumentProjectionCursor {
  const result = { sequence: counter(sequence), ordinal: counter(ordinal) }
  if ((result.sequence === 0) !== (result.ordinal === 0)) throw new Error('Invalid document projection position.')
  return result
}

function compare(left: DocumentProjectionCursor, right: DocumentProjectionCursor): number {
  return left.sequence === right.sequence ? left.ordinal - right.ordinal : left.sequence - right.sequence
}

/** Private table definitions installed with the identity domain's initial schema. */
export const DOCUMENT_PROJECTION_SCHEMA = `
  CREATE TABLE document_projection_progress (
    slot INTEGER PRIMARY KEY CHECK(slot=1),
    head_sequence INTEGER NOT NULL, head_ordinal INTEGER NOT NULL,
    ack_sequence INTEGER NOT NULL, ack_ordinal INTEGER NOT NULL
  ) STRICT;
  INSERT INTO document_projection_progress VALUES(1,0,0,0,0);
  CREATE TABLE document_projection_changes (
    sequence INTEGER NOT NULL CHECK(sequence>0), ordinal INTEGER NOT NULL CHECK(ordinal>0),
    previous_sequence INTEGER NOT NULL, previous_ordinal INTEGER NOT NULL,
    action TEXT NOT NULL, committed_at INTEGER NOT NULL, actor TEXT, document TEXT NOT NULL CHECK(json_valid(document)),
    PRIMARY KEY(sequence,ordinal)
  ) STRICT;`

/** The identity owner supplies the transaction and keeps this journal's database open through every call. */
export class DocumentProjectionJournal {
  /**
   * Verify delivery progress without loading the retained backlog into memory.
   * @param database - dedicated identity connection owned by the enclosing store.
   * @param rootId - durable filesystem domain bound by the receiving catalog.
   * @param decode - durable identity-record parser supplied by that domain.
   */
  constructor(
    private readonly database: DatabaseSync,
    private readonly rootId: UserDocRootId,
    private readonly decode: (value: unknown) => DocumentIdentityRecord,
  ) {
    const { head, acknowledged } = this.progress()
    const last = database.prepare('SELECT sequence,ordinal FROM document_projection_changes ORDER BY sequence DESC,ordinal DESC LIMIT 1').get()
    if (last === undefined ? compare(head, acknowledged) !== 0
      : compare(cursor(last.sequence, last.ordinal), head) !== 0 || compare(head, acknowledged) <= 0) {
      throw new Error('Document projection progress does not match its retained changes.')
    }
  }

  private progress(): { head: DocumentProjectionCursor; acknowledged: DocumentProjectionCursor } {
    const row = this.database.prepare('SELECT * FROM document_projection_progress WHERE slot=1').get()
    if (row === undefined) throw new Error('Document projection progress is missing.')
    const head = cursor(row.head_sequence, row.head_ordinal), acknowledged = cursor(row.ack_sequence, row.ack_ordinal)
    if (compare(acknowledged, head) > 0) throw new Error('Document projection acknowledgement exceeds its head.')
    return { head, acknowledged }
  }

  /**
   * Compare durable delivery progress without removing pending records.
   * @returns whether the receiver has yet to acknowledge the committed head.
   */
  hasPending(): boolean {
    const { head, acknowledged } = this.progress()
    return compare(head, acknowledged) > 0
  }

  /**
   * Append all records inside their metadata commit transaction; repeated commit must skip this call.
   * @param sequence - unique retained mutation sequence.
   * @param entries - committed records in their stable mutation order.
   * @returns after every linked delivery row and the head are written in the caller's transaction.
   */
  append(sequence: number, entries: readonly { change: DocumentIdentityChange; result: DocumentIdentityRecord }[]): void {
    if (entries.length === 0) return
    let previous = this.progress().head
    if (sequence <= previous.sequence) throw new Error('Document projection sequence did not advance.')
    const insert = this.database.prepare(`INSERT INTO document_projection_changes
      (sequence,ordinal,previous_sequence,previous_ordinal,action,committed_at,actor,document) VALUES(?,?,?,?,?,?,?,?)`)
    const committedAt = counter(Date.now())
    for (const [index, entry] of entries.entries()) {
      const next = { sequence, ordinal: index + 1 }
      insert.run(sequence, next.ordinal, previous.sequence, previous.ordinal, entry.change.kind, committedAt,
        entry.change.actor ?? null, JSON.stringify(entry.result))
      previous = next
    }
    this.database.prepare('UPDATE document_projection_progress SET head_sequence=?,head_ordinal=? WHERE slot=1')
      .run(previous.sequence, previous.ordinal)
  }

  private change(row: Record<string, unknown>): DocumentProjectionChange {
    const current = cursor(row.sequence, row.ordinal), previous = cursor(row.previous_sequence, row.previous_ordinal)
    if (typeof row.action !== 'string' || !ACTIONS.includes(row.action) || typeof row.document !== 'string'
      || compare(previous, current) >= 0 || current.sequence === 0) throw new Error('Invalid retained document projection change.')
    const value: unknown = JSON.parse(row.document)
    if (row.actor !== null && (typeof row.actor !== 'string' || row.actor.length === 0 || row.actor.length > 256
      || /[\u0000-\u001f\u007f]/u.test(row.actor))) throw new Error('Invalid retained document mutation actor.')
    return { cursor: current, previous, action: row.action as DocumentIdentityChange['kind'],
      committedAt: counter(row.committed_at), document: this.decode(value),
      ...row.actor === null ? {} : { actor: UserDocUploadOwnerId(row.actor) } }
  }

  /**
   * Read a linked prefix within both item and complete serialized-response bounds.
   * @param after - last position durably committed by the receiver.
   * @param options - resolved positive item and UTF-8 byte limits.
   * @returns a detached batch; an unavailable prefix or unrepresentable single change fails without discarding it.
   */
  read(after: DocumentProjectionCursor, options: DocumentProjectionReadOptions): DocumentProjectionBatch {
    cursor(after.sequence, after.ordinal)
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new RangeError('Document projection bounds must be positive safe integers.')
    }
    const { head, acknowledged } = this.progress()
    if (compare(after, acknowledged) < 0) throw new Error('The catalog checkpoint precedes the retained document projection.')
    if (compare(after, head) > 0) throw new Error('The catalog checkpoint exceeds the document projection head.')
    const changes: DocumentProjectionChange[] = []
    let next = after, encodedChanges = 0
    const batch = (): DocumentProjectionBatch => ({ rootId: this.rootId, after, head, next, changes, hasMore: compare(next, head) < 0 })
    if (Buffer.byteLength(JSON.stringify(batch())) > options.maxBytes) throw new RangeError('Document projection metadata exceeds its response budget.')
    const statement = this.database.prepare(`SELECT * FROM document_projection_changes
      WHERE (sequence,ordinal)>(?,?) ORDER BY sequence,ordinal LIMIT ?`)
    for (const row of statement.iterate(after.sequence, after.ordinal, options.limit)) {
      const change = this.change(row)
      if (compare(change.previous, next) !== 0) throw new Error('The retained document projection has a delivery gap.')
      const encoded = Buffer.byteLength(JSON.stringify(change))
      const candidate = { ...batch(), next: change.cursor, changes: [], hasMore: compare(change.cursor, head) < 0 }
      const bytes = Buffer.byteLength(JSON.stringify(candidate)) + encodedChanges + encoded + changes.length
      if (bytes > options.maxBytes) {
        if (changes.length === 0) throw new RangeError('One document projection change exceeds its response budget.')
        break
      }
      changes.push(change)
      encodedChanges += encoded
      next = change.cursor
    }
    if (changes.length === 0 && compare(next, head) < 0) throw new Error('The retained document projection has a delivery gap.')
    return batch()
  }

  /**
   * Release exactly a known committed prefix inside the caller's transaction.
   * @param through - position durably committed by the receiving catalog.
   * @returns after monotonic acknowledgement and prefix deletion; repeated older acknowledgements are harmless.
   */
  acknowledge(through: DocumentProjectionCursor): void {
    cursor(through.sequence, through.ordinal)
    const { head, acknowledged } = this.progress()
    if (compare(through, acknowledged) <= 0) return
    if (compare(through, head) > 0) throw new Error('The catalog acknowledgement exceeds the document projection head.')
    if (this.database.prepare('SELECT 1 FROM document_projection_changes WHERE sequence=? AND ordinal=?')
      .get(through.sequence, through.ordinal) === undefined) throw new Error('The catalog acknowledgement is not a committed document position.')
    this.database.prepare('UPDATE document_projection_progress SET ack_sequence=?,ack_ordinal=? WHERE slot=1')
      .run(through.sequence, through.ordinal)
    this.database.prepare('DELETE FROM document_projection_changes WHERE (sequence,ordinal)<=(?,?)').run(through.sequence, through.ordinal)
  }
}
