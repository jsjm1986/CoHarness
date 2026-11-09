/** A real dump cannot reactivate destination-owned project content authority. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { createDeploymentCommands } from '../src/deployment-commands.ts'
import { createPostgresPool, runMigrations, transaction } from '../src/postgres/database.ts'
import { acquireDeploymentDataLock } from '../src/postgres/deployment-lock.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
function command(value: string | undefined, executable: string): string[] {
  if (value === undefined) return [executable]
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(arg => typeof arg !== 'string')) throw new Error('Invalid fixture client command')
  return parsed as string[]
}

it.skipIf(databaseUrl === undefined).each(['retired-runtime', 'offline-node', 'cancelled-recovery'] as const)(
  'rejects a complete SQL restore that rolls back current content authority: %s', async scenario => {
  const database = `hgw_content_restore_${randomUUID().replaceAll('-', '')}_test`
  const admin = createPostgresPool(databaseUrl!, { max: 1 }), root = await mkdtemp(join(tmpdir(), 'hgw-content-restore-'))
  let created = false, pool: ReturnType<typeof createPostgresPool> | undefined
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true
    const target = new URL(databaseUrl!); target.pathname = `/${database}`
    pool = createPostgresPool(target.href, { max: 3 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    const slug = randomUUID(), organization = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'content guard') RETURNING id", [slug])).rows[0]!.id
    const node = (await pool.query<{ id: string }>(
      "INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'content-guard-node') RETURNING id", [organization])).rows[0]!.id
    await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [organization])
    const user = (await pool.query<{ id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
      VALUES($1,'guard-owner','Guard owner','/guard-owner') RETURNING id`, [organization])).rows[0]!.id
    // These are governance metadata fixtures; no physical content volume is published.
    const { project, runtime, volume } = await transaction(pool, async client => {
      const project = (await client.query<{ id: string }>(`INSERT INTO harness.projects(organization_id,name,created_by,owner_user_id)
        VALUES($1,$2,$3,$3) RETURNING id`, [organization, randomUUID(), user])).rows[0]!.id
      const runtime = (await client.query<{ runtime_id: string }>(`INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port)
        VALUES($1,$2,$3,47300) RETURNING runtime_id`, [organization, project, node])).rows[0]!.runtime_id
      const volume = randomUUID()
      await client.query(`INSERT INTO harness.node_content_volumes(organization_id,node_id,volume_id,cluster_id,database_oid)
        SELECT $1,$2,$3,system_identifier::text,(SELECT oid FROM pg_database WHERE datname=current_database()) FROM pg_control_system()`,
      [organization, node, volume])
      await client.query(`INSERT INTO harness.project_content_placement(organization_id,project_id,node_id,runtime_id,volume_id,writer_epoch)
        VALUES($1,$2,$3,$4,$5,1)`, [organization, project, node, runtime, volume])
      return { project, runtime, volume }
    })
    let recovery: string | undefined
    if (scenario === 'cancelled-recovery') {
      const destination = (await pool.query<{ id: string }>(
        "INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'recovery-target') RETURNING id", [organization])).rows[0]!.id
      const targetVolume = randomUUID(), policy = randomUUID(), point = randomUUID()
      recovery = randomUUID()
      await pool.query(`INSERT INTO harness.node_content_volumes(organization_id,node_id,volume_id,cluster_id,database_oid)
        SELECT $1,$2,$3,system_identifier::text,(SELECT oid FROM pg_database WHERE datname='template0') FROM pg_control_system()`,
      [organization, destination, targetVolume])
      await pool.query(`INSERT INTO harness.peer_backup_policies
        (id,organization_id,scope_kind,scope_id,source_node_id,target_node_id,tier,enabled,revision,quota_bytes,append_hash,recovery_hash)
        VALUES($1,$2,'project',$3,$4,$5,'ordinary',true,1,4096,repeat('a',64),repeat('b',64))`,
      [policy, organization, project, node, destination])
      await pool.query(`INSERT INTO harness.peer_backup_points
        (id,organization_id,policy_id,revision,writer_epoch,watermark,snapshot_id,manifest_digest,covered_count,gap_count,protected_through)
        VALUES($1,$2,$3,1,1,0,repeat('c',64),repeat('d',64),0,0,clock_timestamp())`, [point, organization, policy])
      await pool.query(`INSERT INTO harness.project_recovery_operations
        (id,organization_id,project_id,runtime_id,policy_id,point_id,policy_revision,approved_by,
         source_node_id,source_volume_id,source_epoch,target_node_id,target_volume_id,target_epoch,manifest_digest,point_revision,phase)
        VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,1,$10,$11,2,repeat('d',64),1,'prepared')`,
      [recovery, organization, project, runtime, policy, point, user, node, volume, destination, targetVolume])
      await pool.query(`UPDATE harness.project_recovery_operations SET phase='target-ready',target_verified_at=clock_timestamp(),
        target_schedule_digest=repeat('e',64),target_files_digest=repeat('f',64),target_port_base=48300 WHERE id=$1`, [recovery])
      await pool.query(`UPDATE harness.project_recovery_operations SET phase='retire-approved',
        retirement_approved_by=$2,retirement_approved_at=clock_timestamp() WHERE id=$1`, [recovery, user])
    }
    const context = await resolvePostgresRuntimeContext(pool, slug, 'content-guard-node')
    const commands = createDeploymentCommands(command(process.env.HGW_TEST_PG_DUMP_COMMAND, 'pg_dump'),
      command(process.env.HGW_TEST_PG_RESTORE_COMMAND, 'pg_restore'))
    const backup = await commands.backup(root, target.href, [])
    if (scenario === 'retired-runtime') {
      await pool.query('UPDATE harness.runtime_environments SET retired_at=clock_timestamp() WHERE id=$1', [runtime])
    } else if (scenario === 'offline-node') {
      await pool.query("UPDATE harness.compute_nodes SET status='offline' WHERE id=$1", [node])
    } else {
      await pool.query("UPDATE harness.project_recovery_operations SET phase='cancelled' WHERE id=$1", [recovery])
    }
    const maintenance = new PostgresMaintenanceService(context, 60000)
    await maintenance.enterMaintenance(null)
    await maintenance.beginRestore(null)
    await using lease = await acquireDeploymentDataLock(pool)
    const failure: unknown = await commands.restoreDump(backup.dumpPath, target.href, lease, backup.sha256)
      .then(() => undefined, (error: unknown) => error)
    const after = (await pool.query('SELECT retired_at FROM harness.runtime_environments WHERE id=$1', [runtime])).rows[0]
    expect({ retired: after.retired_at !== null, refused: failure instanceof Error })
      .toEqual({ retired: scenario === 'retired-runtime', refused: true })
    expect((await pool.query('SELECT status FROM harness.compute_nodes WHERE id=$1', [node])).rows[0].status)
      .toBe(scenario === 'offline-node' ? 'offline' : 'active')
    if (recovery !== undefined) {
      expect((await pool.query('SELECT phase,retirement_approved_by FROM harness.project_recovery_operations WHERE id=$1', [recovery])).rows)
        .toEqual([{ phase: 'cancelled', retirement_approved_by: user }])
    }
    expect(failure).toHaveProperty('message', expect.stringMatching(/project writer epoch|authority differs|isolated recovery/iu))
    expect((await maintenance.state()).mode).toBe('restoring')
    expect((await pool.query('SELECT writer_epoch::text FROM harness.project_content_placement')).rows).toEqual([{ writer_epoch: '1' }])
  } finally {
    await pool?.end()
    try { if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  }
})

it.skipIf(databaseUrl === undefined)('retains current peer credential rotations and disabled work through a complete SQL restore', async () => {
  const database = `hgw_peer_restore_${randomUUID().replaceAll('-', '')}_test`
  const admin = createPostgresPool(databaseUrl!, { max: 1 }), root = await mkdtemp(join(tmpdir(), 'hgw-peer-restore-'))
  let created = false, pool: ReturnType<typeof createPostgresPool> | undefined
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const policy = randomUUID(), work = randomUUID(), oldClaim = randomUUID()
  const appendHash = digest('rotated append token'), recoveryHash = digest('rotated recovery token')
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true
    const target = new URL(databaseUrl!); target.pathname = `/${database}`
    pool = createPostgresPool(target.href, { max: 3 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    const slug = randomUUID(), organization = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'peer restore guard') RETURNING id", [slug])).rows[0]!.id
    const source = (await pool.query<{ id: string }>(
      "INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'source') RETURNING id", [organization])).rows[0]!.id
    const destination = (await pool.query<{ id: string }>(
      "INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'destination') RETURNING id", [organization])).rows[0]!.id
    await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [organization])
    await pool.query(`INSERT INTO harness.peer_backup_policies
      (id,organization_id,scope_kind,scope_id,source_node_id,target_node_id,tier,enabled,revision,quota_bytes,append_hash,recovery_hash)
      VALUES($1,$2,'governance',$2,$3,$4,'ordinary',true,1,4096,$5,$6)`,
    [policy, organization, source, destination, digest('original append token'), digest('original recovery token')])
    await pool.query(`INSERT INTO harness.peer_backup_work(id,policy_id,organization_id,revision,kind,node_id,status,claim,lease_expires_at)
      VALUES($1,$2,$3,1,'capture',$4,'running',$5,clock_timestamp()+interval '1 hour')`,
    [work, policy, organization, source, oldClaim])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'source')
    const commands = createDeploymentCommands(command(process.env.HGW_TEST_PG_DUMP_COMMAND, 'pg_dump'),
      command(process.env.HGW_TEST_PG_RESTORE_COMMAND, 'pg_restore'))
    const backup = await commands.backup(root, target.href, [])
    await pool.query(`UPDATE harness.peer_backup_policies SET enabled=false,revision=9,append_hash=$2,recovery_hash=$3 WHERE id=$1`,
      [policy, appendHash, recoveryHash])
    await pool.query(`UPDATE harness.peer_backup_work SET status='failed',phase='failed',claim=NULL,lease_expires_at=NULL,
      error_code='peer-backup/revoked',finished_at=clock_timestamp() WHERE id=$1`, [work])
    const maintenance = new PostgresMaintenanceService(context, 60000)
    await maintenance.enterMaintenance(null)
    await maintenance.beginRestore(null)
    await using lease = await acquireDeploymentDataLock(pool)
    await commands.restoreDump(backup.dumpPath, target.href, lease, backup.sha256)
    const restoredPolicy = (await pool.query('SELECT enabled,revision,append_hash,recovery_hash FROM harness.peer_backup_policies WHERE id=$1', [policy])).rows[0]
    expect({ disabled: !restoredPolicy.enabled, revisionAdvanced: restoredPolicy.revision > 9,
      appendRotationRetained: restoredPolicy.append_hash === appendHash, recoveryRotationRetained: restoredPolicy.recovery_hash === recoveryHash })
      .toEqual({ disabled: true, revisionAdvanced: true, appendRotationRetained: true, recoveryRotationRetained: true })
    expect((await pool.query('SELECT status,claim,lease_expires_at,error_code FROM harness.peer_backup_work WHERE id=$1', [work])).rows)
      .toEqual([{ status: 'failed', claim: null, lease_expires_at: null, error_code: 'peer-backup/revoked' }])
    expect((await maintenance.state()).mode).toBe('restoring')
  } finally {
    await pool?.end()
    try { if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  }
})
