/** Organization-scoped cleanup for PostgreSQL fixtures sharing one disposable database. */
import type { Pool } from 'pg'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { removeFixtureOrganization as remove } from './fixtures/postgres-fixture-cleanup.mjs'

/**
 * Delete one fixture's rows while preserving every other organization.
 * @param pool - disposable test database after the fixture's writers have drained.
 * @param organizationId - organization created exclusively by the fixture.
 * @returns after its dependent rows and organization are removed; unresolved dependencies reject.
 */
export async function removeFixtureOrganization(pool: Pool, organizationId: PostgresRuntimeContext['organizationId']): Promise<void> {
  await remove(pool, organizationId)
}
