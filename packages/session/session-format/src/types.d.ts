import type { JsonValue } from '@deepseek-ai/dsh-util-values'
/** JSON object used by a Session format codec. */
export type SessionFormatJsonObject = {
  readonly [key: string]: JsonValue
}
/** A detached logical Session header shared by all adjacent generations. */
export interface SessionFormatHeader extends SessionFormatJsonObject {
  readonly version: number
  readonly id: string
  readonly createdAt: number
}
/** One detached logical Session event. */
export interface SessionFormatEvent extends SessionFormatJsonObject {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: JsonValue
}
/** One complete detached Session artifact. */
export interface SessionFormatArtifact {
  readonly header: SessionFormatHeader
  readonly events: readonly SessionFormatEvent[]
  /** Number of leading events inherited by a fork or resume seed. */
  readonly inheritedEventCount: number
}
/** One adjacent, whole-artifact migration. */
export interface SessionFormatMigration {
  readonly name: string
  readonly fromVersion: number
  readonly toVersion: number
  migrateHeader(header: SessionFormatHeader): SessionFormatHeader
  migrate(artifact: SessionFormatArtifact): SessionFormatArtifact
  validateTargetHeader(header: SessionFormatHeader): void
  validateTarget(artifact: SessionFormatArtifact): void
}
/** Inputs for compiling a complete adjacent migration chain. */
export interface SessionFormatChainOptions {
  readonly currentVersion: number
  readonly migrations: readonly SessionFormatMigration[]
  readonly restoreCurrentHeader: (header: SessionFormatHeader) => SessionFormatHeader
  readonly restoreCurrent: (artifact: SessionFormatArtifact) => SessionFormatArtifact
}
/** Pure planner and whole-artifact runner for one format family. */
export interface SessionFormatChain {
  readonly currentVersion: number
  plan(fromVersion: number): readonly SessionFormatMigration[]
  migrateHeader(header: SessionFormatHeader): SessionFormatHeader
  migrate(artifact: SessionFormatArtifact): SessionFormatArtifact
}
/** Header-only classification returned before a body read. */
export type SessionFormatHeaderReadResult = {
  readonly status: 'current' | 'migration-required'
  readonly storedVersion: number
  readonly targetVersion: number
  readonly header: SessionFormatHeader
} | {
  readonly status: 'unsupported' | 'malformed'
  readonly storedVersion?: number
  readonly targetVersion: number
  readonly reason: string
}
/** Compile-time catalog inputs. Physical providers may add their own codecs later. */
export interface SessionFormatCatalogOptions extends SessionFormatChainOptions {
}
/** Build-static migration catalog. */
export interface SessionFormatCatalog {
  readonly currentVersion: number
  readHeader(value: unknown): SessionFormatHeaderReadResult
  migrateHeader(header: SessionFormatHeader): SessionFormatHeader
  migrate(artifact: SessionFormatArtifact): SessionFormatArtifact
}
//# sourceMappingURL=types.d.ts.map
