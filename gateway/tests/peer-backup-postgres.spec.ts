/** Real governance, receiver admission, persistent claims and database restore fences over an isolated PostgreSQL database. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
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
      await writeFile(manifestPath, JSON.stringify({ ...manifest, version: 1, sha256: digest(changed) }))
      const legacy = { ...captured, coveredCount: captured.coveredCount - 2 }
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
      await expect(gb.grant(policy.policyId, b.nodeId, token)).rejects.toMatchObject({ status: 403 })
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
})
