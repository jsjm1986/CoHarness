import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { NODE_CONTENT_RESTORE_PREFIX, NODE_CONTENT_RESTORE_SUFFIX } from '../src/node-content-restore-guard.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const database = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)

it.skipIf(!database)('refuses to revive a retired placed Runtime or change its unique writer during control restore', async () => {
  const pool = createPostgresPool(database!, { max: 1 })
  try {
    await runMigrations(pool,fileURLToPath(new URL('../deploy/postgres/migrations',import.meta.url)))
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      const organization = (await tx.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Restore guard') RETURNING id",
        ['restore-' + randomUUID()])).rows[0]!.id
      const node = (await tx.query<{ id: string }>("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'owner') RETURNING id",[organization])).rows[0]!.id
      const user = (await tx.query<{ id: string }>("INSERT INTO harness.users(organization_id,username,display_name,home_path) VALUES($1,'owner','Owner','/owner') RETURNING id",[organization])).rows[0]!.id
      const project = (await tx.query<{ id: string }>("INSERT INTO harness.projects(organization_id,name,created_by,owner_user_id) VALUES($1,'Project',$2,$2) RETURNING id",[organization,user])).rows[0]!.id
      await tx.query("INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path) VALUES($1,$2,$3,'/project','/project')",[organization,project,node])
      const runtime = (await tx.query<{ runtime_id: string }>('INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port) VALUES($1,$2,$3,47400) RETURNING runtime_id',
        [organization,project,node])).rows[0]!.runtime_id
      const volume = randomUUID()
      await tx.query("INSERT INTO harness.node_content_volumes VALUES($1,$2,$3,'123456789',555)",[organization,node,volume])
      await tx.query('INSERT INTO harness.project_content_placement(organization_id,project_id,node_id,runtime_id,volume_id,writer_epoch) VALUES($1,$2,$3,$4,$5,4)',[organization,project,node,runtime,volume])
      await tx.query('UPDATE harness.runtime_environments SET retired_at=clock_timestamp() WHERE id=$1',[runtime])
      await tx.query(NODE_CONTENT_RESTORE_PREFIX)
      await tx.query('SAVEPOINT same_assignment')
      await tx.query('UPDATE harness.runtime_environments SET retired_at=NULL WHERE id=$1',[runtime])
      await expect(tx.query(NODE_CONTENT_RESTORE_SUFFIX)).rejects.toThrow(/project writer epoch/u)
      await tx.query('ROLLBACK TO same_assignment')
      // pg_restore loads table data before recreating application triggers.
      await tx.query('ALTER TABLE harness.project_content_placement DISABLE TRIGGER USER')
      await tx.query('DELETE FROM harness.project_content_placement WHERE runtime_id=$1',[runtime])
      await tx.query('ALTER TABLE harness.project_content_placement ENABLE TRIGGER USER')
      await expect(tx.query(NODE_CONTENT_RESTORE_SUFFIX)).rejects.toThrow()
      await tx.query('ROLLBACK TO same_assignment')
      await tx.query(NODE_CONTENT_RESTORE_SUFFIX)
      expect((await tx.query('SELECT retired_at IS NOT NULL retired FROM harness.runtime_environments WHERE id=$1',[runtime])).rows[0]?.retired).toBe(true)
    } finally { await tx.query('ROLLBACK'); tx.release() }
  } finally { await pool.end() }
})
