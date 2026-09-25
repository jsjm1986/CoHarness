/**
 * Shared hide/re-attach mechanics for the CoHarness database dialects.
 * Stored SQLite/PostgreSQL Sessions carry members the released vocabularies
 * do not name (`permission/preset.origin`, message `source.documents`, and
 * `source.participant.scope.canManage`) but the current schema records.
 * Each dialect edge hides the members before released admission sees the
 * event and re-attaches them to the emitted event, so no recorded field is
 * lost and payloads outside the dialect stay refused.
 */

import { SessionFormatError } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatJsonValue,
} from '@deepseek-ai/dsh-session-format'

/** Whether a persisted JSON value is an object record. */
function isRecord(value: unknown): value is Record<string, SessionFormatJsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Origins the dialect's `permission/preset` writer recorded ahead of the released schema. */
const DIALECT_PRESET_ORIGINS: ReadonlySet<string> = new Set(['default', 'selection', 'inferred'])

/**
 * Whether the event is a dialect-only type the released vocabularies never
 * classified: `userdoc/attached` in its declared `version: 1` form. These
 * events bypass released admission entirely — the current schema records the
 * type, and the restore gate validates the migrated artifact. Malformed
 * payloads throw rather than widen the tunnel.
 * @param event Stored event the edge is about to admit.
 * @returns Whether the event is a well-formed dialect-only type.
 */
export function isDialectOnlyEvent(event: SessionFormatEvent): boolean {
  if (event.type !== 'userdoc/attached') return false
  const data = isRecord(event.data) ? event.data : undefined
  if (data === undefined || data['version'] !== 1
    || typeof data['messageId'] !== 'string' || !Number.isSafeInteger(data['index'])
    || !isRecord(data['ref']) || !isRecord(data['representation'])
    || (data['representation']['kind'] !== 'path' && data['representation']['kind'] !== 'inline')) {
    throw new SessionFormatError(`stored dialect userdoc/attached ${event.seq} has an undeclared payload`)
  }
  return true
}

/**
 * One hidden member re-attachment. `field` names where the cleaned `source`
 * record sits inside `data` — `source` itself or `inserted`/`messages` array
 * items — and `index` selects the array position when the field is a list.
 */
export interface HiddenSourceMember {
  readonly field: 'source' | 'inserted' | 'messages'
  readonly index?: number
  /** Hidden `source.documents` attachment list. */
  readonly documents?: readonly SessionFormatJsonValue[]
  /** Hidden `source.participant.scope.canManage` flag. */
  readonly canManage?: boolean
}

/** Members removed from one source record; absent means nothing was hidden. */
interface RemovedSourceMembers {
  documents: readonly SessionFormatJsonValue[] | undefined
  canManage: boolean | undefined
}

/** Per-event dialect ledger: the cleaned event plus every member hidden from released admission. */
export interface DialectEvent {
  readonly event: SessionFormatEvent
  readonly presetOrigin: SessionFormatJsonValue | undefined
  readonly sourceMembers: readonly HiddenSourceMember[]
}

/**
 * Remove dialect members from one source record when the released user-source
 * rule would refuse them. Returns the cleaned source plus the removed values,
 * or undefined when nothing needs hiding — including malformed shapes the
 * released stage itself must classify. Only `kind: 'user'` sources hide
 * `documents`: the released key assertion applies there while other kinds
 * admit unknown members.
 */
function hideSourceMembers(
  source: unknown,
): { source: Record<string, SessionFormatJsonValue>; removed: RemovedSourceMembers } | undefined {
  if (!isRecord(source)) return undefined
  const removed: RemovedSourceMembers = { documents: undefined, canManage: undefined }
  let cleaned = source
  if (source['kind'] === 'user' && Array.isArray(source['documents'])) {
    removed.documents = source['documents'] as readonly SessionFormatJsonValue[]
    cleaned = { ...cleaned }
    delete cleaned['documents']
  }
  const participant = cleaned['participant']
  if (isRecord(participant)) {
    const scope = participant['scope']
    if (isRecord(scope) && scope['kind'] === 'project' && typeof scope['canManage'] === 'boolean') {
      removed.canManage = scope['canManage']
      const cleanScope = { ...scope }
      delete cleanScope['canManage']
      cleaned = { ...cleaned, participant: { ...participant, scope: cleanScope } }
    }
  }
  if (removed.documents === undefined && removed.canManage === undefined) return undefined
  return { source: cleaned, removed }
}

/** Re-attach hidden members into an emitted source record. */
function restoreSource(
  source: unknown,
  removed: RemovedSourceMembers,
): unknown {
  if (!isRecord(source)) return source
  let restored = source
  if (removed.documents !== undefined && restored['documents'] === undefined) {
    restored = { ...restored, documents: [...removed.documents] }
  }
  if (removed.canManage !== undefined && isRecord(restored['participant'])
    && isRecord(restored['participant']['scope']) && restored['participant']['scope']['canManage'] === undefined) {
    restored = {
      ...restored,
      participant: {
        ...restored['participant'],
        scope: { ...restored['participant']['scope'], canManage: removed.canManage },
      },
    }
  }
  return restored
}

/**
 * Normalize one stored event onto the released vocabulary: the descriptor
 * stamp is rewritten permanently (v2 data satisfies the identical v3 schema),
 * while dialect members are hidden and recorded for post-emission restore.
 * @param raw Stored event exactly as the database returned it.
 * @returns The released-vocabulary event plus its hidden-member ledger.
 */
export function hideDialectMembers(raw: SessionFormatEvent): DialectEvent {
  const data = isRecord(raw.data) ? raw.data : undefined
  if (data === undefined) return { event: raw, presetOrigin: undefined, sourceMembers: [] }

  let event = raw
  let presetOrigin: SessionFormatJsonValue | undefined
  const sourceMembers: HiddenSourceMember[] = []

  if (event.type === 'permission/preset' && data['origin'] !== undefined) {
    if (typeof data['origin'] === 'string' && DIALECT_PRESET_ORIGINS.has(data['origin'])) {
      presetOrigin = data['origin']
      const cleanData = { ...data }
      delete cleanData['origin']
      event = { ...event, data: cleanData }
    }
  }

  if (event.type === 'subagent/descriptor' && data['version'] === 2) {
    event = { ...event, data: { ...data, version: 3 } }
  }

  const eventData = isRecord(event.data) ? event.data : undefined
  if (eventData === undefined) return { event, presetOrigin, sourceMembers }

  const direct = hideSourceMembers(eventData['source'])
  if (direct !== undefined) {
    if (direct.removed.documents !== undefined) {
      sourceMembers.push({ field: 'source', documents: direct.removed.documents })
    }
    if (direct.removed.canManage !== undefined) {
      sourceMembers.push({ field: 'source', canManage: direct.removed.canManage })
    }
    event = { ...event, data: { ...eventData, source: direct.source } }
  }

  for (const field of ['inserted', 'messages'] as const) {
    const list = eventData[field]
    if (!Array.isArray(list)) continue
    let patched: SessionFormatJsonValue[] | undefined
    for (let index = 0; index < list.length; index += 1) {
      const item: unknown = list[index]
      if (!isRecord(item)) continue
      const hidden = hideSourceMembers(item['source'])
      if (hidden === undefined) continue
      if (hidden.removed.documents !== undefined) {
        sourceMembers.push({ field, index, documents: hidden.removed.documents })
      }
      if (hidden.removed.canManage !== undefined) {
        sourceMembers.push({ field, index, canManage: hidden.removed.canManage })
      }
      patched ??= list.slice()
      patched[index] = { ...item, source: hidden.source }
    }
    if (patched !== undefined) {
      const current = isRecord(event.data) ? event.data : eventData
      event = { ...event, data: { ...current, [field]: patched } }
    }
  }

  return { event, presetOrigin, sourceMembers }
}

/**
 * Re-attach one event's hidden members to the event the edge emitted. The
 * emitted `data` payload is copied, never mutated, and members are only
 * restored into positions that do not already carry a value.
 * @param emitted Event the released edge produced for `dialect.event`.
 * @param dialect Hidden-member ledger recorded by {@link hideDialectMembers}.
 * @returns The emitted event with its hidden dialect members re-attached.
 */
export function restoreDialectMembers(emitted: SessionFormatEvent, dialect: DialectEvent): SessionFormatEvent {
  if (dialect.presetOrigin === undefined && dialect.sourceMembers.length === 0) return emitted
  const data = isRecord(emitted.data) ? { ...emitted.data } : undefined
  if (data === undefined) {
    /* The released stage emits a record payload for every admitted type; a
     * non-record emission means the source was never ours to restore. */
    return emitted
  }
  if (dialect.presetOrigin !== undefined && emitted.type === 'permission/preset') {
    data['origin'] = dialect.presetOrigin
  }
  for (const member of dialect.sourceMembers) {
    const removed = { documents: member.documents, canManage: member.canManage }
    if (member.field === 'source') {
      data['source'] = restoreSource(data['source'], removed) as SessionFormatJsonValue
      continue
    }
    const list = data[member.field]
    if (!Array.isArray(list) || member.index === undefined || member.index >= list.length) continue
    const item: unknown = list[member.index]
    if (!isRecord(item)) continue
    const patched = list.slice()
    patched[member.index] = { ...item, source: restoreSource(item['source'], removed) as SessionFormatJsonValue }
    data[member.field] = patched
  }
  return { ...emitted, data }
}
