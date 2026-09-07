import { deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionFormatError } from './error.ts'
import type { SessionFormatArtifact, SessionFormatHeader, SessionFormatJsonObject } from './types.ts'

/** Require a non-negative safe integer.
 * @param value - candidate value.
 * @param label - diagnostic label.
 * @returns the validated integer.
 */
export function sessionFormatCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    throw new SessionFormatError(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

/** Read and validate a version without inspecting body rows.
 * @param value - candidate header.
 * @returns the stored format version.
 */
export function inspectSessionFormatVersion(value: unknown): number {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionFormatError('Session header must be a JSON object')
  }
  return sessionFormatCount((value as { version?: unknown }).version, 'Session format version')
}

/** Snapshot an arbitrary value at the durable JSON boundary.
 * @param value - value to snapshot.
 * @param label - diagnostic label.
 * @returns the lossless JSON snapshot.
 */
export function snapshotSessionFormatJson(value: unknown, label = 'Session value'): JsonValue {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) throw new SessionFormatError(`${label} is not lossless JSON`)
  return deepFreeze(snapshot) as JsonValue
}

/** Snapshot and validate one logical header.
 * @param value - header to snapshot.
 * @param label - diagnostic label.
 * @returns the validated header.
 */
export function snapshotSessionFormatHeader(value: SessionFormatHeader, label = 'Session header'): SessionFormatHeader {
  const snapshot = snapshotSessionFormatJson(value, label)
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new SessionFormatError(`${label} must be a JSON object`)
  }
  const record = snapshot
  inspectSessionFormatVersion(record)
  if (typeof record.id !== 'string' || record.id.length === 0) throw new SessionFormatError(`${label} id must be a non-empty string`)
  sessionFormatCount(record.createdAt, `${label} createdAt`)
  return record as SessionFormatHeader
}

/** Snapshot and validate one complete artifact's coordinates.
 * @param value - artifact to snapshot.
 * @param label - diagnostic label.
 * @returns the validated artifact.
 */
export function snapshotSessionFormatArtifact(value: SessionFormatArtifact, label = 'Session artifact'): SessionFormatArtifact {
  const snapshot = snapshotSessionFormatJson(value, label)
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) throw new SessionFormatError(`${label} must be an object`)
  const record = snapshot
  const header = record.header
  if (typeof header !== 'object' || header === null || Array.isArray(header)) throw new SessionFormatError(`${label} header must be an object`)
  snapshotSessionFormatHeader(header as SessionFormatHeader, `${label} header`)
  sessionFormatCount(record.inheritedEventCount, `${label} inheritedEventCount`)
  if (!Array.isArray(record.events)) throw new SessionFormatError(`${label} events must be an array`)
  const events = record.events as readonly unknown[]
  for (const [index, event] of events.entries()) {
    if (typeof event !== 'object' || event === null || Array.isArray(event)) throw new SessionFormatError(`${label} event ${index} must be an object`)
    const eventRecord = event as SessionFormatJsonObject
    if (eventRecord.seq !== index) throw new SessionFormatError(`${label} event ${index} has non-dense seq`)
    if (typeof eventRecord.type !== 'string' || eventRecord.type.length === 0) throw new SessionFormatError(`${label} event ${index} type must be non-empty`)
    sessionFormatCount(eventRecord.time, `${label} event ${index} time`)
    if (!Object.hasOwn(eventRecord, 'data')) throw new SessionFormatError(`${label} event ${index} lacks data`)
  }
  if ((record.inheritedEventCount as number) > events.length) throw new SessionFormatError(`${label} inheritedEventCount exceeds events`)
  return record as unknown as SessionFormatArtifact
}
