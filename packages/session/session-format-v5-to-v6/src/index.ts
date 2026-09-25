/** Adjacent V5-to-V6 migration preserving SSH target headers and every event. */

import { SessionFormatError, isSessionFormatJsonObject, snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatCodec, SessionFormatCurrentEncoder, SessionFormatHeader, SessionFormatMigration, SessionFormatMigrationStage, SessionFormatMigrationStageInput } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV5Header, releasedV5SessionFormatCodec, restoreReleasedV5Artifact } from '@deepseek-ai/dsh-session-format-v4-to-v5'

export { releasedV5SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v4-to-v5'

/**
 * Validate V6 logical metadata, including its optional integer sshTarget field.
 * @param header - detached V6 header.
 */
export function assertReleasedV6Header(header: SessionFormatHeader): void {
  if (header.version !== 6) throw new SessionFormatError('expected format v6 header')
  assertReleasedV5Header({ ...header, version: 5 })
}

/**
 * Validate current V6 events without changing their payloads or sequence numbers.
 * @param artifact - detached V6 artifact.
 * @param knownEventTypes - events understood by the installed Session package.
 * @returns the validated artifact with its V6 header.
 */
export function restoreReleasedV6Artifact(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): SessionFormatArtifact {
  assertReleasedV6Header(artifact.header)
  const restored = restoreReleasedV5Artifact({ ...artifact, header: { ...artifact.header, version: 5 } }, knownEventTypes)
  return { ...restored, header: artifact.header }
}

function v5PhysicalHeader(value: unknown): SessionFormatHeader {
  const header = snapshotSessionFormatJson(value, 'format v6 physical header')
  if (!isSessionFormatJsonObject(header) || header['version'] !== 6) {
    throw new SessionFormatError('expected format v6 physical Session header')
  }
  return { ...header, version: 5 } as SessionFormatHeader
}

/** V6 retains V5 event framing and admits the managed SSH target binding already emitted. */
export const releasedV6SessionFormatCodec = Object.freeze({
  version: 6,
  decodeHeader(value: unknown) {
    return { ...releasedV5SessionFormatCodec.decodeHeader(v5PhysicalHeader(value)), version: 6 }
  },
  createDecoder(value, recovery) {
    const decoder = releasedV5SessionFormatCodec.createDecoder(v5PhysicalHeader(value), recovery)
    return {
      header: { ...decoder.header, version: 6 },
      decodeRow: (row, context) => { decoder.decodeRow(row, context) },
      finish: context => decoder.finish(context),
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV6Header(header)
    return { ...releasedV5SessionFormatCodec.encodeHeader({ ...header, version: 5 }, inheritedEventCount), version: 6 }
  },
  encodeEvent: releasedV5SessionFormatCodec.encodeEvent,
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/** V5-to-V6 changes only the header version; SSH target metadata and body events retain their values. */
export const sessionFormatV5ToV6: SessionFormatMigration = Object.freeze({
  name: '@deepseek-ai/dsh-session-format-v5-to-v6',
  fromVersion: 5,
  toVersion: 6,
  migrateHeader(header: SessionFormatHeader) {
    assertReleasedV5Header(header)
    return { ...header, version: 6 }
  },
  createStage({ sourceHeader, sourceInheritedEventCount }: SessionFormatMigrationStageInput): SessionFormatMigrationStage {
    assertReleasedV5Header(sourceHeader)
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
          throw new SessionFormatError('format v5 seeded artifact has no inherited cut')
        }
        return inherited ?? 0
      },
    }
  },
  validateTargetHeader: assertReleasedV6Header,
})
