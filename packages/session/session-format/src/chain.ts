import { SessionFormatError, SessionFormatUnsupportedMigrationError } from './error.ts'
import { inspectSessionFormatVersion, snapshotSessionFormatArtifact, snapshotSessionFormatHeader } from './json.ts'
import type { SessionFormatArtifact, SessionFormatChain, SessionFormatChainOptions, SessionFormatHeader, SessionFormatMigration } from './types.ts'

/**
 * Validate one exact adjacent migration declaration.
 * @param migration - migration declaration to validate.
 * @returns a frozen adjacent declaration.
 */
export function defineSessionFormatMigration(migration: SessionFormatMigration): SessionFormatMigration {
  if (migration.name.length === 0) throw new SessionFormatError('Session migration name must be non-empty')
  if (!Number.isSafeInteger(migration.fromVersion) || migration.fromVersion < 0) throw new SessionFormatError('migration fromVersion must be non-negative')
  if (migration.toVersion !== migration.fromVersion + 1) throw new SessionFormatError(`${migration.name} must be adjacent`)
  return Object.freeze({ ...migration })
}

/**
 * Compile a unique, complete adjacent migration chain.
 * @param options - current version, migrations, and current restorers.
 * @returns an immutable migration planner.
 */
export function createSessionFormatChain(options: SessionFormatChainOptions): SessionFormatChain {
  return new CompiledSessionFormatChain(options)
}

class CompiledSessionFormatChain implements SessionFormatChain {
  readonly currentVersion: number
  private readonly migrations: readonly SessionFormatMigration[]
  constructor(private readonly options: SessionFormatChainOptions) {
    this.currentVersion = options.currentVersion
    const byFrom = new Map<number, SessionFormatMigration>()
    for (const candidate of options.migrations) {
      const migration = defineSessionFormatMigration(candidate)
      if (byFrom.has(migration.fromVersion)) throw new SessionFormatError(`duplicate Session migration from v${migration.fromVersion}`)
      byFrom.set(migration.fromVersion, migration)
    }
    const ordered: SessionFormatMigration[] = []
    for (let version = 0; version < this.currentVersion; version += 1) {
      const migration = byFrom.get(version)
      if (migration === undefined) throw new SessionFormatUnsupportedMigrationError(`missing Session migration v${version}->v${version + 1}`)
      ordered.push(migration)
    }
    this.migrations = Object.freeze(ordered)
  }

  plan(fromVersion: number): readonly SessionFormatMigration[] {
    if (!Number.isSafeInteger(fromVersion) || fromVersion < 0) throw new SessionFormatError('stored Session version must be non-negative')
    if (fromVersion > this.currentVersion) throw new SessionFormatUnsupportedMigrationError(`stored Session uses newer format v${fromVersion}`)
    return Object.freeze(this.migrations.slice(fromVersion))
  }

  migrateHeader(source: SessionFormatHeader): SessionFormatHeader {
    let current = snapshotSessionFormatHeader(source, 'stored Session header')
    for (const migration of this.plan(current.version)) {
      current = snapshotSessionFormatHeader(migration.migrateHeader(current), `${migration.name} header output`)
      if (current.version !== migration.toVersion) throw new SessionFormatError(`${migration.name} returned an invalid header version`)
      migration.validateTargetHeader(current)
    }
    return snapshotSessionFormatHeader(this.options.restoreCurrentHeader(current), 'current Session header')
  }

  migrate(source: SessionFormatArtifact): SessionFormatArtifact {
    let current = snapshotSessionFormatArtifact(source, 'stored Session artifact')
    for (const migration of this.plan(inspectSessionFormatVersion(current.header))) {
      current = snapshotSessionFormatArtifact(migration.migrate(current), `${migration.name} output`)
      if (current.header.version !== migration.toVersion) throw new SessionFormatError(`${migration.name} returned an invalid artifact version`)
      migration.validateTarget(current)
    }
    const restored = snapshotSessionFormatArtifact(this.options.restoreCurrent(current), 'current Session artifact')
    if (restored.header.version !== this.currentVersion) throw new SessionFormatError('current Session restorer returned an invalid version')
    return restored
  }
}
