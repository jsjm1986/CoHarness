/** Released CoHarness JSONL framing, composed with the generated adjacent migration inventory. */
import {
  createSessionFormatCatalog, isSessionFormatJsonObject, SessionFormatError,
  type SessionFormatCatalog, type SessionFormatCodec, type SessionFormatHeader, type SessionFormatJsonObject,
  type SessionFormatRestore, type SessionFormatRestoreOptions,
} from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { sessionFormatCatalog, sessionFormatCatalogOptions } from './generated.ts'
import { coharnessV0ToV1Dialect } from './coharness-v0-dialect.ts'
import { coharnessV1ToV2Dialect } from './coharness-v1-dialect.ts'
import { coharnessJsonlV2ToV3Dialect } from './coharness-v2-dialect.ts'
import { hideDialectMembers, restoreDialectMembers } from './coharness-dialect-members.ts'

function legacyHeader(value: unknown): value is SessionFormatJsonObject {
  return isSessionFormatJsonObject(value) && (value['version'] === 0 || value['version'] === 1
    || (value['version'] === 2 || value['version'] === 3) && !Object.hasOwn(value, 'isSeeded'))
}

function framedHeader(value: unknown, version: number): unknown {
  // The catalog has already selected this codec by the validated header version.
  return { ...value as SessionFormatJsonObject, version: version === 0 ? 0 : 1 }
}

function legacyCodec(version: number): SessionFormatCodec {
  const framing = version === 0 ? releasedV0SessionFormatCodec : releasedV1SessionFormatCodec
  return {
    version,
    decodeHeader(value) {
      return { ...framing.decodeHeader(framedHeader(value, version)), version }
    },
    createDecoder(value, recovery) {
      const decoder = framing.createDecoder(framedHeader(value, version), recovery)
      return {
        header: { ...decoder.header, version },
        headerInheritedEventCount: decoder.headerInheritedEventCount,
        decodeRow(row, context) {
          decoder.decodeRow(row, {
            emitRun: context.emitRun.bind(context),
            emitEvent(event) {
              const dialect = hideDialectMembers(event)
              const restored = restoreDialectMembers(dialect.event, dialect)
              if (version === 3 && decoder.header.isSeeded && event.type === 'session/end-seed'
                && event.seq === decoder.headerInheritedEventCount) {
                if (!isSessionFormatJsonObject(restored.data)
                  || restored.data['inherited'] !== undefined && restored.data['inherited'] !== true) {
                  throw new SessionFormatError('CoHarness inherited seed marker contradicts its header cut')
                }
                context.emitEvent({ ...restored, data: { ...restored.data, inherited: true } })
              } else {
                context.emitEvent(restored)
              }
            },
          })
        },
        finish: decoder.finish.bind(decoder),
      }
    },
  }
}

const dialectCatalog = createSessionFormatCatalog({
  ...sessionFormatCatalogOptions,
  codecs: sessionFormatCatalogOptions.codecs.map(codec => codec.version <= 3 ? legacyCodec(codec.version) : codec),
  migrations: sessionFormatCatalogOptions.migrations.map((migration) => {
    switch (migration.fromVersion) {
      case 0: return coharnessV0ToV1Dialect
      case 1: return coharnessV1ToV2Dialect
      case 2: return coharnessJsonlV2ToV3Dialect
      default: return migration
    }
  }),
})

function detachDraft(value: SessionFormatJsonObject): { header: unknown; draft: boolean | undefined } {
  const { draft, ...header } = value
  if (draft !== undefined && typeof draft !== 'boolean') throw new SessionFormatError('CoHarness JSONL draft must be boolean')
  return { header, draft }
}

function withDraft(header: SessionFormatHeader, draft: boolean | undefined): SessionFormatHeader {
  return draft === undefined ? header : { ...header, draft }
}

function restore(value: unknown, options: SessionFormatRestoreOptions, stored: boolean): SessionFormatRestore {
  if (!legacyHeader(value)) {
    return stored ? sessionFormatCatalog.createStoredRestore(value, options) : sessionFormatCatalog.createRestore(value, options)
  }
  const source = detachDraft(value)
  const reader = stored ? dialectCatalog.createStoredRestore(source.header, options) : dialectCatalog.createRestore(source.header, options)
  return {
    header: withDraft(reader.header, source.draft),
    decodeRow: reader.decodeRow.bind(reader),
    finish() {
      const artifact = reader.finish()
      return { ...artifact, header: withDraft(artifact.header, source.draft) }
    },
  }
}

/**
 * CoHarness JSONL readers admit the declared v0–v3 seedLength and packed-stream
 * dialect. Released isSeeded headers and current writes retain the generated
 * codec rules; every historical body still traverses the adjacent chain.
 */
export const coharnessJsonlFormatCatalog = Object.freeze<SessionFormatCatalog>({
  ...sessionFormatCatalog,
  readHeader(value) {
    if (!legacyHeader(value)) return sessionFormatCatalog.readHeader(value)
    try {
      const source = detachDraft(value)
      const result = dialectCatalog.readHeader(source.header)
      return result.status === 'migration-required'
        ? { ...result, header: withDraft(result.header, source.draft) } : result
    } catch (error) {
      return { status: 'malformed', targetVersion: sessionFormatCatalog.currentVersion,
        reason: String(error) }
    }
  },
  createRestore: (value, options) => restore(value, options, false),
  createStoredRestore: (value, options) => restore(value, options, true),
})
