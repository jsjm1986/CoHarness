/** Actual Admin browser over an encrypted personal restore and PostgreSQL authority; no Runtime process is allocated. */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import type { PeerRecoveryExecution } from '../src/peer-backup-execution.ts'
import { createPeerBackupGateway } from '../src/peer-backup-gateway.ts'
import { PeerProjectFileGate } from '../src/peer-backup-file-gate.ts'
import { testConfig } from './test-config.ts'

/** Review a pending personal restore through the actual Admin component and HTTP handlers.
 * @param input - isolated encrypted point, governance authority and real target worker steps.
 * @returns after publication and new-conversation approval, with the Runtime still stopped.
 */
export async function exercisePersonalRecoveryUi(input: {
  primary: PostgresRuntimeContext; targetContext: PostgresRuntimeContext; adminId: number
  policyId: string; pointId: string; operationId: string; root: string
  advance: () => Promise<void>; executionService: PeerRecoveryExecution
  withLocalMode?: (exercise: () => Promise<void>) => Promise<void>
}): Promise<void> {
  const [{ chromium }, { build }] = await Promise.all([import('../../apps/web/tests/peer-backup-browser.ts'), import('vite')])
  const directory = join(input.root, 'personal-admin-ui'), admin = resolve(import.meta.dirname, '../admin-ui')
  await mkdir(directory, { recursive: true })
  const entry = join(directory, 'entry.ts'), cfg = testConfig(join(directory, 'primary'))
  await writeFile(entry, `import React from ${JSON.stringify(join(admin, 'node_modules/react/index.js'))};
import {createRoot} from ${JSON.stringify(join(admin, 'node_modules/react-dom/client.js'))};
import {PeerBackupSection} from ${JSON.stringify(join(admin, 'src/pages/PeerBackupSection.tsx'))};
import {LocalRecoveryExecutionSection} from ${JSON.stringify(join(admin, 'src/pages/LocalRecoveryExecutionSection.tsx'))};
import {PendingEditsProvider} from ${JSON.stringify(join(admin, 'src/pending-edits.tsx'))};
import ${JSON.stringify(join(admin, 'src/index.css'))};
createRoot(document.getElementById('root')).render(React.createElement(PendingEditsProvider,null,location.search.includes('local')?React.createElement(LocalRecoveryExecutionSection):React.createElement(PeerBackupSection,{nodes:window.fixtureNodes})));
`)
  await build({ configFile: false, root: admin, logLevel: 'error', define: { 'process.env.NODE_ENV': '"development"' }, build: {
    outDir: join(directory, 'assets'), emptyOutDir: true, minify: false,
    lib: { entry, formats: ['es'], fileName: () => 'fixture.js', cssFileName: 'fixture' },
  } })
  const assets = new Set(await readdir(join(directory, 'assets')))
  const configFile = join(directory, 'peer.json')
  await writeFile(configFile, JSON.stringify({ version: 1, directory: join(directory, 'repository'),
    stagingDirectory: join(directory, 'staging'), resticExecutable: process.execPath,
    capacityBytes: 1048576, maxExportBytes: 1048576, reserveBytes: 1, uploadKiBps: 1024, downloadKiBps: 1024,
    routes: [], pollMs: 60000 }), { mode: 0o600 })
  const resourceCalls: string[] = []
  const unavailable = (resource: string): never => {
    resourceCalls.push(resource)
    throw new Error('The primary review cannot access target ' + resource)
  }
  const gateway = await createPeerBackupGateway({ context: input.primary, configFile,
    recovery: { config: cfg, fileGate: new PeerProjectFileGate(cfg.stateRoot),
      volume: { readVolume: async () => unavailable('content'), writeVolume: async () => unavailable('content') },
      instances: { withStopped: async () => unavailable('Runtime') } } })
  let activeGateway = gateway, localGateway: typeof gateway | undefined
  const nodes = (await input.primary.pool.query<{ id: string }>('SELECT id FROM harness.compute_nodes WHERE organization_id=$1',
    [input.primary.organizationId])).rows.map(row => ({ nodeId: row.id,
    name: row.id === input.primary.nodeId ? 'Primary entry' : row.id === input.targetContext.nodeId ? 'Recovery computer' : 'Source computer',
    status: 'active', lastHeartbeatAt: null, heartbeatAgeMs: null, maintenanceAppliedEpoch: '1', inflightWrites: 0, activeRuntimes: 0, quiesced: false }))
  const cookie = 'fixture=' + randomUUID(), failures: unknown[] = [], requests: Array<{ method: string; path: string; status: number }> = []
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.cookie !== cookie) { res.writeHead(401).end(); return }
      const path = new URL(req.url!, 'http://fixture.test').pathname
      if (path.startsWith('/admin/api/peer-backups')) {
        res.once('finish', () => requests.push({ method: req.method!, path: path.replace(input.operationId, '[operation]')
          .replace(input.policyId, '[policy]'), status: res.statusCode }))
        if (!await activeGateway.admin(req, res, input.adminId)) res.writeHead(404).end()
      } else if (path === '/') {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" style="max-width:1000px;margin:16px auto;padding:12px"></main><script>window.fixtureNodes=${JSON.stringify(nodes)}</script><script type="module" src="/fixture.js"></script></body></html>`)
      } else if (assets.has(path.slice(1))) {
        res.setHeader('content-type', path.endsWith('.css') ? 'text/css' : 'application/javascript')
        res.end(await readFile(join(directory, 'assets', path.slice(1))))
      } else res.writeHead(404).end()
    })().catch((error: unknown) => { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end() })
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const artifactRoot = process.env.HGW_TEST_UI_ARTIFACTS, snapshots = resolve(import.meta.dirname, 'snapshots/peer-backup-personal')
  try {
    await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`, base = '/admin/api/peer-backups/personal-recoveries/' + input.operationId
    browser = await chromium.launch()
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'UTC' })
    await context.addCookies([{ name: 'fixture', value: cookie.slice('fixture='.length), url: origin }])
    await context.addInitScript(() => localStorage.setItem('coharness-admin-language', 'en'))
    const page = await context.newPage()
    page.on('pageerror', error => failures.push(error))
    page.setDefaultTimeout(10000)
    const capture = async (stage: string, local = false) => {
      const card = local ? page.locator('.peerBackupSection') : page.locator('.detailBlock').filter({ has: page.getByText('Personal Runtime disaster recovery', { exact: true }) }).last()
      for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
        await page.setViewportSize(viewport)
        const text = (await card.ariaSnapshot()).replace(/User \d+ · Runtime [a-f0-9]{8}/gu, 'User [id] · Runtime [id]') + '\n'
        const expected = join(snapshots, `${name}-${stage}.expected.md`)
        if (process.env.DSH_SNAPSHOT === 'refresh') { await mkdir(snapshots, { recursive: true }); await writeFile(expected, text) }
        expect(text).toBe(await readFile(expected, 'utf8'))
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        const clipped = await card.locator('button, summary').evaluateAll((elements, mobile) => elements.flatMap(element => {
          const r = element.getBoundingClientRect()
          return element.checkVisibility() && r.width > 0 && (r.left < 0 || r.right > innerWidth || mobile && r.height < 44 || element.scrollWidth > element.clientWidth + 1)
            ? [{ text: element.textContent, width: r.width, height: r.height, left: r.left, right: r.right,
              contentWidth: element.scrollWidth, clientWidth: element.clientWidth,
              visible: element.checkVisibility(), closedParent: !!element.parentElement?.parentElement?.closest('details:not([open])') }] : []
        }), name === 'mobile')
        if (artifactRoot) {
          await mkdir(artifactRoot, { recursive: true })
          await writeFile(join(artifactRoot, `personal-${name}-${stage}.aria.md`), text)
          await page.screenshot({ path: join(artifactRoot, `personal-${name}-${stage}.png`), fullPage: true })
        }
        expect(clipped).toEqual([])
      }
    }
    await page.goto(origin)
    await page.getByRole('button', { name: 'Recovery points and drills', exact: true }).click()
    await page.getByText('Validating personal data, documents and execution configuration on the target computer.', { exact: false }).waitFor()
    expect(await page.getByRole('button', { name: 'Record source isolation', exact: true }).count()).toBe(0)
    expect(await page.getByRole('combobox', { name: 'Recovery method', exact: true }).count()).toBe(0)
    await capture('preparing')
    await input.advance()
    await page.getByRole('button', { name: 'Refresh takeover status', exact: true }).click()
    await page.getByText('Suspended connection and environment settings (5)', { exact: true }).click()
    const prepared = await (await fetch(origin + base, { headers: { cookie } })).json() as { suspendedEnvironmentKeys: string[] }
    expect(prepared.suspendedEnvironmentKeys).toEqual(['DATABASE_URL', 'DSH_GATEWAY_CREDENTIAL_FD', 'HGW_DATABASE_URL', 'HGW_NODE_TOKEN', 'PGPASSWORD'])
    for (const key of prepared.suspendedEnvironmentKeys) await page.getByText(key, { exact: true }).waitFor()
    const visible = await page.locator('body').ariaSnapshot()
    for (const original of ['retired-database', 'retired-control', 'retired-node', 'retired-password']) {
      expect(JSON.stringify(prepared)).not.toContain(original)
      expect(visible).not.toContain(original)
    }
    await capture('prepared-settings')
    await page.getByRole('button', { name: 'Record source isolation', exact: true }).click()
    await page.getByRole('textbox', { name: /^Isolation evidence reference/u }).fill('fixture/personal-source-isolation')
    await page.keyboard.press('Tab')
    const physical = page.getByRole('checkbox', { name: 'I verified the source cannot continue tasks or external writes', exact: true })
    expect(await physical.evaluate(element => element === document.activeElement)).toBe(true)
    await physical.check()
    await page.getByRole('checkbox', { name: 'I accept the data gap after this point and will review task outcomes', exact: true }).check()
    const isolated = page.waitForResponse(response => response.url().endsWith('/confirm-isolation'))
    await page.getByRole('button', { name: 'Confirm isolation and prepare recovery', exact: true }).click()
    expect((await isolated).status()).toBe(200)
    await page.getByRole('button', { name: 'Review switch', exact: true }).click()
    const activating = page.waitForResponse(response => response.url().endsWith('/activate'))
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    expect((await activating).status()).toBe(202)
    await page.getByText('Switching ownership', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'Check restored execution configuration', exact: true }).count()).toBe(0)
    await capture('activating')
    await input.advance()
    await page.getByRole('button', { name: 'Refresh takeover status', exact: true }).click()
    await page.getByRole('button', { name: 'Check restored execution configuration', exact: true }).click()
    await page.getByText('Checking restored data and plugin configuration. Refresh later for the result.', { exact: true }).waitFor()
    await input.executionService.prepareNext(new AbortController().signal)
    await page.getByRole('button', { name: 'Refresh execution review', exact: true }).click()
    await page.getByRole('button', { name: 'Review new-conversation permission', exact: true }).click()
    await page.getByRole('checkbox', { name: 'I confirm only new conversations are enabled; previous work stays paused', exact: true }).check()
    const enabled = page.waitForResponse(response => response.url().endsWith('/execution/enable'))
    await page.getByRole('button', { name: 'Enable new conversations', exact: true }).click()
    expect((await enabled).status()).toBe(200)
    await page.getByText('New conversations are enabled; historical conversations remain read-only.', { exact: true }).waitFor()
    await capture('enabled')
    if (input.withLocalMode) {
      localGateway = await createPeerBackupGateway({ context: input.targetContext })
      await input.withLocalMode(async () => {
        activeGateway = localGateway!
        await page.goto(origin + '?local')
        await page.getByRole('heading', { name: 'Recovery execution reviews', exact: true }).waitFor()
        await page.getByText('New conversations are enabled; historical conversations remain read-only.', { exact: true }).waitFor()
        await page.getByText('Suspended connection and environment settings (5)', { exact: true }).click()
        await page.getByText('PGPASSWORD', { exact: true }).waitFor()
        expect(await page.getByRole('combobox', { name: 'Source computer', exact: true }).count()).toBe(0)
        await capture('local-enabled', true)
      })
      activeGateway = gateway
    }
    const status = await (await fetch(origin + base + '/execution', { headers: { cookie } })).json()
    expect(status).toMatchObject({ status: 'new-conversations-enabled', oldSessionCount: 2, tasksSuspended: true, sessionsReadOnly: true })
    expect(resourceCalls).toEqual([])
    expect(failures).toEqual([])
    if (artifactRoot) await writeFile(join(artifactRoot, 'personal-ui-http.json'), JSON.stringify(requests, null, 2))
    await context.close()
  } finally {
    await browser?.close()
    server.closeAllConnections()
    if (server.listening) await new Promise<void>(done => server.close(() => done()))
    await localGateway?.close()
    await gateway.close()
  }
}
