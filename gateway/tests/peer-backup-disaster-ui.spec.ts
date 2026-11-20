/** Actual Admin React, HTTP authority and PostgreSQL isolation approval. No restoration or Runtime is started. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Browser } from '../../apps/web/tests/peer-backup-browser.ts'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresNodeAccessService } from '../src/postgres/node-access-service.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { createPeerBackupGateway } from '../src/peer-backup-gateway.ts'
import { PeerProjectFileGate } from '../src/peer-backup-file-gate.ts'
import { disasterRecoveryFixture,acceptSyntheticRecoveryCandidate } from './peer-backup-disaster-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig } from './test-config.ts'
import { PeerBackupGovernance } from '../src/peer-backup-governance.ts'
import { publishRecoveryProtocol } from '../src/peer-backup-recovery-access.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describeUi = databaseUrl && process.env.HGW_TEST_DISASTER_UI === '1' ? describe : describe.skip
const snapshots = resolve(import.meta.dirname, 'snapshots/peer-backup-disaster')
const artifactRoot = process.env.HGW_TEST_UI_ARTIFACTS

describeUi('disaster isolation through the Admin browser', () => {
  let pool: Pool
  let browser: Browser
  let bundle: string
  let assets: Set<string>
  const roots: string[] = []

  beforeAll(async () => {
    const [{ chromium }, { build }] = await Promise.all([
      import('../../apps/web/tests/peer-backup-browser.ts'), import('vite'),
    ])
    pool = createPostgresPool(databaseUrl!)
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    bundle = await mkdtemp(join(await realpath(tmpdir()), 'hgw-disaster-ui-'))
    roots.push(bundle)
    const admin = resolve(import.meta.dirname, '../admin-ui')
    const entry = join(bundle, 'entry.ts')
    await writeFile(entry, `import React from ${JSON.stringify(join(admin, 'node_modules/react/index.js'))};
import { createRoot } from ${JSON.stringify(join(admin, 'node_modules/react-dom/client.js'))};
import { PeerBackupSection } from ${JSON.stringify(join(admin, 'src/pages/PeerBackupSection.tsx'))};
import { NodeAccessSection } from ${JSON.stringify(join(admin, 'src/pages/NodeAccessSection.tsx'))};
import { PendingEditsProvider } from ${JSON.stringify(join(admin, 'src/pending-edits.tsx'))};
import ${JSON.stringify(join(admin, 'src/index.css'))};
createRoot(document.getElementById('root')).render(React.createElement(PendingEditsProvider, null,
  window.location.search === '?access' ? React.createElement(NodeAccessSection) : React.createElement(PeerBackupSection, { nodes: window.fixtureNodes })));
`)
    await build({ configFile: false, root: admin, logLevel: 'error', define: { 'process.env.NODE_ENV': '"development"' }, build: {
      outDir: join(bundle, 'assets'), emptyOutDir: true, minify: false,
      lib: { entry, formats: ['es'], fileName: () => 'fixture.js', cssFileName: 'fixture' },
    } })
    assets = new Set(await readdir(join(bundle, 'assets')))
    browser = await chromium.launch({ headless: true })
  }, 60000)

  afterAll(async () => {
    await browser?.close()
    await pool?.end()
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  })

  for (const [name, viewport] of [
    ['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }],
  ] as const) it(`${name}: rejects a stale approval and records source isolation without starting execution`, async () => {
    const suffix = randomUUID().slice(8)
    const f = await disasterRecoveryFixture(pool, roots, false,
      { nodeIds: { source: '10000000' + suffix, target: '20000000' + suffix, primary: '30000000' + suffix } })
    const root = await mkdtemp(join(await realpath(tmpdir()), 'hgw-disaster-ui-server-'))
    roots.push(root)
    const cfg = testConfig(root)
    const replacement='40000000'+suffix,volume=randomUUID()
    await pool.query("INSERT INTO harness.compute_nodes(id,organization_id,name) VALUES($1,$2,'replacement')",[replacement,f.org])
    await pool.query(`INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,platform,architecture,connection_id,connection_epoch,lease_expires_at)
      VALUES($1,$2,$3,'linux','x64',$4,1,clock_timestamp()+interval '5 minutes')`,[f.org,replacement,randomBytes(32),randomUUID()])
    await pool.query(`INSERT INTO harness.node_content_volumes(organization_id,node_id,volume_id,cluster_id,database_oid)
      VALUES($1,$2,$3,'7812345678901234567',$4)`,[f.org,replacement,volume,name==='mobile'?40003:40002])
    await pool.query(`INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled)
      SELECT organization_id,$2,id,true FROM harness.users WHERE organization_id=$1 AND public_id=$3`,[f.org,replacement,f.adminId])
    await publishRecoveryProtocol(pool,f.org,replacement,300000,{project:true,personal:true})
    const actor = (await new PostgresUserService(f.primary, cfg).getById(f.adminId))!
    const nodeAccess = new PostgresNodeAccessService(f.primary, cfg.nodeAccess, cfg.runtimeCatalog)
    await pool.query(`INSERT INTO harness.node_agents(organization_id,node_id,execution_ready)
      VALUES($1,$2,true)`, [f.org, f.context.nodeId])
    const configFile = join(root, 'peer.json')
    await writeFile(configFile, JSON.stringify({ version: 1, directory: join(root, 'repository'),
      stagingDirectory: join(root, 'staging'), resticExecutable: process.execPath,
      capacityBytes: 1048576, maxExportBytes: 1048576, reserveBytes: 1,
      uploadKiBps: 1024, downloadKiBps: 1024, routes: [], pollMs: 60000,
    }), { mode: 0o600 })
    const resourceCalls: string[] = []
    const unused = (resource: string): never => {
      resourceCalls.push(resource)
      throw new Error(`The primary-only Admin fixture cannot access ${resource}`)
    }
    const gateway = await createPeerBackupGateway({ context: f.primary, configFile,
      recovery: { config: cfg, fileGate: new PeerProjectFileGate(cfg.stateRoot),
        volume: { readVolume: async () => unused('content'), writeVolume: async () => unused('content') },
        instances: { withStopped: async () => unused('Runtime') },
      },
    })
    const fixtureCookie = randomUUID()
    const nodes = [
      { nodeId: f.context.nodeId, name: 'Source computer' },
      { nodeId: f.target, name: 'Recovery computer' },
      { nodeId: f.primary.nodeId, name: 'Primary entry' },
      { nodeId: replacement, name: 'Replacement computer' },
    ].map((node) => ({ ...node, status: 'active', lastHeartbeatAt: null, heartbeatAgeMs: null,
      maintenanceAppliedEpoch: '1', inflightWrites: 0, activeRuntimes: 0, quiesced: false }))
    // One private cookie supplies the fixture actor. Every business authorization and state transition runs in PostgreSQL.
    const httpErrors: unknown[] = []
    const requests: { method: string; path: string; status: number }[] = []
    const server = createServer((req, res) => {
      void (async () => {
        if (req.headers.cookie !== `fixture=${fixtureCookie}`) { res.writeHead(401).end(); return }
        const path = new URL(req.url!, 'http://fixture.test').pathname
        if (path.startsWith('/admin/api/peer-backups')) {
          res.once('finish', () => requests.push({ method: req.method!, path, status: res.statusCode }))
          if (!await gateway.admin(req, res, f.adminId)) res.writeHead(404).end()
        } else if (path === '/admin/api/deployment/nodes/access' && req.method === 'GET') {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(await nodeAccess.list(actor, {})))
        } else if (path === '/') {
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><main id="root" style="max-width:1100px;margin:24px auto;padding:12px"></main><script>window.fixtureNodes=${JSON.stringify(nodes)}</script><script type="module" src="/fixture.js"></script></body></html>`)
        } else if (assets.has(path.slice(1))) {
          res.setHeader('content-type', path.endsWith('.css') ? 'text/css' : 'application/javascript')
          res.end(await readFile(join(bundle, 'assets', path.slice(1))))
        } else res.writeHead(404).end()
      })().catch((error: unknown) => { httpErrors.push(error); res.writeHead(500).end() })
    })
    let context: Awaited<ReturnType<Browser['newContext']>> | undefined
    onTestFinished(async () => {
      await context?.close()
      if (server.listening) await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()))
      await gateway.close()
    })
    await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture listener has no loopback port')
    const origin = `http://127.0.0.1:${address.port}`
    context = await browser.newContext({ viewport, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light',
      hasTouch: name === 'mobile', isMobile: name === 'mobile' })
    await context.addCookies([{ name: 'fixture', value: fixtureCookie, url: origin }])
    await context.addInitScript(() => localStorage.setItem('coharness-admin-language', 'en'))
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    const pointTime = '2026-01-01T00:00:00.000Z'
    await pool.query('UPDATE harness.peer_backup_points SET protected_through=$2 WHERE id=$1', [f.point, pointTime])
    const project = (await pool.query<{ scope_id: string }>('SELECT scope_id FROM harness.peer_backup_policies WHERE id=$1', [f.policy])).rows[0]!.scope_id
    const normalize = (text: string) => text.replaceAll(f.policy, '[policy]').replaceAll(project, '[project]')
      .replace(/Read approval expires: [^\n]+?\. Operations/gu,'Read approval expires: [expiry]. Operations')
    const capture = async (stage: string) => {
      const content = normalize(await page.locator('body').ariaSnapshot()) + '\n'
      const expected = join(snapshots, `${name}-${stage}.expected.md`)
      if (process.env.DSH_SNAPSHOT === 'refresh') { await mkdir(snapshots, { recursive: true }); await writeFile(expected, content) }
      expect(content).toBe(await readFile(expected, 'utf8'))
      if (artifactRoot) {
        await mkdir(artifactRoot, { recursive: true })
        await writeFile(join(artifactRoot, `${name}-${stage}.aria.md`), content)
        await page.screenshot({ path: join(artifactRoot, `${name}-${stage}.png`), fullPage: true })
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      const clipped = await page.locator('.peerBackupSection button').evaluateAll((buttons, mobile) => buttons.flatMap((button) => {
        const bounds = button.getBoundingClientRect()
        if(!bounds.width||!bounds.height)return []
        const section = button.closest('.section')!.getBoundingClientRect()
        return bounds.left < section.left + 1 || bounds.right > section.right - 1 ||
          (mobile && bounds.height < 44) || button.scrollWidth > button.clientWidth + 1
          ? [{ label: button.textContent, width: bounds.width, height: bounds.height, left: bounds.left }] : []
      }), name === 'mobile')
      expect(clipped).toEqual([])
    }
    try {
      await page.goto(origin)
      await page.getByRole('button', { name: 'Recovery points and drills', exact: true }).click()
      await page.getByRole('combobox',{name:'Independent rehearsal computer',exact:true}).selectOption(replacement)
      await page.getByText('Replacement backup read access',{exact:true}).click()
      const fingerprint=createHash('sha256').update(randomUUID()).digest('hex')
      await page.getByLabel('Replacement read credential fingerprint (SHA-256)',{exact:true}).fill(fingerprint)
      await page.getByLabel('Read approval expiry (local time)',{exact:true}).fill(new Date(Date.now()+120000).toISOString().slice(0,16))
      const approvedRead=page.waitForResponse(response=>response.url().endsWith('/recovery-access')&&response.request().method()==='POST')
      await page.getByRole('button',{name:'Approve backup reading on this computer',exact:true}).click()
      expect((await approvedRead).status()).toBe(200)
      await page.getByRole('button',{name:'Revoke read approval',exact:true}).waitFor()
      const requestedDrill=page.waitForResponse(response=>response.url().endsWith('/drill')&&response.request().method()==='POST')
      await page.getByRole('button',{name:'Start isolated drill',exact:true}).click()
      expect((await requestedDrill).status()).toBe(202)
      const replacementContext=await resolvePostgresRuntimeContext(pool,f.primary.organizationSlug,'replacement')
      const worker=new PeerBackupGovernance(replacementContext),job=await worker.claim()
      expect(job?.kind).toBe('drill');await worker.finish(job!,{recoveryMs:1})
      await page.getByRole('combobox', { name: 'Recovery method', exact: true }).selectOption('disaster')
      await page.getByText('This restores data and quarantines the entire source computer', { exact: false }).waitFor()
      await capture('disaster-mode')
      const requested=page.waitForResponse(response=>response.url().endsWith('/recoveries')&&response.request().method()==='POST')
      await page.getByRole('button', { name: 'Prepare replacement', exact: true }).click()
      expect((await requested).status()).toBe(202)
      const preparing=(await pool.query<{id:string}>("SELECT id FROM harness.project_recovery_operations WHERE organization_id=$1 AND phase='preparing'",[f.org])).rows[0]!
      await acceptSyntheticRecoveryCandidate(pool,preparing.id)
      await page.getByRole('button',{name:'Refresh takeover status',exact:true}).click()
      await page.getByText('Waiting for the administrator to record source isolation', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Record source isolation', exact: true }).click()
      const confirm = page.getByRole('button', { name: 'Confirm isolation and prepare recovery', exact: true })
      expect(await confirm.isEnabled()).toBe(false)
      await capture('prepared')
      await page.getByRole('textbox', { name: /^Isolation evidence reference/u }).fill('cloud-console/fixture-isolation-42')
      await page.keyboard.press('Tab')
      expect(await page.getByRole('checkbox', { name: 'I verified the source cannot continue tasks or external writes', exact: true })
        .evaluate((element) => element === document.activeElement)).toBe(true)
      await page.setViewportSize({ width: name === 'mobile' ? 430 : 1100, height: viewport.height })
      expect(await page.getByRole('checkbox', { name: 'I verified the source cannot continue tasks or external writes', exact: true })
        .evaluate((element) => element === document.activeElement)).toBe(true)
      await page.setViewportSize(viewport)
      await page.getByRole('checkbox', { name: 'I verified the source cannot continue tasks or external writes', exact: true }).check()
      await page.getByRole('checkbox', { name: 'I accept the data gap after this point and will review task outcomes', exact: true }).check()
      await pool.query('UPDATE harness.instances SET generation=2 WHERE runtime_id=$1', [f.runtimeId])
      const stale = page.waitForResponse((response) => response.url().endsWith('/confirm-isolation'))
      await confirm.click()
      expect((await stale).status()).toBe(409)
      await page.getByRole('alert').waitFor()
      expect((await pool.query('SELECT FROM harness.node_recovery_quarantines WHERE organization_id=$1', [f.org])).rowCount).toBe(0)
      expect(await page.getByRole('textbox', { name: /^Isolation evidence reference/u }).inputValue()).toBe('cloud-console/fixture-isolation-42')
      await capture('stale')
      await page.getByRole('button', { name: 'Refresh takeover status', exact: true }).click()
      await expect.poll(() => confirm.isEnabled()).toBe(false)
      await page.getByRole('button', { name: 'Back', exact: true }).click()
      await page.getByRole('button', { name: 'Record source isolation', exact: true }).click()
      await page.getByRole('checkbox', { name: 'I verified the source cannot continue tasks or external writes', exact: true }).check()
      await page.getByRole('checkbox', { name: 'I accept the data gap after this point and will review task outcomes', exact: true }).check()
      const approved = page.waitForResponse((response) => response.url().endsWith('/confirm-isolation'))
      await confirm.click()
      expect((await approved).status()).toBe(200)
      await page.getByText('Source isolated; preparing replacement data', { exact: true }).waitFor()
      await page.getByText('Restored data remains isolated from execution.', { exact: false }).waitFor()
      await capture('fenced')
      if (artifactRoot) {
        await page.emulateMedia({ colorScheme: 'dark' })
        await page.screenshot({ path: join(artifactRoot, `${name}-fenced-dark.png`), fullPage: true })
      }
      const operation = (await pool.query(`SELECT phase,EXISTS(SELECT FROM harness.project_recovery_execution_holds h
        WHERE h.operation_id=r.id) execution_review_required FROM harness.project_recovery_operations r WHERE policy_id=$1`, [f.policy])).rows[0]
      expect(operation).toEqual({ phase: 'externally-fenced', execution_review_required: true })
      expect((await pool.query('SELECT desired_state,observed_state,generation::text FROM harness.instances WHERE runtime_id=$1', [f.runtimeId])).rows[0])
        .toEqual({ desired_state: 'stopped', observed_state: 'stopped', generation: '2' })
      expect((await pool.query('SELECT FROM harness.node_recovery_quarantines WHERE organization_id=$1', [f.org])).rowCount).toBe(1)
      await page.emulateMedia({ colorScheme: 'light' })
      await page.goto(`${origin}/?access`)
      const isolated = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'source', exact: true }) })
      await isolated.getByText('Quarantined', { exact: true }).waitFor()
      expect(await isolated.getByRole('button').count()).toBe(0)
      await isolated.getByText('This computer is quarantined after disaster recovery and cannot enroll again.', { exact: true }).waitFor()
      await capture('computer-access')
      expect(resourceCalls).toEqual([])
      expect(pageErrors).toEqual([])
      expect(httpErrors).toEqual([])
      if (artifactRoot) await rm(join(artifactRoot, `${name}-failure.json`), { force: true })
      if (artifactRoot) await writeFile(join(artifactRoot, `${name}-http.json`), JSON.stringify(requests.map((request) => ({ ...request,
        path: request.path.replaceAll(f.policy, '[policy]').replace(/\/recoveries\/[^/]+\//u, '/recoveries/[operation]/'),
      })), null, 2) + '\n')
    } catch (error) {
      if (artifactRoot) {
        await mkdir(artifactRoot, { recursive: true })
        await writeFile(join(artifactRoot, `${name}-failure.json`), JSON.stringify({ pageErrors, requests,
          body: await page.locator('body').ariaSnapshot(), error: String(error) }, null, 2))
      }
      throw error
    }
  }, 60000)
})
