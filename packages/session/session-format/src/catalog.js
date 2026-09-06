import { createSessionFormatChain } from "./chain.js";
import { SessionFormatError } from "./error.js";
import { inspectSessionFormatVersion, snapshotSessionFormatHeader } from "./json.js";
/** Compile a build-static header classifier and adjacent migration chain. */
export function createSessionFormatCatalog(options) {
    const chain = createSessionFormatChain(options);
    return Object.freeze({
        currentVersion: chain.currentVersion,
        readHeader(value) {
            let storedVersion;
            try {
                storedVersion = inspectSessionFormatVersion(value);
                if (storedVersion > chain.currentVersion)
                    return { status: 'unsupported', storedVersion, targetVersion: chain.currentVersion, reason: `stored Session uses newer format v${storedVersion}` };
                const header = chain.migrateHeader(snapshotSessionFormatHeader(value));
                return { status: storedVersion === chain.currentVersion ? 'current' : 'migration-required', storedVersion, targetVersion: chain.currentVersion, header };
            }
            catch (error) {
                if (error instanceof SessionFormatError)
                    return { status: 'malformed', ...(Number.isSafeInteger(value?.version) ? { storedVersion: value.version } : {}), targetVersion: chain.currentVersion, reason: error.message };
                return { status: 'malformed', targetVersion: chain.currentVersion, reason: String(error) };
            }
        },
        migrateHeader: chain.migrateHeader.bind(chain),
        migrate: chain.migrate.bind(chain),
    });
}
//# sourceMappingURL=catalog.js.map