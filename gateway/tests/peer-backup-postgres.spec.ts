/** Real governance, receiver admission, persistent claims and database restore fences over an isolated PostgreSQL database. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations, transaction } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { PostgresDeploymentTopology } from '../src/deployment-topology.ts'
import { PostgresNodeAccessService } from '../src/postgres/node-access-service.ts'
import type { NodeCredential } from '../src/node-access.ts'
import { actualPeerFlow } from './peer-backup-gateway-flow.ts'
import { PeerBackupGovernance } from '../src/peer-backup-governance.ts'
import { PeerControlExporter } from '../src/peer-backup-control-export.ts'
import { PEER_BACKUP_RESTORE_PREFIX, PEER_BACKUP_RESTORE_SUFFIX } from '../src/peer-backup-restore-guard.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { testConfig } from './test-config.ts'

const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const digest = (v: string) => createHash('sha256').update(v).digest('hex')
describe.skipIf(!url || !/^\/hgw_peer_[0-9a-f]+_test$/u.test(new URL(url).pathname))('peer backup governance', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(url!, { max: 6 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => {
    await pool?.end()
  })
  it.skipIf(!process.env.HGW_TEST_RESTIC)('rotates a live encrypted repository and retires it after an independent recovery drill', async () => {
    const root = await mkdtemp(join(tmpdir(),'peer-retirement-'))
    const org = randomUUID(), source = randomUUID(), target = randomUUID(), slug = 'rotation-'+org
    try {
      await pool.query("INSERT INTO harness.organizations(id,slug,display_name) VALUES($1,$2,'Repository rotation')",[org,slug])
      await pool.query("INSERT INTO harness.compute_nodes(id,organization_id,name) VALUES($1,$2,'source'),($3,$2,'target')",[source,org,target])
      await pool.query("UPDATE harness.deployment_topology SET enabled=true,revision=1,primary_node_id=$2,primary_origin='https://primary.test' WHERE organization_id=$1",[org,source])
      await pool.query(`INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,platform,architecture,connection_id,connection_epoch,lease_expires_at)
        VALUES($1,$2,$3,'linux','x64',$4,1,clock_timestamp()+interval '5 minutes')`,[org,target,randomBytes(32),randomUUID()])
      const admin = (await pool.query<{id:string;public_id:string}>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
        VALUES($1,'admin','Administrator',$2) RETURNING id,public_id::text`,[org,join(root,'admin')])).rows[0]!
      await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')",[org,admin.id])
      await pool.query("INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,'fixture-password',false)",[admin.id])
      const primary = await resolvePostgresRuntimeContext(pool,slug,'source'), receiver = await resolvePostgresRuntimeContext(pool,slug,'target')
      const actor = Number(admin.public_id), governance = new PeerBackupGovernance(primary)
      await actualPeerFlow(primary,receiver,actor,root,process.env.HGW_TEST_RESTIC!,{rotate:true})
      const legacy = randomUUID()
      await governance.configure(actor,{ id:legacy,scopeKind:'governance',scopeId:org,sourceNodeId:source,targetNodeId:target,
        tier:'important',enabled:false,expectedRevision:0,quotaBytes:1<<20,appendFingerprint:digest('legacy-a'),recoveryFingerprint:digest('legacy-r') })
      await pool.query(`INSERT INTO harness.peer_backup_points(id,organization_id,policy_id,revision,writer_epoch,watermark,snapshot_id,manifest_digest,
        covered_count,gap_count,protected_through) VALUES($1,$2,$3,1,1,1,$4,$5,3,1,clock_timestamp()-interval '2 hours')`,
        [randomUUID(),org,legacy,digest('legacy-snapshot'),digest('legacy-manifest')])
      expect(await governance.list(actor)).toContainEqual(expect.objectContaining({
        policyId:legacy,coverage:'partial',freshness:'overdue',
      }))
    } finally {
      await rm(root,{recursive:true,force:true})
      await removeFixtureOrganization(pool,org)
    }
  },120000)
  it('exports only opaque project coordinates and rejects a content field in restored governance', async () => {
    const org = randomUUID(), node = randomUUID(),
      root = await mkdtemp(join(tmpdir(), 'hgw-peer-governance-fields-')),
      title = 'private-project-title-' + randomUUID()
    try {
      await pool.query("INSERT INTO harness.organizations(id,slug,display_name) VALUES($1,$2,'Field audit')",
        [org, 'governance-' + org])
      await pool.query("INSERT INTO harness.compute_nodes(id,organization_id,name) VALUES($1,$2,'primary')", [node, org])
      await pool.query(`UPDATE harness.deployment_topology SET enabled=true,revision=1,primary_node_id=$2,
        primary_origin='https://primary.test' WHERE organization_id=$1`, [org, node])
      const owner = (await pool.query(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
        VALUES($1,'owner','Owner','/private/local-only') RETURNING id`, [org])).rows[0].id
      await pool.query(`INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled,revision)
        VALUES($1,$2,$3,false,7)`, [org,node,owner])
      await pool.query(`INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path)
        VALUES($1,$2,$3,'/private/account-documents')`, [org,node,owner])
      await pool.query(`INSERT INTO harness.user_quotas(user_id,token_mode,token_limit,company_cost_mode)
        VALUES($1,'custom',1234,'inherit')`,[owner])
      await pool.query(`INSERT INTO harness.audit_events(organization_id,action,detail)
        VALUES($1,'backup-policy-changed',$2::jsonb)`,[org,JSON.stringify({privateContent:title})])
      await pool.query(`INSERT INTO harness.projects(organization_id,name,created_by,owner_user_id)
        VALUES($1,$2,$3,$3)`, [org, title, owner])
      const binding = { organizationId: org, scopeId: org, sourceNodeId: node, targetNodeId: randomUUID(),
        policyId: randomUUID(), revision: 1 }
      const exporter = new PeerControlExporter(pool, { maxBytes: 1 << 20, maxRows: 500 }),
        payload = join(root, 'payload'), signal = new AbortController().signal
      await mkdir(payload, { mode: 0o700 })
      const captured = await exporter.capture(binding, payload, signal)
      const jsonl = join(payload, 'governance.jsonl'), body = await readFile(jsonl, 'utf8')
      expect(body).toContain('"table":"projects"')
      expect(body).not.toContain(title)
      expect(body).not.toContain('/private/local-only')
      expect(body).not.toContain('/private/account-documents')
      const records=body.trim().split('\n').map(line=>JSON.parse(line))
      expect(records).toContainEqual({table:'computer_use_permissions',row:expect.objectContaining({user_id:owner,enabled:false,revision:7})})
      expect(records).toContainEqual({table:'user_quotas',row:expect.objectContaining({user_id:owner,token_limit:1234})})
      expect(records).toContainEqual({table:'audit_events',row:expect.objectContaining({action:'backup-policy-changed'})})
      await exporter.validate(binding, captured, payload, signal)
      const changed = body.split('\n').filter(Boolean).map((line) => {
        const record = JSON.parse(line)
        if (record.table === 'projects') record.row.name = title
        return JSON.stringify(record)
      }).join('\n') + '\n'
      await writeFile(jsonl, changed)
      const manifestPath = join(payload, 'governance.json'),
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      await writeFile(manifestPath, JSON.stringify({ ...manifest, sha256: digest(changed) }))
      await expect(exporter.validate(binding, captured, payload, signal)).rejects.toMatchObject({
        code: 'peer-backup/invalid-export',
      })
      const legacyLines=changed.trim().split('\n').filter(line=>['organizations','users','compute_nodes','projects','deployment_topology'].includes(JSON.parse(line).table))
      const legacyBody=legacyLines.join('\n')+'\n'
      await writeFile(jsonl,legacyBody)
      await writeFile(manifestPath, JSON.stringify({ ...manifest, version: 1, rows:legacyLines.length,sha256: digest(legacyBody) }))
      const legacy = { ...captured, coveredCount: 17 }
      await exporter.validate(binding, legacy, payload, signal)
      await expect(exporter.validate(binding, { ...legacy, gaps: [] }, payload, signal)).rejects.toMatchObject({
        code: 'peer-backup/coverage-incomplete',
      })
    } finally {
      await removeFixtureOrganization(pool, org)
      await rm(root, { recursive: true, force: true })
    }
  })
  it('retains destination approvals and confirmed history, rejects stale attempts, and refuses mixed or incomplete schemas', async () => {
    const slug = 'peer-' + randomUUID(),
      root = await mkdtemp(join(tmpdir(), 'hgw-peer-control-'))
    const org = (
      await pool.query<{ id: string }>(
        "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Peer') RETURNING id",
        [slug],
      )
    ).rows[0]!.id
    try {
      for (const name of ['primary', 'target'])
        await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [org, name])
      const a = await resolvePostgresRuntimeContext(pool, slug, 'primary'),
        b = await resolvePostgresRuntimeContext(pool, slug, 'target')
      const cfg = testConfig(root),
        users = new PostgresUserService(a, cfg),
        admin = await users.create({ username: 'operator', password: 'test-password', role: 'admin' })
      const member = await users.create({ username: 'reader', password: 'test-password' })
      await users.changeOwnPassword(admin.id, 'operator-password')
      await users.changeOwnPassword(member.id, 'reader-password')
      const topology = new PostgresDeploymentTopology(a, {
        legacyForwarding: false,
        refreshAfterMs: 30000,
        pageSize: 10,
        maxBytes: 65536,
        allowedOrigins: ['https://primary.test'],
      })
      await topology.save(admin, {
        revision: (await topology.read()).revision,
        enabled: true,
        primaryOrigin: 'https://primary.test',
      })
      const nodes = new PostgresNodeAccessService(a, cfg.nodeAccess, cfg.runtimeCatalog)
      const ticket = await nodes.issue(admin, { requestId: randomUUID(), nodeId: b.nodeId }),
        credential = ('dsh_node_' + randomBytes(32).toString('base64url')) as NodeCredential
      await nodes.enroll(ticket.token, { protocolVersion: 1, platform: 'linux', architecture: 'arm64', credential })
      await nodes.connect(credential, { connectionId: randomUUID(), executionReady: false })
      const ga = new PeerBackupGovernance(a),
        gb = new PeerBackupGovernance(b),
        token = randomBytes(32).toString('hex'),
        readToken = randomBytes(32).toString('hex')
      expect((await ga.choices(admin.id, a.nodeId, 'governance'))[0]).toMatchObject({ id: org })
      const input = {
        id: randomUUID(),
        expectedRevision: 0,
        scopeId: org,
        scopeKind: 'governance',
        sourceNodeId: a.nodeId,
        targetNodeId: b.nodeId,
        tier: 'important',
        enabled: true,
        quotaBytes: 16 << 20,
        appendFingerprint: digest(token),
        recoveryFingerprint: digest(readToken),
      }
      await expect(ga.configure(member.id, input)).rejects.toThrow()
      const policy = await ga.configure(admin.id, input)
      expect((await ga.choices(admin.id, a.nodeId, 'governance'))[0]).toMatchObject({ id: org })
      await expect(ga.configure(admin.id, input)).rejects.toMatchObject({ code: 'peer-backup/revision-conflict' })
      await expect(ga.configure(admin.id, { ...input, id: randomUUID(), targetNodeId: a.nodeId })).rejects.toMatchObject({
        code: 'peer-backup/invalid-pair',
      })
      const grant = await gb.grant(policy.policyId, a.nodeId, token)
      expect(grant.mode).toBe('append')
      expect((await gb.grant(policy.policyId, a.nodeId, readToken)).mode).toBe('recover')
      await expect(gb.grant(policy.policyId, b.nodeId, token)).rejects.toMatchObject({ code:'peer-backup/recovery-protocol-upgrade-required' })
      const first = await ga.enqueue(admin.id, policy.policyId, 'capture')
      expect(await ga.enqueue(admin.id, policy.policyId, 'capture')).toBe(first)
      const job = await ga.claim()
      expect(job?.id).toBe(first)
      await ga.heartbeat(job!, { phase: 'transferring', pendingBytes: 200 })
      const point = {
        ...policy,
        version: 1 as const,
        pointId: first,
        writerEpoch: '1',
        watermark: '2',
        capturedAt: new Date().toISOString(),
        snapshotId: digest('fixture snapshot'),
        manifestDigest: digest('fixture manifest'),
        coveredCount: 1,
        gapCount: 0,
      }
      await ga.finish(job!, { point })
      expect((await ga.list(admin.id))[0]).toMatchObject({ coverage: 'current', pointId: first, gapCount: 0 })
      const rehearsal = await ga.enqueue(admin.id, policy.policyId, 'drill', first, b.nodeId)
      const drill = await gb.claim()
      expect(drill?.id).toBe(rehearsal)
      await gb.finish(drill!, { recoveryMs: 123 })
      expect(await ga.preflight(admin.id, policy.policyId, first, b.nodeId)).toEqual({
        readyForFencing: false,
        blockers: ['peer-backup/isolated-recovery-only','peer-backup/verified-writer-fence-required'],
      })
      const next = await ga.enqueue(admin.id, policy.policyId, 'capture')
      const old = await ga.claim()
      expect(old?.id).toBe(next)
      const paused = await ga.configure(admin.id, {
        ...input,
        expectedRevision: 1,
        enabled: false,
        appendFingerprint: digest('rotation'),
      })
      expect(paused.revision).toBe(2)
      await expect(grant.revalidate()).rejects.toMatchObject({ status: 403 })
      // A database replacement preserves current credentials, disabled state and historical receipts, even if the dump carried older rows.
      await transaction(pool, async (tx) => {
        await tx.query(PEER_BACKUP_RESTORE_PREFIX)
        await tx.query('DELETE FROM harness.peer_backup_points WHERE organization_id=$1', [org])
        await tx.query('UPDATE harness.peer_backup_policies SET enabled=true,revision=1,append_hash=$2 WHERE id=$1', [
          input.id,
          digest(token),
        ])
        await tx.query(PEER_BACKUP_RESTORE_SUFFIX)
      })
      expect((await ga.list(admin.id))[0]).toMatchObject({
        enabled: false,
        revision: 3,
        appendFingerprint: digest('rotation'),
        pointId: first,
      })
      await expect(ga.finish(old!, { point: { ...point, pointId: next } })).rejects.toMatchObject({
        code: 'peer-backup/claim-lost',
      })
      await expect(
        transaction(pool, async (tx) => {
          await tx.query(PEER_BACKUP_RESTORE_PREFIX)
          await tx.query('ALTER TABLE harness.peer_backup_points RENAME TO fixture_missing_peer_points')
          await tx.query(PEER_BACKUP_RESTORE_SUFFIX)
        }),
      ).rejects.toThrow(/schema and migration 109 disagree/u)
      expect((await ga.points(admin.id, input.id))[0]).toMatchObject({ id: first })
      await expect(
        transaction(pool, async (tx) => {
          await tx.query(PEER_BACKUP_RESTORE_PREFIX)
          await tx.query("UPDATE harness.compute_nodes SET status='offline' WHERE organization_id=$1 AND id=$2", [
            org,
            b.nodeId,
          ])
          await tx.query(PEER_BACKUP_RESTORE_SUFFIX)
        }),
      ).rejects.toThrow(/authority differs/u)
      const runtime = (
        await pool.query<{ id: string }>(
          `INSERT INTO harness.runtime_environments(id,organization_id,owner_kind,owner_id,node_id)
        SELECT gen_random_uuid(),organization_id,'user',id,$3 FROM harness.users WHERE organization_id=$1 AND public_id=$2 RETURNING id`,
          [org, member.id, a.nodeId],
        )
      ).rows[0]!.id
      await ga.configure(admin.id, { ...input, id: randomUUID(), scopeKind: 'personal', scopeId: runtime, enabled: false })
      await pool.query('UPDATE harness.runtime_environments SET retired_at=now() WHERE id=$1', [runtime])
      await expect(
        transaction(pool, async (tx) => {
          await tx.query(PEER_BACKUP_RESTORE_PREFIX)
          await tx.query('UPDATE harness.runtime_environments SET retired_at=NULL WHERE id=$1', [runtime])
          await tx.query(PEER_BACKUP_RESTORE_SUFFIX)
        }),
      ).rejects.toThrow(/authority differs/u)
      expect(
        (await pool.query('SELECT retired_at FROM harness.runtime_environments WHERE id=$1', [runtime])).rows[0].retired_at,
      ).not.toBeNull()
      await transaction(pool, async (tx) => {
        // Both old baselines without any 109 object safely pass. Rollback leaves the shared fixture schema intact.
        await tx.query('SAVEPOINT before_old_schema')
        await tx.query('DROP TABLE harness.peer_backup_points,harness.peer_backup_work,harness.peer_backup_policies CASCADE')
        await tx.query('DELETE FROM harness.schema_migrations WHERE version=109')
        await tx.query(PEER_BACKUP_RESTORE_PREFIX)
        await tx.query(PEER_BACKUP_RESTORE_SUFFIX)
        await tx.query('ROLLBACK TO SAVEPOINT before_old_schema')
      })
      if (process.env.HGW_TEST_RESTIC) await actualPeerFlow(a, b, admin.id, root, process.env.HGW_TEST_RESTIC)
    } finally {
      await pool.query('DELETE FROM harness.peer_backup_points WHERE organization_id=$1', [org])
      await pool.query('DELETE FROM harness.peer_backup_work WHERE organization_id=$1', [org])
      await pool.query('DELETE FROM harness.peer_backup_policies WHERE organization_id=$1', [org])
      await removeFixtureOrganization(pool, org)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serializes a manual capture with scheduler admission without a policy/work lock inversion', async () => {
    const org = randomUUID(), source = randomUUID(), target = randomUUID(), slug = 'capture-lock-' + org
    const root = await mkdtemp(join(tmpdir(), 'peer-capture-lock-'))
    const manualName = ('manual-' + randomUUID().replaceAll('-', '')).slice(0, 60),
      claimName = ('claim-' + randomUUID().replaceAll('-', '')).slice(0, 60)
    let manualPool: Pool | undefined, claimPool: Pool | undefined, barrier: PoolClient | undefined
    const trigger = 'fixture_pause_manual_peer_capture', barrierKey = Math.floor(Math.random() * 2 ** 30) + 1
    try {
      await pool.query("INSERT INTO harness.organizations(id,slug,display_name) VALUES($1,$2,'Capture lock ordering')", [org, slug])
      await pool.query("INSERT INTO harness.compute_nodes(id,organization_id,name) VALUES($1,$2,'source'),($3,$2,'target')", [source, org, target])
      await pool.query('UPDATE harness.deployment_topology SET enabled=true,revision=1,primary_node_id=$2,primary_origin=$3 WHERE organization_id=$1', [org, source, 'https://primary.test'])
      await pool.query(`INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,platform,architecture,connection_id,connection_epoch,lease_expires_at)
        VALUES($1,$2,$3,'linux','x64',$4,1,clock_timestamp()+interval '5 minutes')`, [org, target, randomBytes(32), randomUUID()])
      const admin = (await pool.query<{ public_id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
        VALUES($1,'admin','Administrator',$2) RETURNING public_id::text`, [org, join(root, 'admin')])).rows[0]!
      await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) SELECT organization_id,id,'admin' FROM harness.users WHERE organization_id=$1", [org])
      await pool.query("INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) SELECT id,'fixture-password',false FROM harness.users WHERE organization_id=$1", [org])
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON harness.peer_backup_work`)
      await pool.query(`DROP FUNCTION IF EXISTS harness.${trigger}()`)
      barrier = await pool.connect()
      await barrier.query('SELECT pg_advisory_lock($1::bigint)', [barrierKey])
      await pool.query(`CREATE FUNCTION harness.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF current_setting('application_name')='${manualName}' THEN PERFORM pg_advisory_lock(${barrierKey}); PERFORM pg_advisory_unlock(${barrierKey}); END IF; RETURN NEW; END $$`)
      await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON harness.peer_backup_work FOR EACH ROW
        WHEN (NEW.kind='capture') EXECUTE FUNCTION harness.${trigger}()`)
      const primary = await resolvePostgresRuntimeContext(pool, slug, 'source')
      manualPool = createPostgresPool(url!, { max: 1, application_name: manualName })
      claimPool = createPostgresPool(url!, { max: 1, application_name: claimName })
      const manualGovernance = new PeerBackupGovernance({ ...primary, pool: manualPool }),
        claimGovernance = new PeerBackupGovernance({ ...primary, pool: claimPool }),
        actor = Number(admin.public_id)
      const input = { id: randomUUID(), expectedRevision: 0, scopeKind: 'governance' as const, scopeId: org,
        sourceNodeId: source, targetNodeId: target, tier: 'important' as const, enabled: true,
        quotaBytes: 1 << 20, appendFingerprint: digest('manual-append'), recoveryFingerprint: digest('manual-recover') }
      await manualGovernance.configure(actor, input)
      const manual = manualGovernance.enqueue(actor, input.id, 'capture')
      await expect.poll(async () => (await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE application_name=$1 AND starts_with(query,'INSERT INTO harness.peer_backup_work') AND wait_event_type='Lock'`, [manualName])).rowCount, { timeout: 5000 }).toBe(1)
      const claim = claimGovernance.claim()
      await expect.poll(async () => (await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE application_name=$1 AND wait_event_type='Lock'`, [claimName])).rowCount, { timeout: 5000 }).toBe(1)
      await barrier.query('SELECT pg_advisory_unlock($1::bigint)', [barrierKey])
      const operationId = await manual
      expect(await claim).toMatchObject({ id: operationId })
      await pool.query(`DROP TRIGGER ${trigger} ON harness.peer_backup_work`)
      await pool.query(`DROP FUNCTION harness.${trigger}()`)
    } finally {
      if (barrier) {
        await barrier.query('SELECT pg_advisory_unlock_all()').catch(() => {})
        barrier.release()
      }
      await manualPool?.end()
      await claimPool?.end()
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON harness.peer_backup_work`)
      await pool.query(`DROP FUNCTION IF EXISTS harness.${trigger}()`)
      await removeFixtureOrganization(pool, org)
      await rm(root, { recursive: true, force: true })
    }
  }, 15000)

})
