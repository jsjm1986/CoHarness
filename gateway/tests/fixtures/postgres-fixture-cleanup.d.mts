/** Types for the shared source and plain-Node organization cleanup fixture. */
import type { Pool } from 'pg'

/**
 * Delete one drained fixture organization and its dependent rows.
 * @param pool - disposable test database.
 * @param organizationId - fixture-owned organization.
 * @returns after cleanup; unresolved dependencies reject.
 */
export function removeFixtureOrganization(pool: Pool, organizationId: string): Promise<void>
