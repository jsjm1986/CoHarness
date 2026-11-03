/** Compiled Gateway archive identities in a real Admin browser; accepts explicit build and browser inputs. */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const [artifactInput, adminInput, browserModule, executable, record] = process.argv.slice(2)
assert.ok(artifactInput && adminInput && browserModule && executable, 'Provide Gateway lib, Admin build, Playwright module and browser executable')
assert.ok(record === undefined || record === '--record')
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(databaseUrl)
const { chromium } = await import(pathToFileURL(browserModule).href)
const browser = await chromium.launch({ headless: true, executablePath: executable })
const screenshots = process.env.DSH_ARCHIVE_BROWSER_SCREENSHOTS
if (screenshots !== undefined) await mkdir(screenshots, { recursive: true })
const expected = new URL('./expected/archive-runtime-namespace-browser.jsonl', import.meta.url), observations = []
async function deadline(operation, message) {
  let timer
  try { return await Promise.race([operation, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(message)), 30000); timer.unref() })]) }
  finally { clearTimeout(timer) }
}
try {
  for (const width of [1280, 390, 320]) {
    const root = await mkdtemp(join(tmpdir(), 'archive-browser-driver-'))
    const env = { ...process.env, HGW_TEST_DATABASE_URL: databaseUrl, DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), DSH_ARCHIVE_BROWSER_ROOT: resolve(adminInput) }
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'TSX_TSCONFIG_PATH', 'DSH_MANAGED_DATA_MANIFEST']) delete env[key]
    const child = fork(fileURLToPath(new URL('./fixtures/archive-runtime-namespace.mjs', import.meta.url)), ['lib', resolve(artifactInput)], { cwd: root, env, execArgv: [], silent: true })
    let stderr = '', stdout = '', context, primaryError, spawnError
    child.stderr.on('data', data => { stderr += data }); child.stdout.on('data', data => { stdout += data })
    child.once('error', error => { spawnError = error })
    const exited = new Promise(done => child.once('close', (code, signal) => done({ code, signal })))
    let ready, releaseReady
    const readiness = new Promise(done => { releaseReady = done })
    child.on('message', message => { if (message.kind === 'ready') { ready = message; releaseReady() } })
    try {
      await deadline(Promise.race([readiness, exited.then(result => { throw new Error('Archive fixture exited before readiness: '+JSON.stringify(result)+' '+stderr+' '+(spawnError?.message ?? '')) })]), 'Archive browser readiness deadline')
      context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN' })
      const equal = ready.cookie.indexOf('=')
      await context.addCookies([{ name: ready.cookie.slice(0, equal), value: ready.cookie.slice(equal+1), url: ready.origin }, { name: 'hgw_lang', value: 'zh', url: ready.origin }])
      const page = await context.newPage(), pageErrors = []
      page.on('pageerror', error => { pageErrors.push(error.message) })
      await page.goto(ready.origin+'/admin/archives', { waitUntil: 'domcontentloaded' })
      await page.getByRole('checkbox', { name: '选择 same-host-copy', exact: true }).waitFor()
      const listGeometry = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }))
      assert.ok(listGeometry.scroll <= listGeometry.viewport, JSON.stringify(listGeometry))
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, `archive-list-${width}.png`), fullPage: true })
      const surface = width > 840 ? page.locator('.desktopOnly') : page.locator('.mobileList')
      assert.equal(await surface.getByText(ready.hostId, { exact: true }).count(), 2)
      await page.getByRole('checkbox', { name: '选择 same-host-copy', exact: true }).check()
      assert.equal(await page.getByRole('checkbox', { name: '选择 computer-a', exact: true }).isChecked(), false)
      await page.getByText('已选择 1 条', { exact: true }).waitFor()
      const actionResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/admin/api/archives/records/actions')
      await page.getByRole('button', { name: '删除所选', exact: true }).click()
      await page.getByRole('dialog', { name: '删除所选对话？' }).getByRole('button', { name: '删除', exact: true }).click()
      const result = await (await actionResponse).json()
      assert.deepEqual(result.results, [{ archiveId: ready.siblingId, ok: true }])
      const first = await context.request.get(`${ready.origin}/admin/api/archives/records/${ready.archiveId}/status`)
      assert.equal(first.status(), 200); assert.equal((await first.json()).state, 'archived')
      const second = await context.request.get(`${ready.origin}/admin/api/archives/records/${ready.siblingId}/status`)
      assert.equal(second.status(), 200); assert.equal((await second.json()).state, 'trash')
      await page.getByRole('button', { name: '查看 computer-a', exact: true }).click()
      await page.getByRole('dialog', { name: 'Archive computer-a', exact: true }).waitFor()
      await page.getByText('Private computer-a', { exact: true }).waitFor()
      const exportPath = await page.getByRole('link', { name: '导出' }).getAttribute('href')
      assert.ok(exportPath.includes(`/records/${ready.archiveId}/export`))
      const exported = await context.request.get(new URL(exportPath, ready.origin).href)
      assert.equal((await exported.json()).record.archiveId, ready.archiveId)
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }))
      assert.ok(geometry.scroll <= geometry.viewport, JSON.stringify(geometry))
      assert.deepEqual(pageErrors, [])
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, `archive-runtime-${width}.png`), fullPage: true })
      await page.getByRole('dialog', { name: 'Archive computer-a', exact: true }).getByRole('button', { name: /关闭/ }).click()
      await page.getByRole('button', { name: '清理空白草稿', exact: true }).click()
      const firstDraft = page.getByRole('checkbox', { name: `选择 ${ready.browserDraft} (${ready.firstDraftRuntime})`, exact: true })
      const secondDraft = page.getByRole('checkbox', { name: `选择 ${ready.browserDraft} (${ready.secondDraftRuntime})`, exact: true })
      await secondDraft.waitFor(); assert.equal(await firstDraft.isChecked(), false)
      await secondDraft.check(); assert.equal(await firstDraft.isChecked(), false)
      const maintenanceResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/admin/api/archives/empty-drafts/trash')
      await page.getByRole('button', { name: '删除选中 1 项', exact: true }).click()
      await page.getByRole('dialog', { name: '删除所选空白草稿？', exact: true }).getByRole('button', { name: '删除', exact: true }).click()
      const maintenance = await maintenanceResponse
      const input = maintenance.request().postDataJSON()
      const selectedDraft = { rootSessionId: ready.browserDraft, runtimeId: ready.secondDraftRuntime }
      assert.deepEqual(input.sessions, [selectedDraft]); assert.ok(Number.isSafeInteger(input.cutoff))
      assert.deepEqual(await maintenance.json(), { trashed: [selectedDraft] })
      await secondDraft.waitFor({ state: 'detached' }); await firstDraft.waitFor(); assert.equal(await secondDraft.count(), 0)
      const draftGeometry = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }))
      assert.ok(draftGeometry.scroll <= draftGeometry.viewport, JSON.stringify(draftGeometry))
      assert.deepEqual(pageErrors, [])
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, `archive-draft-runtime-${width}.png`), fullPage: true })
      observations.push({ width, sameHostRows: 2, selectedArchives: 1, affectedArchives: 1, otherArchiveRetained: true, originalHostId: true, owningRuntimeExport: true, sameHostDrafts: 2, selectedDraftRuntime: 'second', affectedDrafts: 1, otherDraftRetained: true, horizontalOverflow: false, pageErrors })
    } catch (error) { primaryError = error; throw error }
    finally {
      const failures = [], close = async operation => { try { await operation() } catch (error) { failures.push(error) } }
      await close(async () => { await context?.close() })
      if (child.connected) child.send('finish')
      await close(async () => { const result = await deadline(exited, 'Archive browser teardown deadline'); assert.equal(result.signal, null); assert.equal(result.code, 0, stderr+' '+stdout) })
      await close(() => rm(root, { recursive: true, force: true }))
      // oxlint-disable-next-line no-unsafe-finally -- Preserve browser failures together with fixture teardown failures.
      if (failures.length > 0) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], 'Archive browser cleanup failed')
    }
  }
} finally { await browser.close() }
const actual = observations.map(row => JSON.stringify(row)).join('\n')+'\n'
if (record === '--record') await writeFile(expected, actual)
else assert.equal(actual, await readFile(expected, 'utf8'))
process.stdout.write(actual)
