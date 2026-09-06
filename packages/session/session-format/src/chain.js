import { SessionFormatError, SessionFormatUnsupportedMigrationError } from "./error.js";
import { inspectSessionFormatVersion, snapshotSessionFormatArtifact, snapshotSessionFormatHeader } from "./json.js";
/** Validate one exact adjacent migration declaration. */
export function defineSessionFormatMigration(migration) {
    if (migration.name.length === 0)
        throw new SessionFormatError('Session migration name must be non-empty');
    if (!Number.isSafeInteger(migration.fromVersion) || migration.fromVersion < 0)
        throw new SessionFormatError('migration fromVersion must be non-negative');
    if (migration.toVersion !== migration.fromVersion + 1)
        throw new SessionFormatError(`${migration.name} must be adjacent`);
    return Object.freeze({ ...migration });
}
/** Compile a unique, complete adjacent migration chain. */
export function createSessionFormatChain(options) {
    return new CompiledSessionFormatChain(options);
}
class CompiledSessionFormatChain {
    options;
    currentVersion;
    migrations;
    constructor(options) {
        this.options = options;
        this.currentVersion = options.currentVersion;
        const byFrom = new Map();
        for (const candidate of options.migrations) {
            const migration = defineSessionFormatMigration(candidate);
            if (byFrom.has(migration.fromVersion))
                throw new SessionFormatError(`duplicate Session migration from v${migration.fromVersion}`);
            byFrom.set(migration.fromVersion, migration);
        }
        const ordered = [];
        for (let version = 0; version < this.currentVersion; version += 1) {
            const migration = byFrom.get(version);
            if (migration === undefined)
                throw new SessionFormatUnsupportedMigrationError(`missing Session migration v${version}->v${version + 1}`);
            ordered.push(migration);
        }
        this.migrations = Object.freeze(ordered);
    }
    plan(fromVersion) {
        if (!Number.isSafeInteger(fromVersion) || fromVersion < 0)
            throw new SessionFormatError('stored Session version must be non-negative');
        if (fromVersion > this.currentVersion)
            throw new SessionFormatUnsupportedMigrationError(`stored Session uses newer format v${fromVersion}`);
        return Object.freeze(this.migrations.slice(fromVersion));
    }
    migrateHeader(source) {
        let current = snapshotSessionFormatHeader(source, 'stored Session header');
        for (const migration of this.plan(current.version)) {
            current = snapshotSessionFormatHeader(migration.migrateHeader(current), `${migration.name} header output`);
            if (current.version !== migration.toVersion)
                throw new SessionFormatError(`${migration.name} returned an invalid header version`);
            migration.validateTargetHeader(current);
        }
        return snapshotSessionFormatHeader(this.options.restoreCurrentHeader(current), 'current Session header');
    }
    migrate(source) {
        let current = snapshotSessionFormatArtifact(source, 'stored Session artifact');
        for (const migration of this.plan(inspectSessionFormatVersion(current.header))) {
            current = snapshotSessionFormatArtifact(migration.migrate(current), `${migration.name} output`);
            if (current.header.version !== migration.toVersion)
                throw new SessionFormatError(`${migration.name} returned an invalid artifact version`);
            migration.validateTarget(current);
        }
        const restored = snapshotSessionFormatArtifact(this.options.restoreCurrent(current), 'current Session artifact');
        if (restored.header.version !== this.currentVersion)
            throw new SessionFormatError('current Session restorer returned an invalid version');
        return restored;
    }
}
//# sourceMappingURL=chain.js.map