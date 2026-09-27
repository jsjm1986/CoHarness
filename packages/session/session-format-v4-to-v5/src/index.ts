/** Adjacent V4-to-V5 migration preserving draft headers and every event. */

import { SessionFormatError, isSessionFormatJsonObject, snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatCodec, SessionFormatCurrentEncoder, SessionFormatHeader, SessionFormatMigration, SessionFormatMigrationStage, SessionFormatMigrationStageInput } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header, releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'

export { releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'

/**
 * Validate V5 logical metadata, including its optional boolean draft field.
 * @param header - detached V5 header.
 */
export function assertReleasedV5Header(header: SessionFormatHeader): void {
  if (header.version !== 5) throw new SessionFormatError('expected format v5 header')
  assertReleasedV4Header({ ...header, version: 4 })
}

/**
 * Validate current V5 events without changing their payloads or sequence numbers.
 * @param artifact - detached V5 artifact.
 * @param knownEventTypes - events understood by the installed Session package.
 * @returns the validated artifact with its V5 header.
 */
export function restoreReleasedV5Artifact(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): SessionFormatArtifact {
  assertReleasedV5Header(artifact.header)
  const restored = restoreReleasedV4Artifact({ ...artifact, header: { ...artifact.header, version: 4 } }, knownEventTypes)
  return { ...restored, header: artifact.header }
}

function v4PhysicalHeader(value: unknown): SessionFormatHeader {
  const header = snapshotSessionFormatJson(value, 'format v5 physical header')
  if (!isSessionFormatJsonObject(header) || header['version'] !== 5) {
    throw new SessionFormatError('expected format v5 physical Session header')
  }
  return { ...header, version: 4 } as SessionFormatHeader
}

/** V5 retains V4 event framing and admits the fork's already-emitted boolean draft metadata. */
export const releasedV5SessionFormatCodec = Object.freeze({
  version: 5,
  decodeHeader(value: unknown) {
    return { ...releasedV4SessionFormatCodec.decodeHeader(v4PhysicalHeader(value)), version: 5 }
  },
  createDecoder(value, recovery) {
    const decoder = releasedV4SessionFormatCodec.createDecoder(v4PhysicalHeader(value), recovery)
    return {
      header: { ...decoder.header, version: 5 },
      decodeRow: (row, context) => { decoder.decodeRow(row, context) },
      finish: context => decoder.finish(context),
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV5Header(header)
    return { ...releasedV4SessionFormatCodec.encodeHeader({ ...header, version: 4 }, inheritedEventCount), version: 5 }
  },
  encodeEvent: releasedV4SessionFormatCodec.encodeEvent,
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/** V4-to-V5 changes only the header version; draft metadata and body events retain their values. */
export const sessionFormatV4ToV5: SessionFormatMigration = Object.freeze({
  name: '@deepseek-ai/dsh-session-format-v4-to-v5',
  fromVersion: 4,
  toVersion: 5,
  migrateHeader(header: SessionFormatHeader) {
    assertReleasedV4Header(header)
    return { ...header, version: 5 }
  },
  createStage({ sourceHeader, sourceInheritedEventCount }: SessionFormatMigrationStageInput): SessionFormatMigrationStage {
    assertReleasedV4Header(sourceHeader)
    let inherited = sourceInheritedEventCount
    return {
      ...(inherited === undefined ? {} : { headerInheritedEventCount: inherited }),
      transformEvent(event, context) {
        if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data) && event.data['inherited'] === true) {
          inherited = event.seq
        }
        context.emitEvent(event)
      },
      transformRun(run, context) {
        for (const event of run.expand()) this.transformEvent(event, context)
      },
      finish() {
        if (sourceHeader['isSeeded'] && inherited === undefined) {
          throw new SessionFormatError('format v4 seeded artifact has no inherited cut')
        }
        return inherited ?? 0
      },
    }
  },
  validateTargetHeader: assertReleasedV5Header,
})
