/** Three real database-registered computers and a complete project point with an independent drill. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { publishRecoveryProtocol } from '../src/peer-backup-recovery-access.ts'

/** Supply synthetic worker evidence for control-plane-only tests; the Restic assembly verifies actual files independently.
 * @param pool - disposable governance database. @param id - operation awaiting target preparation.
 * @param schedule - synthetic schedule digest. @param files - synthetic file digest. @param port - fixture target port range.
 */
export async function acceptSyntheticRecoveryCandidate(pool:Pool,id:string,schedule='e'.repeat(64),files='f'.repeat(64),port=14100):Promise<void>{
  await pool.query(`UPDATE harness.project_recovery_operations SET phase='prepared',target_verified_at=clock_timestamp(),
    target_schedule_digest=$2,target_files_digest=$3,target_port_base=$4 WHERE id=$1 AND phase='preparing'`,[id,schedule,files,port])
}
import { transaction } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
const digest = (char: string) => char.repeat(64)

/** Create disposable database state without starting a Runtime or network listener.
 * @param pool - private test governance database after migrations.
 * @param roots - caller-owned temporary directory cleanup registry.
 * @param primarySource - make the source the serving entry to test self-isolation refusal.
 * @param options - optional caller-owned identities for deterministic directory ordering.
 * @returns synthetic node, administrator and complete recovery-point identities.
 */
export async function disasterRecoveryFixture(pool: Pool, roots: string[], primarySource=false,
  options: { nodeIds?: Record<'source' | 'target' | 'primary', string> } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'hgw-peer-retreat-'))
    roots.push(root)
    const slug = `retreat-${randomUUID()}`
    const org = (await pool.query<{ id: string }>(`INSERT INTO harness.organizations(slug,display_name)
      VALUES($1,'Retreat') RETURNING id`, [slug])).rows[0]!.id
    for (const name of ['source', 'target', 'primary'] as const)
      await pool.query('INSERT INTO harness.compute_nodes(id,organization_id,name) VALUES($1,$2,$3)',
        [options.nodeIds?.[name] ?? randomUUID(), org, name])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'source')
    const primary = primarySource ? context : await resolvePostgresRuntimeContext(pool, slug, 'primary')
    const target = (
      await pool.query<{ id: string }>('SELECT id FROM harness.compute_nodes WHERE organization_id=$1 AND name=$2', [
        org, 'target',
      ])
    ).rows[0]!.id
    const admin = (
      await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
        VALUES($1,'admin','admin',$2) RETURNING id,public_id::text`, [org, join(root, 'admin')])
    ).rows[0]!
    await pool.query(`INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')`, [
      org, admin.id,
    ])
    await pool.query(
      'INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,$2,false)',
      [admin.id, 'fixture-password-hash'],
    )
    for (const node of [context.nodeId, target])
      await pool.query(
        `INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled)
        VALUES($1,$2,$3,true)`,
        [org, node, admin.id],
      )
    await pool.query(
      `UPDATE harness.deployment_topology SET enabled=true,primary_node_id=$2,primary_origin='https://primary.test'
      WHERE organization_id=$1`,
      [org, primary.nodeId],
    )
    await pool.query(`INSERT INTO harness.cluster_control(organization_id) VALUES($1) ON CONFLICT DO NOTHING`, [org])
    await pool.query(
      `INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,platform,architecture,
        connection_id,connection_epoch,lease_expires_at)
      VALUES($1,$2,$3,'linux','x64',$4,1,now()+interval '5 minutes')`,
      [org, target, randomBytes(32), randomUUID()],
    )
    await publishRecoveryProtocol(pool,org,target,300000,{project:true,personal:true})
    await publishRecoveryProtocol(pool,org,primary.nodeId,300000,{project:true,personal:true})
    const sourceVolume = randomUUID(), targetVolume = randomUUID()
    const oid = Math.floor(Math.random() * 1_000_000_000) + 100_000
    await pool.query(
      `INSERT INTO harness.node_content_volumes(organization_id,node_id,volume_id,cluster_id,database_oid)
      VALUES($1,$2,$3,$4::text,$5::oid),($1,$6,$7,$8::text,$9::oid)`,
      [org, context.nodeId, sourceVolume, String(oid), oid, target, targetVolume, String(oid + 1), oid + 1],
    )
    // A 'new' placement must commit alongside the project row that owns its
    // creation transaction marker, and the project's runtime environment is
    // registered by the instance insert itself.
    const runtimeId = randomUUID()
    const project = await transaction(pool, async (tx) => {
      const created = (
        await tx.query<{ id: string }>(`INSERT INTO harness.projects(organization_id,name,created_by,owner_user_id)
          VALUES($1,'Protected project',$2,$2) RETURNING id`, [org, admin.id])
      ).rows[0]!.id
      await tx.query(
        `INSERT INTO harness.instances(id,organization_id,project_id,assigned_node_id,port)
        VALUES($1,$2,$3,$4,4100)`,
        [runtimeId, org, created, context.nodeId],
      )
      await tx.query(
        `INSERT INTO harness.project_content_placement(organization_id,project_id,node_id,runtime_id,volume_id,writer_epoch)
        VALUES($1,$2,$3,$4,$5,1)`,
        [org, created, context.nodeId, runtimeId, sourceVolume],
      )
      return created
    })
    const policy = (
      await pool.query<{ id: string }>(`INSERT INTO harness.peer_backup_policies(
        id,organization_id,scope_kind,scope_id,source_node_id,target_node_id,tier,enabled,revision,quota_bytes,
        append_hash,recovery_hash)
      VALUES($7,$1,'project',$2,$3,$4,'important',true,1,1048576,$5,$6) RETURNING id`,
      [org, project, context.nodeId, target, digest('a'), digest('b'), randomUUID()],
    )).rows[0]!.id
    const point = (
      await pool.query<{ id: string }>(`INSERT INTO harness.peer_backup_points(
        id,organization_id,policy_id,revision,writer_epoch,watermark,snapshot_id,manifest_digest,
        covered_count,gap_count,protected_through)
      VALUES($1,$2,$3,1,1,7,$4,$5,3,0,now()) RETURNING id`,
      [randomUUID(), org, policy, digest('c'), digest('d')],
    )).rows[0]!.id
    await pool.query(
      `INSERT INTO harness.peer_backup_work(id,organization_id,policy_id,revision,kind,node_id,point_id,status)
      VALUES($5,$1,$2,1,'drill',$3,$4,'confirmed')`,
      [org, policy, target, point, randomUUID()],
    )
    const insert = (phase: string, verified = false) =>
      pool.query<{ id: string }>(
        `INSERT INTO harness.project_recovery_operations(
        id,organization_id,project_id,runtime_id,policy_id,point_id,policy_revision,approved_by,
        source_node_id,source_volume_id,source_epoch,target_node_id,target_volume_id,target_epoch,
        manifest_digest,point_revision,phase${verified ? ',target_schedule_digest,target_files_digest' : ''})
      VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,1,$10,$11,2,$12,7,$13${verified ? `,'${digest('e')}','${digest('f')}'` : ''})
      RETURNING id`,
        [
          randomUUID(), org, project, runtimeId, policy, point, admin.id,
          context.nodeId, sourceVolume, target, targetVolume, digest('d'), phase,
        ],
      ).then((result) => result.rows[0]!.id)
    const phase = async (id: string) =>
      (await pool.query<{ phase: string }>('SELECT phase FROM harness.project_recovery_operations WHERE id=$1', [id]))
        .rows[0]!.phase
    return {
      context, primary, org, runtimeId, policy, point, target, targetVolume,
      adminId: Number(admin.public_id), insert, phase,
    }
  }
