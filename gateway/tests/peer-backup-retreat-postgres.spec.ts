/** The 'retreat' phase resolves a cancelled 'retiring' takeover against the source volume's fence evidence. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations, transaction } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PeerProjectRecovery } from '../src/peer-backup-takeover.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe
const digest = (char: string) => char.repeat(64)

describePg('recovery retreat resolution', () => {
  let pool: Pool
  const roots: string[] = []

  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!)
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })
  afterAll(async () => {
    await pool?.end()
  })

  /** One protected project with a confirmed drill, ready for approved takeovers on its source computer. */
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'hgw-peer-retreat-'))
    roots.push(root)
    const slug = `retreat-${randomUUID()}`
    const org = (await pool.query<{ id: string }>(`INSERT INTO harness.organizations(slug,display_name)
      VALUES($1,'Retreat') RETURNING id`, [slug])).rows[0]!.id
    for (const name of ['source', 'target'])
      await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [org, name])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'source')
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
      [org, context.nodeId],
    )
    await pool.query(`INSERT INTO harness.cluster_control(organization_id) VALUES($1) ON CONFLICT DO NOTHING`, [org])
    await pool.query(
      `INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,platform,architecture,
        connection_id,connection_epoch,lease_expires_at)
      VALUES($1,$2,$3,'linux','x64',$4,1,now()+interval '5 minutes')`,
      [org, target, randomBytes(32), randomUUID()],
    )
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
      context, org, runtimeId, policy, point, target, targetVolume,
      adminId: Number(admin.public_id), insert, phase,
    }
  }

  /** A volume whose fence query returns the given row; the retreat resolver issues exactly one volume read. */
  function volume(fence?: { schedule_digest: string; files_digest: string; generation: number; stop_operation_id: string }) {
    const tx = { query: async () => ({ rows: fence === undefined ? [] : [fence] }) } as unknown as PoolClient
    return {
      readVolume: async <T>(work: (db: PoolClient) => Promise<T>) => work(tx),
      writeVolume: async <T>(work: (db: PoolClient) => Promise<T>) => work(tx),
    }
  }

  it('maps a second takeover request for the same project to a typed 409 instead of a raw 23505', async () => {
    const f = await fixture()
    const recovery = new PeerProjectRecovery(f.context, volume())
    const intent = {
      requestId: randomUUID(), policyId: f.policy, pointId: f.point,
      targetNode: f.target, targetVolume: f.targetVolume,
    }
    await expect(recovery.request(f.adminId, intent)).resolves.toBe(intent.requestId)
    await expect(
      recovery.request(f.adminId, { ...intent, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'peer-backup/recovery-operation-active' })
  })

  it('retreats a retiring operation, resolves cancelled without a fence, and releases the runtime freeze', async () => {
    const f = await fixture()
    const recovery = new PeerProjectRecovery(f.context, volume())
    const id = await f.insert('retiring')
    await recovery.cancel(f.adminId, id)
    expect(await f.phase(id)).toBe('retreat')
    await expect(
      pool.query('UPDATE harness.instances SET generation=generation+1 WHERE runtime_id=$1', [f.runtimeId]),
    ).rejects.toThrow('Project recovery holds the stopped Runtime generation')
    await recovery.resolveRetreat(id, AbortSignal.timeout(5000))
    expect(await f.phase(id)).toBe('cancelled')
    await expect(
      pool.query('UPDATE harness.instances SET generation=generation+1 WHERE runtime_id=$1', [f.runtimeId]),
    ).resolves.toMatchObject({ rowCount: 1 })
  })

  it('rejects conflicting fence evidence, keeps the freeze, then completes old-fenced from the landed fence', async () => {
    const f = await fixture()
    const id = await f.insert('retreat', true)
    const wrong = new PeerProjectRecovery(
      f.context,
      volume({ schedule_digest: digest('0'), files_digest: digest('1'), generation: 9, stop_operation_id: randomUUID() }),
    )
    await expect(wrong.resolveRetreat(id, AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: 'peer-backup/fence-evidence-conflict',
    })
    expect(await f.phase(id)).toBe('retreat')
    await expect(
      pool.query('UPDATE harness.instances SET generation=generation+1 WHERE runtime_id=$1', [f.runtimeId]),
    ).rejects.toThrow('Project recovery holds the stopped Runtime generation')
    const right = new PeerProjectRecovery(
      f.context,
      volume({ schedule_digest: digest('e'), files_digest: digest('f'), generation: 9, stop_operation_id: randomUUID() }),
    )
    await right.resolveRetreat(id, AbortSignal.timeout(5000))
    const done = (
      await pool.query<{ phase: string; stopped_generation: string }>(
        `SELECT phase,stopped_generation::text FROM harness.project_recovery_operations WHERE id=$1`, [id],
      )
    ).rows[0]!
    expect(done.phase).toBe('old-fenced')
    expect(done.stopped_generation).toBe('9')
    await expect(
      pool.query('UPDATE harness.instances SET generation=generation+1 WHERE runtime_id=$1', [f.runtimeId]),
    ).rejects.toThrow('Project recovery holds the stopped Runtime generation')
  })
})
