/** Independently versioned migrations for dedicated physical content stores. */
import { nodeContentMigrations,checkedNodeContentVersions } from './node-content-manifest.ts'
import { escapeIdentifier } from 'pg'
import { transaction } from './postgres/database.ts'
import { NodeContentUnavailable, proveNodeContentVolume, type NodeContentOptions } from './node-content-store.ts'

/** Verify physical placement before applying any DDL. Existing checked migrations must match byte for byte.
 * @param options - node database and host-visible volume proof settings.
 * @param directory - reviewed node-only migration directory from the same release.
 * @param applicationRole - optional separately provisioned Gateway role.
 * @returns the verified schema revision.
 */
export async function migrateNodeContent(options: NodeContentOptions, directory: string, applicationRole?: string): Promise<number> {
  const migrations=await nodeContentMigrations(directory)
  return transaction(options.pool, async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(1397703491)')
    const { rows: [plane] } = await tx.query<{ organization: boolean; content: boolean; occupied: boolean; template: boolean }>(`SELECT
      to_regnamespace('harness') IS NOT NULL organization,to_regnamespace('node_content') IS NOT NULL content,
      EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','f','v','m','S')) occupied,
      current_database() IN ('postgres','template0','template1') OR (SELECT datistemplate FROM pg_database WHERE datname=current_database()) template`)
    if (plane === undefined || plane.organization || plane.template || !plane.content && plane.occupied) {
      throw new NodeContentUnavailable('Provisioning requires an empty dedicated database or a recorded node content volume.')
    }
    const proof = await proveNodeContentVolume(options, tx, true)
    if (plane.content) {
      const { rows: identities } = await tx.query(`SELECT organization_id,node_id,volume_id,cluster_id,database_oid FROM node_content.volume`)
      if (identities.length !== 1 || identities[0].organization_id !== options.organizationId || identities[0].node_id !== options.nodeId
        || identities[0].volume_id !== options.volumeId || identities[0].cluster_id !== proof.clusterId || String(identities[0].database_oid) !== proof.databaseOid) {
        throw new NodeContentUnavailable('The installed content schema belongs to a different volume.')
      }
    }
    const installed=plane.content ? await checkedNodeContentVersions(tx,migrations) : 0
    for (const file of migrations.slice(installed)) {
      await tx.query(file.sql)
      if (file.version === 1) {
        await tx.query('CREATE TABLE node_content.schema_migrations(version integer PRIMARY KEY,name text NOT NULL,checksum text NOT NULL)')
        await tx.query(`INSERT INTO node_content.volume(singleton,organization_id,node_id,volume_id,cluster_id,database_oid) VALUES(true,$1,$2,$3,$4,$5)`,
          [options.organizationId,options.nodeId,options.volumeId,proof.clusterId,proof.databaseOid])
      }
      await tx.query('INSERT INTO node_content.schema_migrations VALUES($1,$2,$3)', [file.version,file.name,file.checksum])
    }
    if (applicationRole !== undefined) {
      const role = escapeIdentifier(applicationRole)
      await tx.query(`GRANT USAGE ON SCHEMA node_content TO ${role}`)
      await tx.query(`GRANT EXECUTE ON FUNCTION node_content.volume_proof(uuid) TO ${role}`)
      const tables = (await tx.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='node_content' ORDER BY tablename")).rows
      for (const { tablename } of tables) {
        const privileges = tablename === 'volume' || tablename === 'schema_migrations' ? 'SELECT' : 'SELECT,INSERT,UPDATE,DELETE'
        await tx.query(`GRANT ${privileges} ON node_content.${escapeIdentifier(tablename)} TO ${role}`)
      }
    }
    return migrations.length
  })
}
