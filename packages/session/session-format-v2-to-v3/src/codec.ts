/** V3 framing with hard structural admission and recoverable canonical event validation. */

import { SessionFormatError, isSessionFormatJsonObject, snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatCodec,
  SessionFormatCurrentEncoder,
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatJsonValue,
} from '@deepseek-ai/dsh-session-format'
import { releasedV2SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertReleasedV3Header, assertV3EventAdmission } from './validation.ts'
import { assertV3Event, assertV3StructuralRow } from './payload.ts'

/** V3 codec validates structural rows before recovery and logical envelopes after source-event range decoding. */
export const releasedV3SessionFormatCodec = Object.freeze({
  version: 3,
  decodeHeader(value: unknown) {
    const { header, draft, sshTarget } = v2PhysicalHeader(value)
    return {
      ...releasedV2SessionFormatCodec.decodeHeader(header),
      ...(draft === undefined ? {} : { draft }),
      ...(sshTarget === undefined ? {} : { sshTarget }),
      version: 3,
    }
  },
  createDecoder(value, recovery) {
    const { header, draft, sshTarget } = v2PhysicalHeader(value)
    const decoder = releasedV2SessionFormatCodec.createDecoder(header, recovery)
    let issue: SessionFormatError | undefined
    let acceptedInheritedCut: number | undefined
    return {
      header: {
        ...decoder.header,
        ...(draft === undefined ? {} : { draft }),
        ...(sshTarget === undefined ? {} : { sshTarget }),
        version: 3,
      },
      decodeRow(row, context) {
        assertV3RowAdmission(row)
        decoder.decodeRow(row, {
          emitRun: context.emitRun.bind(context),
          emitEvent(event) {
            assertV3EventAdmission(event)
            if (issue === undefined) {
              try {
                assertV3Event(event)
              } catch (error: unknown) {
                // The frozen event validator reports every decoded JSON violation as SessionFormatError.
                const invalid = error as SessionFormatError
                if (recovery === 'strict') throw invalid
                issue = invalid
              }
            }
            if (issue !== undefined) {
              if (event.type === 'turn/end') throw issue
              return
            }
            if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data)
              && event.data['inherited'] === true) acceptedInheritedCut = event.seq
            context.emitEvent(event)
          },
        })
      },
      finish(context) {
        if (issue === undefined) return decoder.finish(context)
        if (decoder.header.isSeeded && acceptedInheritedCut === undefined) {
          throw new SessionFormatError('format v3 seeded Session lacks an accepted inherited end-seed marker')
        }
        if (!decoder.header.isSeeded && acceptedInheritedCut !== undefined) {
          throw new SessionFormatError('format v3 unseeded Session contains an inherited end-seed marker')
        }
        return acceptedInheritedCut ?? 0
      },
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV3Header(header)
    const { draft, sshTarget, ...rest } = header
    return {
      ...releasedV2SessionFormatCodec.encodeHeader({ ...rest, version: 2 }, inheritedEventCount),
      ...(draft === undefined ? {} : { draft }),
      ...(sshTarget === undefined ? {} : { sshTarget }),
      version: 3,
    }
  },
  encodeEvent(event) {
    assertV3EventAdmission(event)
    assertV3Event(event)
    return releasedV2SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/**
 * Validate owned V3 admission rules before a scanner or codec can discard a recoverable tail.
 * This checks only identified structural payloads; physical source-event ranges still belong to decoding.
 * @param row - parsed physical row, before envelope or compressed-range decoding.
 */
export function assertV3RowAdmission(row: unknown): void {
  assertV3StructuralRow(row)
  if (typeof row === 'object' && row !== null && !Array.isArray(row)) assertV3EventAdmission(row as SessionFormatEvent)
}

function v2PhysicalHeader(value: unknown): {
  readonly header: SessionFormatHeader
  readonly draft: SessionFormatJsonValue | undefined
  readonly sshTarget: SessionFormatJsonValue | undefined
} {
  const header = snapshotSessionFormatJson(value, 'format v3 physical header')
  if (!isSessionFormatJsonObject(header) || header['version'] !== 3) {
    throw new SessionFormatError('expected format v3 physical Session header')
  }
  // `draft` and `sshTarget` postdate the v2 layer's released key set, so they
  // are lifted out here and re-attached by the caller.
  const { draft, sshTarget, ...rest } = header
  if (draft !== undefined && typeof draft !== 'boolean') {
    throw new SessionFormatError('format v3 header draft must be boolean')
  }
  if (sshTarget !== undefined
    && (typeof sshTarget !== 'number' || !Number.isSafeInteger(sshTarget) || sshTarget <= 0)) {
    throw new SessionFormatError('format v3 header sshTarget must be a positive safe integer')
  }
  return { header: { ...rest, version: 2 } as SessionFormatHeader, draft, sshTarget }
}
