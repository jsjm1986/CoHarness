/** Node configuration health acknowledgments bind the actual Gateway computer. */
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterEach, expect, it } from 'vitest'
import { createGatewayServer } from '../src/server.ts'
import { AuthService } from '../src/auth.ts'
import { AuditService } from '../src/audit.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import { ProjectService } from '../src/projects.ts'
import { UserService } from '../src/users.ts'
import { createNodeConfigurationHost } from '../src/node-config-host.ts'
import { NodeConfigurationStore, readNodeConfiguration } from '../src/node-config-store.ts'
import { NODE_SERVICE_TARGET_HEADER } from '../src/node-service-stream.ts'
import type { RuntimeNodeId } from '../src/runtime-catalog.ts'
import { testEnvironment, testConfig } from './test-config.ts'
import { isolatedNodeConfigurationAuthority } from './node-config-fixture.ts'

const releases: Array<() => Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const release of releases.splice(0).reverse()) {
    try { await release() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Node configuration health fixture cleanup failed')
})
async function listen(server: Server): Promise<number> {
  releases.push(async () => {
    if (!server.listening) return
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return (server.address() as AddressInfo).port
}

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('rejects another Gateway computer even when its healthy release and configuration revision match', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hgw-config-health-node-'))
  releases.push(() => rm(root, { recursive: true, force: true }))
  const env = testEnvironment(root), cfg = testConfig(root, env)
  const db = openDb(join(root, 'health.sqlite'))
  releases.push(async () => { db.close() })
  const pool = new Pool({ connectionString: 'postgres://synthetic.invalid/never-connected' })
  releases.push(() => pool.end())
  const context = { pool, organizationId: randomUUID(), organizationSlug: 'fixture', nodeId: randomUUID() as RuntimeNodeId, nodeName: 'own-node' }
  const store = new NodeConfigurationStore(context, cfg, env, isolatedNodeConfigurationAuthority)
  await store.initialize()
  const record = (await readNodeConfiguration(cfg.nodeConfigFile, env))!
  const host = createNodeConfigurationHost(env, context, new AbortController().signal)
  const users = new UserService(db, cfg), instances = new InstanceManager(db, cfg)
  releases.push(() => instances.stopAll())
  function gateway(nodeId: RuntimeNodeId) {
    return createGatewayServer({ cfg, users, instances, auth: new AuthService(db, cfg),
      projects: new ProjectService(db, cfg), audit: new AuditService(db),
      nodeServiceIdentity: { nodeId, organizationId: context.organizationId,
        authorize: async () => { throw new Error('The health request must not enter node control authorization') } },
    })
  }
  const foreignId = randomUUID() as RuntimeNodeId, foreign = gateway(foreignId), own = gateway(context.nodeId)
  let requestedNode: string | string[] | undefined
  foreign.prependListener('request', request => { requestedNode = request.headers[NODE_SERVICE_TARGET_HEADER] })
  const foreignPort = await listen(foreign), ownPort = await listen(own)
  const foreignHealth = await fetch(`http://127.0.0.1:${foreignPort}/healthz`)
  expect(foreignHealth.ok).toBe(true)
  expect(await foreignHealth.json()).toMatchObject({ ok: true, configurationRevision: record.appliedRevision })
  expect(foreignHealth.headers.get(NODE_SERVICE_TARGET_HEADER)).toBe(foreignId)
  record.applied.HGW_PORT = String(foreignPort)
  expect(await host.isHealthy(record)).toBe(false)
  expect(requestedNode).toBe(context.nodeId)
  record.applied.HGW_PORT = String(ownPort)
  expect(await host.isHealthy(record)).toBe(true)
})
