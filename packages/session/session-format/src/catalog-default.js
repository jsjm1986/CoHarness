import { defineSessionFormatMigration } from "./chain.js";
import { createSessionFormatCatalog } from "./catalog.js";
const bump = (fromVersion) => defineSessionFormatMigration({
    name: `@deepseek-ai/dsh-session-format-v${fromVersion}-to-v${fromVersion + 1}`,
    fromVersion,
    toVersion: fromVersion + 1,
    migrateHeader: (header) => ({ ...header, version: fromVersion + 1 }),
    migrate: (artifact) => ({ ...artifact, header: { ...artifact.header, version: fromVersion + 1 } }),
    validateTargetHeader: () => { },
    validateTarget: () => { },
});
/** The complete static v0→v1→v2 chain used by provider adapters. */
export const sessionFormatCatalog = createSessionFormatCatalog({
    currentVersion: 2,
    migrations: [bump(0), bump(1)],
    restoreCurrentHeader: header => header,
    restoreCurrent: artifact => artifact,
});
//# sourceMappingURL=catalog-default.js.map