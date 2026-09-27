/**
 * Logical-artifact Session format catalog — the single admission and migration
 * rule source for backends that store decoded headers and event rows instead of
 * released physical JSONL (SQLite, Gateway/PostgreSQL, detached coordinator
 * reads). It reuses the released adjacent migration chain and current-artifact
 * restoration; the only difference from the physical catalog is the input
 * boundary: logical headers and events are projected onto the released
 * requirements, the declared CoHarness v0 and v2 database dialects are
 * normalized by {@link coharnessV0ToV1Dialect} and {@link coharnessV2ToV3Dialect},
 * and everything else is refused exactly as the released stages refuse it.
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import {
  createSessionFormatChain,
  inspectSessionFormatVersion,
  isSessionFormatJsonObject,
  SessionFormatError,
  SessionFormatUnsupportedMigrationError,
  sessionFormatCount,
  sessionFormatVersion,
  snapshotSessionFormatHeader,
} from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatArtifact,
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatHeaderReadResult,
  SessionFormatMigrationContext,
  SessionFormatMigrationStream,
} from '@deepseek-ai/dsh-session-format'
import { assertReleasedV1Header } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { assertReleasedV2Header } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import {
  assertReleasedV3Header,
  assertV3EventAdmission,
} from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertReleasedV4Header, assertV4EventAdmission, sessionFormatV3ToV4 } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { assertReleasedV5Header, sessionFormatV4ToV5 } from '@deepseek-ai/dsh-session-format-v4-to-v5'
import { assertReleasedV6Header, restoreReleasedV6Artifact, sessionFormatV5ToV6 } from '@deepseek-ai/dsh-session-format-v5-to-v6'
import { coharnessV0ToV1Dialect } from './coharness-v0-dialect.ts'
import { coharnessV1ToV2Dialect } from './coharness-v1-dialect.ts'
import { coharnessV2ToV3Dialect } from './coharness-v2-dialect.ts'
import { validateInstalledCurrentSessionArtifact, validateInstalledCurrentSessionHeader } from './current.ts'

/** Logical event envelope keys shared by every stored generation. */
const LOGICAL_EVENT_REQUIRED = ['type', 'seq', 'time', 'data'] as const
const LOGICAL_EVENT_KEYS: ReadonlySet<string> = new Set([
  ...LOGICAL_EVENT_REQUIRED,
  'ignorable',
  'sourceEventSeqs',
  'surfaceOp',
])

/** Logical header fields admitted by the stored-metadata dialect. */
const LOGICAL_HEADER_KEYS: ReadonlySet<string> = new Set([
  'version',
  'id',
  'createdAt',
  'cwd',
  'parentSession',
  'isSeeded',
  'seedLength',
  'origin',
  'delegationDepth',
  'agentPreset',
  'draft',
  'sshTarget',
])

/**
 * Project stored metadata onto the released logical header: `seedLength` is the
 * wire/database spelling of `isSeeded`, `delegationDepth` defaults to zero for
 * records that predate it, and any other key is refused rather than silently
 * carried into a migrated header.
 */
function projectLogicalHeader(value: unknown): SessionFormatHeader {
  if (!isSessionFormatJsonObject(value)) {
    throw new SessionFormatError('stored Session header must be a JSON object')
  }
  const record = value
  const unknown = Object.keys(record).find(key => !LOGICAL_HEADER_KEYS.has(key))
  if (unknown !== undefined) {
    throw new SessionFormatError(`stored Session header carries unsupported key ${JSON.stringify(unknown)}`)
  }
  const seedLength = record['seedLength']
  if (seedLength !== undefined) sessionFormatCount(seedLength, 'stored Session header seedLength')
  const isSeeded = record['isSeeded'] ?? seedLength !== undefined
  if (record['isSeeded'] !== undefined && seedLength !== undefined && record['isSeeded'] !== true) {
    throw new SessionFormatError('stored Session header seedLength contradicts isSeeded')
  }
  return {
    version: record['version'],
    id: record['id'],
    createdAt: record['createdAt'],
    ...(record['cwd'] === undefined ? {} : { cwd: record['cwd'] }),
    ...(record['parentSession'] === undefined ? {} : { parentSession: record['parentSession'] }),
    isSeeded,
    ...(record['origin'] === undefined ? {} : { origin: record['origin'] }),
    delegationDepth: record['delegationDepth'] ?? 0,
    ...(record['agentPreset'] === undefined ? {} : { agentPreset: record['agentPreset'] }),
    ...(record['draft'] === undefined ? {} : { draft: record['draft'] }),
    ...(record['sshTarget'] === undefined ? {} : { sshTarget: record['sshTarget'] }),
  } as SessionFormatHeader
}

/** Apply the released logical header rule for the artifact's declared version. */
function assertLogicalHeader(header: SessionFormatHeader): void {
  const version = sessionFormatVersion(header.version, 'stored Session header version')
  switch (version) {
    case 0:
      /* v0's logical header shares the released v1 key set; the version field
       * itself was already asserted by the dispatch. */
      assertReleasedV1Header({ ...header, version: 1 })
      return
    case 1:
      assertReleasedV1Header(header)
      return
    case 2:
      assertReleasedV2Header(header)
      return
    case 3:
      assertReleasedV3Header(header)
      return
    case 4:
      assertReleasedV4Header(header)
      return
    case 5:
      assertReleasedV5Header(header)
      return
    case 6:
      assertReleasedV6Header(header)
      return
    default:
      throw new SessionFormatUnsupportedMigrationError(
        `stored Session uses newer format v${version}; this build writes v6`,
      )
  }
}

/**
 * Per-event admission for decoded logical input, mirroring the released
 * physical codec's decoded-event checks: v3 rows run v3 admission, v4/v5/v6
 * rows run v4 admission (the v5/v6 codecs delegate to the v4 decoder), and
 * earlier generations rely on their migration stage's own source validation.
 * Payload validation of the migrated output runs once in `finish` through
 * `restoreReleasedV6Artifact`.
 */
function logicalEventAdmission(version: number): (event: SessionFormatEvent) => void {
  switch (version) {
    case 3:
      return assertV3EventAdmission
    case 4:
    case 5:
    case 6:
      return assertV4EventAdmission
    default:
      return () => {}
  }
}

/** Envelope-only admission shared by every stored logical event. */
function assertLogicalEventEnvelope(event: SessionFormatEvent, expected: number): void {
  if (!isSessionFormatJsonObject(event)) {
    throw new SessionFormatError(`stored Session event at seq ${expected} must be a JSON object`)
  }
  const missing = LOGICAL_EVENT_REQUIRED.find(key => !Object.hasOwn(event, key))
  if (missing !== undefined) {
    throw new SessionFormatError(`stored Session event at seq ${expected} lacks ${missing}`)
  }
  const unexpected = Object.keys(event).find(key => !LOGICAL_EVENT_KEYS.has(key))
  if (unexpected !== undefined) {
    throw new SessionFormatError(`stored Session event at seq ${expected} carries unsupported key ${JSON.stringify(unexpected)}`)
  }
  sessionFormatCount(event.seq, 'stored Session event seq')
  sessionFormatCount(event.time, 'stored Session event time')
  if (typeof event.type !== 'string' || event.type === '') {
    throw new SessionFormatError(`stored Session event at seq ${expected} type must be a string`)
  }
  if (event.seq !== expected) {
    throw new SessionFormatError('stored Session events must be dense')
  }
  if (event['ignorable'] !== undefined && event['ignorable'] !== true) {
    throw new SessionFormatError(`stored Session event at seq ${expected} ignorable must be true`)
  }
}

/**
 * Refuse compact runs at every logical boundary: stored rows are always
 * decoded events, no migration stage emits runs, and a migrated artifact is a
 * plain event list.
 */
function refuseLogicalRuns(): never {
  throw new SessionFormatError('stored Session logical streams carry no compact runs')
}

/** Message text for a caught diagnostic; throws at this boundary are always Errors. */
function errorDetail(error: unknown): string {
  /* v8 ignore next -- every throw that reaches this boundary is an Error; the
   * fallback only guards a foreign non-Error throw. */
  return error instanceof Error ? error.message : String(error)
}

/** The compiled logical chain shares released validation; the v0, v1, and v2 edges add dialect admission. */
const logicalChain = createSessionFormatChain({
  currentVersion: 6,
  migrations: [
    coharnessV0ToV1Dialect,
    coharnessV1ToV2Dialect,
    coharnessV2ToV3Dialect,
    sessionFormatV3ToV4,
    sessionFormatV4ToV5,
    sessionFormatV5ToV6,
  ],
  restoreCurrentHeader(header) {
    assertReleasedV6Header(header)
    validateInstalledCurrentSessionHeader(header)
    return header
  },
})

/**
 * Logical Session format operations shared by the SQLite/PostgreSQL
 * coordinator, the Gateway conversation endpoints, and detached restores.
 */
export const sessionLogicalFormatCatalog = {
  currentVersion: logicalChain.currentVersion,

  /** Classify stored logical metadata without reading event rows. */
  readHeader(headerValue: unknown): SessionFormatHeaderReadResult {
    let storedVersion: number | undefined
    try {
      storedVersion = inspectSessionFormatVersion(headerValue)
    } catch (error: unknown) {
      return {
        status: 'malformed',
        targetVersion: logicalChain.currentVersion,
        reason: errorDetail(error),
      }
    }
    if (storedVersion > logicalChain.currentVersion) {
      return {
        status: 'unsupported',
        storedVersion,
        targetVersion: logicalChain.currentVersion,
        reason: `stored Session uses newer format v${storedVersion}; this build writes v${logicalChain.currentVersion}`,
      }
    }
    try {
      const projected = projectLogicalHeader(headerValue)
      assertLogicalHeader(projected)
      const header = logicalChain.migrateHeader(snapshotSessionFormatHeader(projected, 'stored Session header'))
      return {
        status: storedVersion === logicalChain.currentVersion ? 'current' : 'migration-required',
        storedVersion,
        targetVersion: logicalChain.currentVersion,
        header,
      }
    } catch (error: unknown) {
      /* v8 ignore next 8 -- assertLogicalHeader already applied each released
       * stage's own header validator, so a stage-level refusal is defensive. */
      if (error instanceof SessionFormatUnsupportedMigrationError) {
        return {
          status: 'unsupported',
          storedVersion,
          targetVersion: logicalChain.currentVersion,
          reason: error.message,
        }
      }
      return {
        status: 'malformed',
        storedVersion,
        targetVersion: logicalChain.currentVersion,
        reason: errorDetail(error),
      }
    }
  },

  /** Convert stored logical metadata to the current header without reading event rows. */
  migrateHeader(source: SessionFormatHeader): SessionFormatHeader {
    const projected = projectLogicalHeader(source)
    assertLogicalHeader(projected)
    return logicalChain.migrateHeader(snapshotSessionFormatHeader(projected, 'stored Session header'))
  },

  /** Migrate one detached stored artifact into a validated current artifact. */
  migrate(
    source: SessionFormatHeader,
    events: readonly SessionFormatEvent[],
    inheritedEventCount: number | undefined,
  ): SessionFormatArtifact {
    const emitted: SessionFormatEvent[] = []
    const stream = this.createStream(source, inheritedEventCount, {
      emitEvent: event => emitted.push(event),
      emitRun: refuseLogicalRuns,
    })
    for (const event of events) stream.emitEvent(event)
    const cut = stream.finish()
    return {
      header: stream.header,
      inheritedEventCount: cut,
      events: emitted,
    }
  },

  /**
   * Compile the logical migration stream for one stored artifact. Emitted
   * events reach `context` as they settle; `finish` applies the released
   * current-artifact validation and returns the exact current inherited cut.
   */
  createStream(
    source: SessionFormatHeader,
    inheritedEventCount: number | undefined,
    context: SessionFormatMigrationContext,
  ): SessionFormatMigrationStream {
    const projected = projectLogicalHeader(source)
    assertLogicalHeader(projected)
    const sourceVersion = projected.version
    const admission = logicalEventAdmission(sourceVersion)
    const collected: SessionFormatEvent[] = []
    const stream = logicalChain.createStream(projected, inheritedEventCount, {
      emitEvent: (event) => {
        collected.push(event)
        context.emitEvent(event)
      },
      emitRun: refuseLogicalRuns,
    })
    let seen = 0
    let finished = false
    return {
      header: stream.header,
      emitEvent(raw: SessionFormatEvent): void {
        if (finished) throw new SessionFormatError('stored Session event stream is finished')
        assertLogicalEventEnvelope(raw, seen)
        seen += 1
        admission(raw)
        stream.emitEvent(raw)
      },
      emitRun: refuseLogicalRuns,
      finish(): number {
        finished = true
        const cut = stream.finish()
        try {
          const restored = restoreReleasedV6Artifact({
            header: stream.header,
            inheritedEventCount: cut,
            events: collected,
          }, KNOWN_SESSION_EVENT_TYPES)
          validateInstalledCurrentSessionArtifact(restored)
        } catch (error: unknown) {
          if (error instanceof SessionFormatUnsupportedMigrationError) throw error
          throw new SessionFormatUnsupportedMigrationError(
            `Session migration from v${sourceVersion} refuses the transformed artifact: ${errorDetail(error)}`,
            { cause: error },
          )
        }
        return cut
      },
    }
  },
} as const
