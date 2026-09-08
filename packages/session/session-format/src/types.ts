import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** JSON object used by a Session format codec. */
export type SessionFormatJsonObject = { readonly [key: string]: JsonValue }

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

/** One adjacent migration; the legacy whole-artifact method remains for compatibility. */
export interface SessionFormatMigrationContext {
  /** Deliver one migrated event before the source reader advances. */
  readonly emitEvent: (event: SessionFormatEvent) => void
}

/** Stateful adjacent migration stage used by bounded persistence readers. */
export interface SessionFormatMigrationStage {
  /** Transform one event and synchronously emit zero or more target events. */
  readonly transformEvent: (event: SessionFormatEvent, context: SessionFormatMigrationContext) => void
  /** Finish the stage and emit any trailing events. */
  readonly finish: (context: SessionFormatMigrationContext) => void
}

/** One adjacent migration with optional incremental event transformation. */
export interface SessionFormatMigration {
  readonly name: string
  readonly fromVersion: number
  readonly toVersion: number
  migrateHeader(header: SessionFormatHeader): SessionFormatHeader
  migrate(artifact: SessionFormatArtifact): SessionFormatArtifact
  /** Optional streaming stage; migrations without one remain whole-artifact only. */
  readonly createStage?: (input: {
    sourceHeader: SessionFormatHeader
    targetHeader: SessionFormatHeader
    sourceInheritedEventCount: number
  }) => SessionFormatMigrationStage
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
export interface SessionFormatMigrationStream extends SessionFormatMigrationContext {
  readonly header: SessionFormatHeader
  /** Finish all stages and flush trailing output. */
  readonly finish: () => void
}

/** Pure planner and runner for a complete adjacent migration chain. */
export interface SessionFormatChain {
  readonly currentVersion: number
  plan(fromVersion: number): readonly SessionFormatMigration[]
  migrateHeader(header: SessionFormatHeader): SessionFormatHeader
  migrate(artifact: SessionFormatArtifact): SessionFormatArtifact
  /** Create a synchronous event-by-event migration stream for a source generation. */
  createStream(
    source: SessionFormatHeader,
    inheritedEventCount: number,
    output: SessionFormatMigrationContext,
  ): SessionFormatMigrationStream
}

/** Header-only classification returned before a body read. */
export type SessionFormatHeaderReadResult =
  | {
    readonly status: 'current' | 'migration-required'
    readonly storedVersion: number
    readonly targetVersion: number
    readonly header: SessionFormatHeader
  }
  | {
    readonly status: 'unsupported' | 'malformed'
    readonly storedVersion?: number
    readonly targetVersion: number
    readonly reason: string
  }

/** Compile-time catalog inputs. Physical providers may add their own codecs later. */
export interface SessionFormatCatalogOptions extends SessionFormatChainOptions {}

/** Build-static migration catalog. */
export interface SessionFormatCatalog {
  readonly currentVersion: number
  readHeader(value: unknown): SessionFormatHeaderReadResult
  migrateHeader(header: SessionFormatHeader): SessionFormatHeader
  migrate(artifact: SessionFormatArtifact): SessionFormatArtifact
  /** Create an event-by-event migration stream for a legacy generation. */
  createStream(
    source: SessionFormatHeader,
    inheritedEventCount: number,
    output: SessionFormatMigrationContext,
  ): SessionFormatMigrationStream
}
