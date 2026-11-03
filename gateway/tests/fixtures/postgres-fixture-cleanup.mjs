/** Organization-scoped cleanup shared by source tests and plain-Node replay fixtures. */
function foreignKeyViolation(error) {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === '23503'
}

/**
 * Delete one drained fixture organization without touching any other organization.
 * @param pool - disposable test database after the fixture's writers have drained.
 * @param organizationId - organization created exclusively by the fixture.
 * @returns after dependent rows and their organization are removed; unresolved dependencies reject.
 */
export async function removeFixtureOrganization(pool, organizationId) {
  const result = await pool.query(`SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t USING(table_catalog,table_schema,table_name)
    WHERE c.table_schema='harness' AND c.column_name='organization_id' AND t.table_type='BASE TABLE'`)
  const tables = result.rows.map(row => row.table_name)
  for (const table of tables) if (!/^[a-z][a-z0-9_]+$/u.test(table)) throw new Error('Unexpected fixture cleanup table')
  for (let pass = 0; pass <= tables.length; pass += 1) {
    for (const table of tables) {
      try { await pool.query(`DELETE FROM harness.${table} WHERE organization_id=$1`, [organizationId]) }
      catch (error) { if (!foreignKeyViolation(error)) throw error }
    }
    try { await pool.query('DELETE FROM harness.organizations WHERE id=$1', [organizationId]); return }
    catch (error) { if (!foreignKeyViolation(error) || pass === tables.length) throw error }
  }
}
