/** Authenticated Gateway copies use real filesystem uploads and live organization roles. */
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const gateway = fileURLToPath(new URL('../../', import.meta.url))
const mode = process.argv[2] ?? 'src'
assert.ok(mode === 'src' || mode === 'lib')
const directory = mode === 'src' ? join(gateway, 'src') : resolve(process.argv[3] || join(gateway, 'lib'))
const load = name => import(pathToFileURL(join(directory, name + (mode === 'src' ? '.ts' : '.js'))).href)
const { createPostgresPool, runMigrations } = await load('postgres/database')
const { resolvePostgresRuntimeContext } = await load('postgres/runtime-context')
const { PostgresUserService } = await load('postgres/user-service')
const { PostgresProjectService } = await load('postgres/project-service')
const { PostgresAuthService } = await load('postgres/auth-service')
const { PostgresAuditService } = await load('postgres/audit-service')
const { PostgresInstanceRepository } = await load('postgres/instance-repository')
const { PostgresCollaborationService } = await load('postgres/collaboration-service')
const { PostgresDocumentLocations } = await load('postgres/document-locations')
const { PostgresDocumentCatalogService } = await load('postgres/document-catalog-service')
const { createDocumentCatalogHandlers } = await load('document-catalog')
const { PostgresComputerAccess } = await load('computer-access')
const { GatewayPrincipalSigner } = await load('principal')
const { LocalDocumentBroker } = await load('documents-local')
const { createGatewayDocumentScopeHandler, createGatewayDocumentTransferUploadHandler } = await load('document-transfer')
const { createBrowserDocumentHandler } = await load('browser-documents')
const { InstanceManager } = await load('instances')
const { createGatewayServer } = await load('server')
const { loadConfig } = await load('config')
const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
assert.ok(url, 'A disposable PostgreSQL database is required')
const pool = createPostgresPool(url, { max: 4 })

try {
  await runMigrations(pool, join(gateway, 'deploy/postgres/migrations'))
  for (const scenario of ['stable-admin', 'demoted-fanout', 'single-member']) {
    const root = await mkdtemp(join(tmpdir(), 'hgw-browser-fanout-'))
    let server, local, instances, failure
    let demoted = false, starts = 0
    const targets = []
    try {
      const slug = 'fanout-' + randomUUID()
      const org = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Synthetic fan-out') RETURNING id", [slug])).rows[0].id
      const node = (await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local-document-computer') RETURNING id", [org])).rows[0].id
      const context = await resolvePostgresRuntimeContext(pool, slug, 'local-document-computer')
      const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'),
        HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
        HGW_STATE_ROOT: join(root, 'state'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
      await mkdir(cfg.stateRoot, { recursive: true, mode: 0o700 })
      const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg)
      const actor = await users.create({ username: 'copy-user', password: 'synthetic-password', role: scenario === 'single-member' ? 'user' : 'admin' })
      await users.changeOwnPassword(actor.id, 'synthetic-password')
      const user = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [org, actor.id])).rows[0].id
      await pool.query('INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [org, node, user, actor.homePath])
      await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true) ON CONFLICT DO NOTHING', [org, node, user])
      const home = (await users.getById(actor.id)).homePath
      await mkdir(join(home, 'documents'), { recursive: true })
      await writeFile(join(home, 'documents/report.txt'), 'hello')
      for (let i = 0; i < 2; i++) {
        const project = (await pool.query(`INSERT INTO harness.projects(organization_id,name,created_by,owner_user_id)
          VALUES($1,$2,$3,$3) RETURNING id,public_id::text`, [org, 'project-' + randomUUID(), user])).rows[0]
        const path = join(root, 'projects', 'target-' + i)
        await mkdir(path, { recursive: true })
        await pool.query('INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path) VALUES($1,$2,$3,$4,$4)', [org, project.id, node, path])
        await pool.query("INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode) VALUES($1,$2,$3,'rw')", [org, project.id, user])
        await pool.query('INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port) VALUES($1,$2,$3,$4)', [org, project.id, node, 48500 + i])
        targets.push({ scope: { kind: 'project', projectId: Number(project.public_id), nodeId: node }, path })
      }
      const collaboration = new PostgresCollaborationService(context)
      const computerAccess = new PostgresComputerAccess(context, cfg.runtimeCatalog, node)
      const audit = new PostgresAuditService(context)
      const catalog = new PostgresDocumentCatalogService(context)
      instances = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg, {
        instancesOutliveGateway: false, start: async () => { starts++; throw new Error('Document copies must not start a Runtime') },
      })
      local = new LocalDocumentBroker({ cfg, nodeId: node, users, projects, collaboration, organizationId: org, computerAccess,
        catalog: createDocumentCatalogHandlers(catalog, audit) })
      const transfer = { instances, users, projects, collaboration, local, catalog,
        principals: new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, org, 60000), upstreamTimeoutMs: 10000 }
      const upload = createGatewayDocumentTransferUploadHandler(transfer)
      const services = { cfg, users, projects, collaboration, instances, computerAccess,
        nodeServiceIdentity: { nodeId: node, organizationId: org, authorize: async () => { throw new Error('No node-service tunnel is used') } },
        auth: new PostgresAuthService(context, cfg), audit }
      server = createGatewayServer(services, {
        documentScope: createGatewayDocumentScopeHandler(transfer),
        documentTransferUpload: async input => {
          const response = await upload(input)
          if (scenario === 'demoted-fanout' && !demoted && input.request.method === 'POST'
            && input.pathname === '/api/documents/transfer/uploads') {
            assert.ok(response.ok)
            await pool.query("UPDATE harness.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [org, user])
            demoted = true
          }
          return response
        },
        browserDocuments: createBrowserDocumentHandler({ transfer, organizationId: org, origin: 'http://127.0.0.1',
          locations: new PostgresDocumentLocations(context, { pageSize: 40, maxBytes: 65536 }, node), responseLimit: cfg.upstreamResponseLimitBytes }),
      })
      await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
      const base = 'http://127.0.0.1:' + server.address().port
      cfg.publicOrigins.push(base)
      const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { origin: base,
        'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: actor.username, password: 'synthetic-password' }) })
      const cookie = login.headers.get('set-cookie')?.split(';')[0]
      await login.arrayBuffer(); assert.equal(login.status, 302); assert.ok(cookie)
      const payload = { version: 1, source: { kind: 'personal', nodeId: node }, documents: [{ docId: 'report.txt' }],
        ...scenario === 'single-member' ? { target: targets[0].scope } : { targets: targets.map(target => target.scope) } }
      const response = await fetch(base + '/account/api/documents/transfer/copy', { method: 'POST', redirect: 'error',
        headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) })
      const result = await response.json(); assert.equal(response.status, 200)
      const outcomes = (result.targets ?? [result]).flatMap(target => target.items)
      const files = []
      for (const target of targets) {
        const directory = join(target.path, 'documents')
        try {
          for (const name of await readdir(directory)) if (name.endsWith('.txt')) files.push(await readFile(join(directory, name), 'utf8'))
        } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      assert.equal(starts, 0)
      if (scenario === 'demoted-fanout') {
        assert.equal(demoted, true, JSON.stringify(result))
        assert.deepEqual(outcomes.map(item => item.status), ['failed', 'failed'])
        assert.ok(outcomes.every(item => item.error.code === 'DOCUMENT_TRANSFER_MULTI_TARGET_FORBIDDEN'))
        assert.deepEqual(files, [])
      } else {
        assert.deepEqual(outcomes.map(item => item.status), scenario === 'single-member' ? ['copied'] : ['copied', 'copied'], JSON.stringify(result))
        assert.deepEqual(files, scenario === 'single-member' ? ['hello'] : ['hello', 'hello'])
      }
      console.log(JSON.stringify({ scenario, targets: outcomes.length, copied: files.length,
        denied: outcomes.filter(item => item.status === 'failed').length, runtimeStarts: starts }))
    } catch (error) {
      failure = error
      throw error
    } finally {
      const cleanupFailures = []
      for (const dispose of [
        async () => {
          if (!server) return
          server.closeAllConnections()
          await new Promise((ready, reject) => server.close(error => error ? reject(error) : ready()))
        },
        () => local?.dispose(),
        () => instances?.stopAll(),
      ]) {
        try { await dispose() } catch (error) { cleanupFailures.push(error) }
      }
      if (cleanupFailures.length) {
        throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanupFailures], 'Gateway copy fixture did not become quiescent')
      }
      await rm(root, { recursive: true, force: true })
    }
  }
} finally { await pool.end() }
