/** V7 framing with native tool-role admission and released physical rows. */

import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatCodec, SessionFormatCurrentEncoder, SessionFormatHeader, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { releasedV2SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { releasedV6SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v5-to-v6'
import { assertV7SourceRowAdmission } from './message-sources.ts'
import { assertV7RetiredSyntax } from './retired-syntax.ts'
import { assertV7SystemMessageFields } from './system-message.ts'
import { assertV7DeveloperData } from './developer.ts'
import { assertV7ForkResult } from './fork-result.ts'
import { assertV7ToolResultMessage } from './tool-role.ts'
import { assertReleasedV7Header } from './validation.ts'

/** Logical V7 header arrives through the V6 chain, which owns draft and sshTarget physical keys. */
function logicalV6(value: unknown): SessionFormatHeader {
  if (!isSessionFormatJsonObject(value) || value['version'] !== 7) {
    throw new SessionFormatError('expected format v7 header')
  }
  return { ...releasedV6SessionFormatCodec.decodeHeader({ ...value, version: 6 }), version: 7 }
}

/**
 * Feed the physical row decoder a V2-compatible header: the V7 row surface
 * shares only V2's envelope keys, so `draft` and `sshTarget` are spliced out.
 */
function physicalV2(value: unknown): SessionFormatHeader {
  if (!isSessionFormatJsonObject(value) || value['version'] !== 7) throw new SessionFormatError('expected format v7 physical header')
  const { draft: _draft, sshTarget: _sshTarget, ...rest } = value
  return { ...rest, version: 2 } as SessionFormatHeader
}

/**
 * V7 physical rows retain released V2 envelope framing while V7 admission
 * validates the native producer-source and tool-role messages directly.
 * V3-V6 row admission is skipped: those generations require retired source
 * and content shapes that V7 has already replaced.
 */
export const releasedV7SessionFormatCodec = Object.freeze({
  version: 7,
  decodeHeader(value: unknown) {
    return logicalV6(value)
  },
  createDecoder(value, recovery) {
    const decoder = releasedV2SessionFormatCodec.createDecoder(physicalV2(value), recovery)
    return {
      ...decoder,
      header: logicalV6(value),
      decodeRow(row, context) {
        assertV7RowAdmission(row)
        decoder.decodeRow(row, {
          emitRun: context.emitRun.bind(context),
          emitEvent: context.emitEvent.bind(context),
        })
      },
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV7Header(header)
    return { ...releasedV6SessionFormatCodec.encodeHeader({ ...header, version: 6 }, inheritedEventCount), version: 7 }
  },
  encodeEvent(event: SessionFormatEvent) {
    if (event.type === 'developer/message' && event['ignorable'] === true) {
      assertV7DeveloperData(event)
      assertV7RetiredSyntax(event)
    }
    assertV7RowAdmission(event)
    return releasedV2SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/**
 * Apply native V7 admission before a scanner discards a recoverable suffix.
 * Ignorable developer payloads require reader vocabulary; physical decoding defers them.
 * @param row - parsed physical row before framing and source-event range decoding.
 * @param knownEventTypes - installed event types, supplied by native readers before tail recovery.
 */
export function assertV7RowAdmission(row: unknown, knownEventTypes?: ReadonlySet<string>): void {
  if (isSessionFormatJsonObject(row)) {
    if (row['type'] === 'developer/message' && row['ignorable'] === true
      && knownEventTypes?.has('developer/message') !== true) return
    assertV7DeveloperData(row)
  }
  assertV7SourceRowAdmission(row)
  assertV7RetiredSyntax(row)
  assertV7SystemMessageFields(row)
  if (!isSessionFormatJsonObject(row) || row['type'] !== 'tool/result') return
  assertV7ToolResultMessage(row)
  assertV7ForkResult(row)
}
