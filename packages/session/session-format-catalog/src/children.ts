/** Per-fixture catalog factory for replay restores that must not share restore state. */

import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatCatalog, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalogOptions } from './generated.ts'

/**
 * Assemble an independent catalog for one restore. The `children` parameter is
 * accepted for call-site parity with upstream: CoHarness session logs never
 * embed child session artifacts inside a parent log, so no local migration
 * edge consumes it yet.
 * @param children - child session evidence retained for the catalog's lifetime; currently must be empty.
 * @returns a catalog with independent restore state per artifact and unchanged current-format readers.
 */
export function createSessionFormatCatalogWithChildren(children: readonly SessionFormatJsonValue[]): SessionFormatCatalog {
  if (children.length !== 0) {
    throw new Error('embedded child session evidence is not supported by the installed session-format chain')
  }
  return createSessionFormatCatalog(sessionFormatCatalogOptions)
}
