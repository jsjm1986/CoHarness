/** Physically isolated computers retain revoked identities without blocking organization mode changes. */
import { randomBytes, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresDeploymentTopology } from '../src/deployment-topology.ts'
import { PeerProjectRecovery } from '../src/peer-backup-takeover.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresNodeAccessService } from '../src/postgres/node-access-service.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { disasterRecoveryFixture,acceptSyntheticRecoveryCandidate } from './peer-backup-disaster-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig } from './test-config.ts'

const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = url === undefined ? describe.skip : describe
describePg('quarantined computers and deployment modes', () => {
  let pool: Pool
  const roots: string[] = []
  beforeAll(async () => {
    pool = createPostgresPool(url!, { max: 3 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => {
    try { await pool?.end() }
    finally { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) }
  })
  it('requires isolation proof to close aggregation and never makes the old identity independent or primary', async () => {
    const f = await disasterRecoveryFixture(pool, roots), cfg = testConfig(roots.at(-1)!)
    const actor = (await new PostgresUserService(f.primary, cfg).getById(f.adminId))!
    const options = { legacyForwarding: false, refreshAfterMs: 30000, pageSize: 10, maxBytes: 65536,
      allowedOrigins: ['https://primary.test', 'https://replacement.test'] }
    const topology = new PostgresDeploymentTopology(f.primary, options)
    const nodes = new PostgresNodeAccessService(f.primary, cfg.nodeAccess, cfg.runtimeCatalog)
    await pool.query(`INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,platform,architecture,
      connection_id,connection_epoch,lease_expires_at) VALUES($1,$2,$3,'linux','x64',$4,2,clock_timestamp()+interval '5 minutes')`,
    [f.org, f.context.nodeId, randomBytes(32), randomUUID()])
    await pool.query(`UPDATE harness.instances SET observed_state='starting',desired_state='running',generation=7,
      runtime_token_hash=$2 WHERE runtime_id=$1`, [f.runtimeId, randomBytes(32)])
    await pool.query("UPDATE harness.instances SET observed_state='ready' WHERE runtime_id=$1", [f.runtimeId])
    await pool.query("UPDATE harness.compute_nodes SET status='offline' WHERE id=$1", [f.context.nodeId])
    expect(await topology.preflight(actor)).toMatchObject({ canDisable: false, blockingCount: 2 })
    await expect(topology.save(actor, { revision: (await topology.read()).revision, enabled: false }))
      .rejects.toMatchObject({ code: 'deployment/computers-still-attached' })
    await expect(pool.query('UPDATE harness.deployment_topology SET enabled=false WHERE organization_id=$1', [f.org]))
      .rejects.toMatchObject({ constraint: 'deployment_computers_attached' })
    const recovery = new PeerProjectRecovery(f.primary)
    const id = await recovery.request(f.adminId, { requestId: randomUUID(), policyId: f.policy, pointId: f.point,
      targetNode: f.target, targetVolume: f.targetVolume, recoveryMode: 'disaster' })
    await acceptSyntheticRecoveryCandidate(pool,id)
    await recovery.confirmIsolation(f.adminId, id, { confirm: id, policyRevision: 1, sourceGeneration: '7', sourceEpoch: '1',
      sourceNodeId: f.context.nodeId, pointId: f.point, isolationMethod: 'power-off', evidenceReference: 'console/topology-proof', acknowledgeDataLoss: true })
    expect(await topology.preflight(actor)).toMatchObject({ canDisable: false, blockingCount: 1,
      computers: [{ nodeId: f.target }] })
    expect((await nodes.list(actor, {})).items.find(node => node.nodeId === f.context.nodeId))
      .toMatchObject({ status: 'quarantined', executionReady: false })
    await nodes.mutate(actor, f.target, { action: 'detach', revision: 1 })
    expect(await topology.preflight(actor)).toEqual({ canDisable: true, blockingCount: 0, computers: [] })
    await topology.save(actor, { revision: (await topology.read()).revision, enabled: false })
    expect(await topology.read()).toMatchObject({ mode: 'single', scope: 'local' })
    expect((await pool.query('SELECT attachment_state FROM harness.node_agents WHERE node_id=$1', [f.context.nodeId])).rows)
      .toEqual([{ attachment_state: 'managed' }])
    expect((await pool.query(`SELECT observed_state,desired_state,runtime_token_hash,harness.node_execution_available(organization_id,assigned_node_id) allowed
      FROM harness.instances WHERE runtime_id=$1`, [f.runtimeId])).rows)
      .toEqual([{ observed_state: 'ready', desired_state: 'stopped', runtime_token_hash: null, allowed: false }])
    const isolated = new PostgresDeploymentTopology(f.context, options)
    await expect(isolated.save(actor, { revision: (await isolated.read()).revision, enabled: true, primaryOrigin: 'https://replacement.test' }))
      .rejects.toMatchObject({ code: 'deployment/current-computer-quarantined' })
    await expect(pool.query(`UPDATE harness.deployment_topology SET enabled=true,primary_node_id=$2 WHERE organization_id=$1`, [f.org, f.context.nodeId]))
      .rejects.toMatchObject({ constraint: 'deployment_primary_quarantined' })
    const nextContext = { ...f.primary, nodeId: f.target, nodeName: 'target' }
    const next = new PostgresDeploymentTopology(nextContext, options)
    await next.save(actor, { revision: (await next.read()).revision, enabled: true, primaryOrigin: 'https://replacement.test' })
    expect(await next.read()).toMatchObject({ mode: 'multi', role: 'primary', primary: { nodeId: f.target } })
    const nextNodes = new PostgresNodeAccessService(nextContext, cfg.nodeAccess, cfg.runtimeCatalog)
    await expect(nextNodes.mutate(actor, f.context.nodeId, { action: 'issue-enrollment', revision: 2, requestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'node-access/quarantined' })
    await expect(pool.query("UPDATE harness.instances SET desired_state='running',runtime_token_hash=$2 WHERE runtime_id=$1", [f.runtimeId, randomBytes(32)]))
      .rejects.toMatchObject({ constraint: 'runtime_recovery_review' })
    await expect(nextNodes.issue(actor, { requestId: randomUUID(), name: 'Replacement computer' }))
      .resolves.toMatchObject({ revision: 1 })
  })
})
