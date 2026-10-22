/** Released CoHarness JSONL framing, composed with the generated adjacent migration inventory. */
import {
  createSessionFormatCatalog, isSessionFormatJsonObject, SessionFormatError,
  type SessionFormatCatalog, type SessionFormatCodec, type SessionFormatHeader, type SessionFormatJsonObject,
  type SessionFormatJsonValue, type SessionFormatMigration,
  type SessionFormatRestore, type SessionFormatRestoreOptions,
} from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { createSessionFormatV6ToV7, sessionFormatV6ToV7 } from '@deepseek-ai/dsh-session-format-v6-to-v7'
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

/**
 * Physical codec swap for released CoHarness JSONL framing (v0–v3 seedLength and packed-stream dialect).
 * @param codec - generated first-party codec for one version.
 * @returns the dialect-aware codec for versions up to v3, otherwise the input codec.
 */
export function coharnessDialectCodec(codec: SessionFormatCodec): SessionFormatCodec {
  return codec.version <= 3 ? legacyCodec(codec.version) : codec
}

/**
 * Migration-edge swap for the released CoHarness JSONL dialect fixups.
 * @param migration - generated first-party adjacent migration edge.
 * @returns the CoHarness dialect edge for v0→v1, v1→v2, and v2→v3; the input edge otherwise.
 */
export function coharnessDialectMigration(migration: SessionFormatMigration): SessionFormatMigration {
  switch (migration.fromVersion) {
    case 0: return coharnessV0ToV1Dialect
    case 1: return coharnessV1ToV2Dialect
    case 2: return coharnessJsonlV2ToV3Dialect
    default: return migration
  }
}

function createDialectCatalog(children?: readonly SessionFormatJsonValue[]): SessionFormatCatalog {
  return createSessionFormatCatalog({
    ...sessionFormatCatalogOptions,
    codecs: sessionFormatCatalogOptions.codecs.map(coharnessDialectCodec),
    migrations: sessionFormatCatalogOptions.migrations.map(migration =>
      children !== undefined && migration === sessionFormatV6ToV7
        ? createSessionFormatV6ToV7(children)
        : coharnessDialectMigration(migration)),
  })
}

const dialectCatalog = createDialectCatalog()

function detachDraft(value: SessionFormatJsonObject): { header: unknown; draft: boolean | undefined } {
  const { draft, ...header } = value
  if (draft !== undefined && typeof draft !== 'boolean') throw new SessionFormatError('CoHarness JSONL draft must be boolean')
  return { header, draft }
}

function withDraft(header: SessionFormatHeader, draft: boolean | undefined): SessionFormatHeader {
  return draft === undefined ? header : { ...header, draft }
}

/**
 * Dispatch CoHarness JSONL reads between a dialect catalog (legacy v0–v3 framing) and a released-format catalog.
 * @param dialect - catalog whose v0–v3 codecs and migration edges carry the CoHarness dialect.
 * @param logical - catalog of released codecs and migration edges.
 * @returns a catalog that routes each header to the dialect or released decoder and preserves `draft` metadata.
 */
export function createCoharnessJsonlCatalog(dialect: SessionFormatCatalog, logical: SessionFormatCatalog): SessionFormatCatalog {
  function restore(value: unknown, options: SessionFormatRestoreOptions, stored: boolean): SessionFormatRestore {
    if (!legacyHeader(value)) {
      return stored ? logical.createStoredRestore(value, options) : logical.createRestore(value, options)
    }
    const source = detachDraft(value)
    const reader = stored ? dialect.createStoredRestore(source.header, options) : dialect.createRestore(source.header, options)
    return {
      header: withDraft(reader.header, source.draft),
      decodeRow: reader.decodeRow.bind(reader),
      finish() {
        const artifact = reader.finish()
        return { ...artifact, header: withDraft(artifact.header, source.draft) }
      },
    }
  }
  return Object.freeze<SessionFormatCatalog>({
    ...logical,
    readHeader(value) {
      if (!legacyHeader(value)) return logical.readHeader(value)
      try {
        const source = detachDraft(value)
        const result = dialect.readHeader(source.header)
        return result.status === 'migration-required'
          ? { ...result, header: withDraft(result.header, source.draft) } : result
      } catch (error) {
        return { status: 'malformed', targetVersion: logical.currentVersion,
          reason: String(error) }
      }
    },
    createRestore: (value, options) => restore(value, options, false),
    createStoredRestore: (value, options) => restore(value, options, true),
  })
}

/**
 * CoHarness JSONL readers admit the declared v0–v3 seedLength and packed-stream
 * dialect. Released isSeeded headers and current writes retain the generated
 * codec rules; every historical body still traverses the adjacent chain.
 */
export const coharnessJsonlFormatCatalog = createCoharnessJsonlCatalog(dialectCatalog, sessionFormatCatalog)

/**
 * Assemble a CoHarness JSONL catalog whose V6→V7 edge knows one parent's historical children.
 * @param children - complete child evidence retained unchanged for the catalog's lifetime; an empty array declares no children.
 * @returns a catalog with independent restore state per artifact and unchanged current-format readers.
 */
export function createCoharnessJsonlFormatCatalogWithChildren(children: readonly SessionFormatJsonValue[]): SessionFormatCatalog {
  return createCoharnessJsonlCatalog(
    createDialectCatalog(children),
    createSessionFormatCatalog({
      ...sessionFormatCatalogOptions,
      migrations: sessionFormatCatalogOptions.migrations.map(migration =>
        migration === sessionFormatV6ToV7 ? createSessionFormatV6ToV7(children) : migration),
    }),
  )
}
