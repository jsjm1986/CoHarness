/** Browser review of a real restored project's node-produced execution policy. */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import type { PeerRecoveryExecution } from '../src/peer-backup-execution.ts'
import { createPeerBackupGateway } from '../src/peer-backup-gateway.ts'

/** Exercise desktop and mobile approval without starting or stopping the restored Runtime.
 * @param input - actual published restore, primary authority and target preparation worker.
 * @returns after both browsers enable new conversations against the current review revision.
 */
export async function exerciseRecoveryExecutionUi(input: {
  primary: PostgresRuntimeContext; targetContext: PostgresRuntimeContext; targetService: PeerRecoveryExecution
  operationId: string; adminId: number; root: string
  withLocalMode: (exercise: () => Promise<void>) => Promise<void>
}): Promise<void> {
  const [{ chromium }, { build }] = await Promise.all([import('../../apps/web/tests/peer-backup-browser.ts'), import('vite')])
  const directory = join(input.root, 'execution-ui'), admin = resolve(import.meta.dirname, '../admin-ui')
  await mkdir(directory, { recursive: true })
  const entry = join(directory, 'entry.ts')
  await writeFile(entry, `import React from ${JSON.stringify(join(admin, 'node_modules/react/index.js'))};
import {createRoot} from ${JSON.stringify(join(admin, 'node_modules/react-dom/client.js'))};
import {PeerRecoveryExecution,recoveryExecutionMessage} from ${JSON.stringify(join(admin, 'src/pages/PeerRecoveryExecution.tsx'))};
import {LocalRecoveryExecutionSection} from ${JSON.stringify(join(admin, 'src/pages/LocalRecoveryExecutionSection.tsx'))};
import {Section} from ${JSON.stringify(join(admin, 'src/components/ui.tsx'))};
import {PendingEditsProvider} from ${JSON.stringify(join(admin, 'src/pending-edits.tsx'))};
import {translateCopy} from ${JSON.stringify(join(admin, 'src/language.ts'))};
import {en,zh} from ${JSON.stringify(join(admin, 'src/pages/peer-backup.copy.ts'))};
import ${JSON.stringify(join(admin, 'src/index.css'))};
const t=translateCopy('en',{en,zh});
const request=async(path,method='GET',body,signal)=>{const response=await fetch('/admin/api/peer-backups'+path,{method,signal,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();if(!response.ok)throw Error(data.error);return data};
const message=code=>recoveryExecutionMessage(code,t)??code;
createRoot(document.getElementById('root')).render(React.createElement(PendingEditsProvider,null,location.search.includes('local')?React.createElement(LocalRecoveryExecutionSection):React.createElement(Section,{className:'peerBackupSection'},React.createElement(PeerRecoveryExecution,{operationId:${JSON.stringify(input.operationId)},request,t,message}))));
`)
  await build({ configFile: false, root: admin, logLevel: 'error', define: { 'process.env.NODE_ENV': '"development"' }, build: {
    outDir: join(directory, 'assets'), emptyOutDir: true, minify: false,
    lib: { entry, formats: ['es'], fileName: () => 'fixture.js', cssFileName: 'fixture' },
  } })
  const assets = new Set(await readdir(join(directory, 'assets')))
  const gateway = await createPeerBackupGateway({ context: input.primary })
  let activeGateway = gateway
  let localGateway: typeof gateway | undefined
  const cookie = 'fixture=' + randomUUID(), failures: unknown[] = []
  const requests: Array<{ method: string; path: string; status: number }> = []
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.cookie !== cookie) { res.writeHead(401).end(); return }
      const path = new URL(req.url!, 'http://fixture.test').pathname
      if (path.startsWith('/admin/api/peer-backups/')) {
        res.once('finish', () => requests.push({ method: req.method!, path: path.replace(input.operationId, '[operation]'), status: res.statusCode }))
        if (!await activeGateway.admin(req, res, input.adminId)) res.writeHead(404).end()
      } else if (path === '/') {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" style="max-width:1000px;margin:16px auto;padding:12px"></main><script type="module" src="/fixture.js"></script></body></html>')
      } else if (assets.has(path.slice(1))) {
        res.setHeader('content-type', path.endsWith('.css') ? 'text/css' : 'application/javascript')
        res.end(await readFile(join(directory, 'assets', path.slice(1))))
      } else res.writeHead(404).end()
    })().catch((error: unknown) => { failures.push(error); res.writeHead(500).end() })
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const artifactRoot = process.env.HGW_TEST_UI_ARTIFACTS
  const goldenRoot = resolve(import.meta.dirname, 'snapshots/peer-backup-execution')
  try {
    await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch()
    for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
      const context = await browser.newContext({ viewport, locale: 'en-US', timezoneId: 'UTC',
        hasTouch: name === 'mobile', isMobile: name === 'mobile' })
      await context.addCookies([{ name: 'fixture', value: cookie.slice('fixture='.length), url: origin }])
      const page = await context.newPage()
      page.on('pageerror', error => failures.push(error))
      page.setDefaultTimeout(10000)
      const capture = async (stage: string) => {
        const transcript = await page.locator('body').ariaSnapshot() + '\n'
        const file = join(goldenRoot, `${name}-${stage}.expected.md`)
        if (process.env.DSH_SNAPSHOT === 'refresh') { await mkdir(goldenRoot, { recursive: true }); await writeFile(file, transcript) }
        expect(transcript).toBe(await readFile(file, 'utf8'))
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        expect(await page.locator('button, summary').evaluateAll((buttons, mobile) => buttons.filter(button => {
          const r = button.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) return false
          return r.left < 0 || r.right > innerWidth || mobile && r.height < 44 || button.scrollWidth > button.clientWidth + 1
        }).map(button => button.textContent), name === 'mobile')).toEqual([])
        if (artifactRoot) {
          await mkdir(artifactRoot, { recursive: true })
          await writeFile(join(artifactRoot, `execution-${name}-${stage}.aria.md`), transcript)
          await page.screenshot({ path: join(artifactRoot, `execution-${name}-${stage}.png`), fullPage: true })
        }
      }
      try {
        await page.goto(origin)
        const prepare = page.getByRole('button', { name: /^(?:Check restored execution configuration|Recheck execution configuration)$/u })
        await prepare.click()
        await page.getByText('Checking restored data and plugin configuration. Refresh later for the result.', { exact: true }).waitFor()
        await input.targetService.prepareNext(new AbortController().signal)
        const prepared = await (await fetch(origin + '/admin/api/peer-backups/recoveries/' + input.operationId + '/execution', {
          headers: { cookie },
        })).json() as { preparationStatus: string; blockers: string[]; suspendedEnvironmentKeys: string[]; items: Array<{ name: string; status: string; reason?: string }> }
        if (prepared.blockers.length) console.info('Recovery inspection blockers', { blockers: prepared.blockers,
          items: prepared.items.filter(item => /api-remotes|schedule|model-governance|directory-guard/u.test(item.name)).map(({ name, status, reason }) => ({ name, status, reason })) })
        expect(prepared).toMatchObject({ preparationStatus: 'ready', blockers: [] })
        expect(prepared.suspendedEnvironmentKeys).toEqual(['DATABASE_URL', 'DSH_GATEWAY_CREDENTIAL_FD', 'HGW_NODE_TOKEN', 'PGHOST', 'PGPASSWORD'])
        expect(JSON.stringify(prepared)).not.toContain('retired-')
        await page.getByRole('button', { name: 'Refresh execution review', exact: true }).click()
        await page.getByText('Suspended connection and environment settings (5)', { exact: true }).click()
        for (const key of prepared.suspendedEnvironmentKeys) await page.getByText(key, { exact: true }).waitFor()
        await page.getByRole('button', { name: 'Review new-conversation permission', exact: true }).click()
        await page.getByRole('checkbox', { name: 'I confirm only new conversations are enabled; previous work stays paused', exact: true }).check()
        // A second administrator requests a new node inspection while this form retains its original revision.
        const changed = await fetch(origin + '/admin/api/peer-backups/recoveries/' + input.operationId + '/execution/prepare', {
          method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: input.operationId }),
        })
        expect(changed.status).toBe(202)
        await input.targetService.prepareNext(new AbortController().signal)
        const rejected = page.waitForResponse(response => response.url().endsWith('/execution/enable'))
        await page.getByRole('button', { name: 'Enable new conversations', exact: true }).click()
        expect((await rejected).status()).toBe(409)
        await page.getByRole('alert').waitFor()
        await capture('stale-review')
        await page.getByRole('button', { name: 'Refresh execution review', exact: true }).click()
        await expect.poll(() => page.getByRole('button', { name: 'Enable new conversations', exact: true }).isEnabled()).toBe(false)
        await page.getByRole('button', { name: 'Back', exact: true }).click()
        await page.getByRole('button', { name: 'Review new-conversation permission', exact: true }).click()
        await page.getByRole('checkbox', { name: 'I confirm only new conversations are enabled; previous work stays paused', exact: true }).check()
        const accepted = page.waitForResponse(response => response.url().endsWith('/execution/enable'))
        await page.getByRole('button', { name: 'Enable new conversations', exact: true }).click()
        expect((await accepted).status()).toBe(200)
        await page.getByText('New conversations are enabled; historical conversations remain read-only.', { exact: true }).waitFor()
        const state = await (await fetch(origin + '/admin/api/peer-backups/recoveries/' + input.operationId + '/execution', {
          headers: { cookie },
        })).json() as { items: Array<{ id: string; name: string; status: string }> }
        const eligible = state.items.find(item => item.status === 'eligible')
        if (name === 'desktop') expect(eligible).toBeDefined()
        if (eligible) {
          await page.getByRole('button', { name: 'Review ' + eligible.name, exact: true }).click()
          await page.getByRole('textbox', { name: /^Review evidence reference/u }).fill('fixture-review/config-and-external-effects')
          await page.getByRole('checkbox', { name: 'I checked this item’s configuration and external effects', exact: true }).check()
          const approval = page.waitForResponse(response => response.url().includes('/items/') && response.url().endsWith('/approve'))
          await page.getByRole('button', { name: 'Approve this item', exact: true }).click()
          expect((await approval).status()).toBe(202)
          await input.targetService.prepareNext(new AbortController().signal)
          await page.getByRole('button', { name: 'Refresh execution review', exact: true }).click()
          await page.getByText(/^Approved or configured inactive components/u).waitFor()
          const reviewed = await (await fetch(origin + '/admin/api/peer-backups/recoveries/' + input.operationId + '/execution', {
            headers: { cookie },
          })).json() as { items: Array<{ id: string; status: string }> }
          expect(reviewed.items.find(item => item.id === eligible.id)?.status).toBe('approved')
          await page.getByRole('button', { name: 'Review new-conversation permission', exact: true }).click()
          await page.getByRole('checkbox', { name: 'I confirm only new conversations are enabled; previous work stays paused', exact: true }).check()
          await page.getByRole('button', { name: 'Enable new conversations', exact: true }).click()
          await page.getByText('New conversations are enabled; historical conversations remain read-only.', { exact: true }).waitFor()
        }
        await capture('enabled')
      } catch (error) {
        if (artifactRoot) {
          await mkdir(artifactRoot, { recursive: true })
          await writeFile(join(artifactRoot, `execution-${name}-failed.aria.md`), await page.locator('body').ariaSnapshot())
          await page.screenshot({ path: join(artifactRoot, `execution-${name}-failed.png`), fullPage: true })
        }
        throw error
      } finally { await context.close() }
    }
    localGateway = await createPeerBackupGateway({ context: input.targetContext })
    await input.withLocalMode(async () => {
      activeGateway = localGateway!
      const context = await browser!.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US', timezoneId: 'UTC', isMobile: true, hasTouch: true })
      await context.addInitScript(() => localStorage.setItem('coharness-admin-language', 'en'))
      await context.addCookies([{ name: 'fixture', value: cookie.slice('fixture='.length), url: origin }])
      const page = await context.newPage()
      page.on('pageerror', error => failures.push(error))
      try {
        await page.goto(origin + '?local')
        await page.getByRole('heading', { name: 'Recovery execution reviews', exact: true }).waitFor()
        expect(await page.getByRole('button', { name: 'Prepare replacement', exact: true }).count()).toBe(0)
        expect(await page.getByRole('combobox', { name: 'Source computer', exact: true }).count()).toBe(0)
        await page.getByRole('button', { name: 'Recheck execution configuration', exact: true }).click()
        await page.getByText('Checking restored data and plugin configuration. Refresh later for the result.', { exact: true }).waitFor()
        await input.targetService.prepareNext(new AbortController().signal)
        await page.getByRole('button', { name: 'Refresh execution review', exact: true }).click()
        await page.getByRole('button', { name: 'Review new-conversation permission', exact: true }).click()
        await page.getByRole('checkbox', { name: 'I confirm only new conversations are enabled; previous work stays paused', exact: true }).check()
        const response = page.waitForResponse(result => result.url().endsWith('/execution/enable'))
        await page.getByRole('button', { name: 'Enable new conversations', exact: true }).click()
        expect((await response).status()).toBe(200)
        await page.getByText('New conversations are enabled; historical conversations remain read-only.', { exact: true }).waitFor()
        await page.getByText('Suspended connection and environment settings (5)', { exact: true }).click()
        await page.getByText('PGPASSWORD', { exact: true }).waitFor()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        const transcript = (await page.locator('body').ariaSnapshot()).replace(/Project \d+/gu, 'Project [id]') + '\n'
        const file = join(goldenRoot, 'local-enabled.expected.md')
        if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(file, transcript)
        expect(transcript).toBe(await readFile(file, 'utf8'))
        if (artifactRoot) {
          await writeFile(join(artifactRoot, 'execution-local-enabled.aria.md'), transcript)
          await page.screenshot({ path: join(artifactRoot, 'execution-local-enabled.png'), fullPage: true })
        }
      } finally { await context.close(); activeGateway = gateway }
    })
    expect(failures).toEqual([])
    expect(requests.filter(request => request.path.endsWith('/enable') && request.status === 409)).toHaveLength(2)
    expect(requests.filter(request => request.path.endsWith('/enable') && request.status === 200).length).toBeGreaterThanOrEqual(3)
    expect(requests.some(request => request.path.endsWith('/approve') && request.status === 202)).toBe(true)
    if (artifactRoot) await writeFile(join(artifactRoot, 'execution-http.json'), JSON.stringify(requests, null, 2) + '\n')
  } finally {
    await browser?.close()
    if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()))
    await gateway.close()
    await localGateway?.close()
  }
}
