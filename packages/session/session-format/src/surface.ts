/** Wire-level Session surface envelope shared by every boundary that validates a raw event. */

/**
 * Event types whose wire envelopes carry surface placement: a required
 * `surfaceOp` and an optional `sourceEventSeqs` citation. This set is the
 * wire-format projection of the runtime's `SurfaceEventType` union in
 * `@deepseek-ai/dsh-session`; both sides read this one constant so an intake
 * gate can never lag the vocabulary the runtime writes.
 */
export const SESSION_SURFACE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'system/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * Whether an event type's wire envelope carries surface placement.
 * @param type - wire event type.
 * @returns true when the type's envelope owns `surfaceOp` and may cite `sourceEventSeqs`.
 */
export function isSessionSurfaceEventType(type: string): boolean {
  return SESSION_SURFACE_EVENT_TYPES.has(type)
}

/**
 * Whether a wire `surfaceOp` value is well formed. Readers accept the
 * canonical `startSeq`/`endSeq` replacement keys and the pre-rename
 * `start`/`end` pair still present in logs written before the rename.
 * @param value - unvalidated wire `surfaceOp`.
 * @returns true for `'append'` or an exact positional `replace` operation.
 */
export function isSessionSurfaceOp(value: unknown): boolean {
  if (value === 'append') return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const op = value as Record<string, unknown>
  return op['op'] === 'replace'
    && Object.keys(op).length === 3
    && ((Object.hasOwn(op, 'startSeq') && Object.hasOwn(op, 'endSeq')
      && isSeq(op['startSeq']) && isSeq(op['endSeq']))
      || (Object.hasOwn(op, 'start') && Object.hasOwn(op, 'end')
        && isSeq(op['start']) && isSeq(op['end'])))
}

/** Whether a runtime value is a non-negative safe event sequence. */
function isSeq(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}
