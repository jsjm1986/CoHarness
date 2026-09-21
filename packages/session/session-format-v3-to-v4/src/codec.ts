/** V4 framing: V3 physical rows minus the pre-fold `assistant/chunk` row kind. */

import { SessionFormatError, SessionFormatUnsupportedMigrationError, isSessionFormatJsonObject, snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatCodec,
  SessionFormatCurrentEncoder,
  SessionFormatEvent,
  SessionFormatHeader,
} from '@deepseek-ai/dsh-session-format'
import { assertV3EventAdmission, assertV3RowAdmission, releasedV3SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertReleasedV4Header } from './validation.ts'

/**
 * V4 codec: V3 physical framing where every assistant event is already settled.
 * `assistant/chunk` rows are refused; they exist only on the v3 side of the fold.
 */
export const releasedV4SessionFormatCodec = Object.freeze({
  version: 4,
  decodeHeader(value: unknown) {
    return { ...releasedV3SessionFormatCodec.decodeHeader(v3PhysicalHeader(value)), version: 4 }
  },
  createDecoder(value, recovery) {
    const decoder = releasedV3SessionFormatCodec.createDecoder(v3PhysicalHeader(value), recovery)
    return {
      header: { ...decoder.header, version: 4 },
      decodeRow(row, context) {
        assertV4RowAdmission(row)
        decoder.decodeRow(row, {
          emitRun: context.emitRun.bind(context),
          emitEvent(event) {
            assertV4EventAdmission(event)
            context.emitEvent(event)
          },
        })
      },
      finish(context) {
        return decoder.finish(context)
      },
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV4Header(header)
    return {
      ...releasedV3SessionFormatCodec.encodeHeader({ ...header, version: 3 }, inheritedEventCount),
      version: 4,
    }
  },
  encodeEvent(event) {
    assertV4EventAdmission(event)
    return releasedV3SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/**
 * Refuse the folded chunk row kind and the retired dispatch pair before V3 admission.
 * @param event - the decoded V4 event to validate.
 */
export function assertV4EventAdmission(event: SessionFormatEvent): void {
  if (event.type === 'assistant/chunk') {
    throw new SessionFormatError('format v4 stores settled assistant events; assistant/chunk is a v3 row')
  }
  if ((event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch')
    && event['ignorable'] !== true) {
    throw new SessionFormatUnsupportedMigrationError(
      'format v4 contains unknown event type ' + JSON.stringify(event.type) + ' at seq ' + String(event.seq),
    )
  }
  assertV3EventAdmission(event)
}

/**
 * V4 physical-row admission: V3 structure plus the chunk and dispatch refusals.
 * @param row - the decoded JSONL row to validate.
 */
export function assertV4RowAdmission(row: unknown): void {
  if (isSessionFormatJsonObject(row)) assertV4EventAdmission(row as SessionFormatEvent)
  assertV3RowAdmission(row)
}

function v3PhysicalHeader(value: unknown): SessionFormatHeader {
  const header = snapshotSessionFormatJson(value, 'format v4 physical header')
  if (!isSessionFormatJsonObject(header) || header['version'] !== 4) {
    throw new SessionFormatError('expected format v4 physical Session header')
  }
  return { ...header, version: 3 } as SessionFormatHeader
}
