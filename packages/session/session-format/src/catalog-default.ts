import { defineSessionFormatMigration } from './chain.ts'
import { createSessionFormatCatalog } from './catalog.ts'
import type { SessionFormatArtifact, SessionFormatHeader } from './types.ts'

const bump = (fromVersion: number) => defineSessionFormatMigration({
  name: `@deepseek-ai/dsh-session-format-v${fromVersion}-to-v${fromVersion + 1}`,
  fromVersion,
  toVersion: fromVersion + 1,
  migrateHeader: (header: SessionFormatHeader) => ({ ...header, version: fromVersion + 1 }),
  migrate: (artifact: SessionFormatArtifact) => ({ ...artifact, header: { ...artifact.header, version: fromVersion + 1 } }),
  validateTargetHeader: () => {},
  validateTarget: () => {},
})

/** The complete static v0→v1→v2 chain used by provider adapters. */
export const sessionFormatCatalog = createSessionFormatCatalog({
  currentVersion: 2,
  migrations: [bump(0), bump(1)],
  restoreCurrentHeader: header => header,
  restoreCurrent: artifact => artifact,
})
