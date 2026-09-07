import { createSessionFormatChain } from './chain.ts'
import { SessionFormatError } from './error.ts'
import { inspectSessionFormatVersion, snapshotSessionFormatHeader } from './json.ts'
import type { SessionFormatCatalog, SessionFormatCatalogOptions, SessionFormatHeader, SessionFormatHeaderReadResult } from './types.ts'

/** Compile a build-static header classifier and adjacent migration chain.
 * @param options - chain and restoration rules.
 * @returns the immutable format catalog.
 */
export function createSessionFormatCatalog(options: SessionFormatCatalogOptions): SessionFormatCatalog {
  const chain = createSessionFormatChain(options)
  return Object.freeze({
    currentVersion: chain.currentVersion,
    readHeader(value: unknown): SessionFormatHeaderReadResult {
      let storedVersion: number | undefined
      try {
        storedVersion = inspectSessionFormatVersion(value)
        if (storedVersion > chain.currentVersion) return { status: 'unsupported', storedVersion, targetVersion: chain.currentVersion, reason: `stored Session uses newer format v${storedVersion}` }
        const header = chain.migrateHeader(snapshotSessionFormatHeader(value as SessionFormatHeader))
        return { status: storedVersion === chain.currentVersion ? 'current' : 'migration-required', storedVersion, targetVersion: chain.currentVersion, header }
      } catch (error: unknown) {
        if (error instanceof SessionFormatError) return { status: 'malformed', ...(storedVersion === undefined ? {} : { storedVersion }), targetVersion: chain.currentVersion, reason: error.message }
        return { status: 'malformed', targetVersion: chain.currentVersion, reason: String(error) }
      }
    },
    migrateHeader: chain.migrateHeader.bind(chain),
    migrate: chain.migrate.bind(chain),
  })
}
