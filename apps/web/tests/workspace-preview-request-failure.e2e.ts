/** Real HTTP failures preserve an authorized Markdown body without an automatic retry or an extra doomed read. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const EXPECTED = new URL('./expected/workspace-preview-request-failure/', import.meta.url)
const MODE = webSnapshotMode()
let scaffold: WebScaffold | undefined
let browser: Browser | undefined
let page: Page | undefined

afterEach(async () => {
  const failures: unknown[] = []
  await page?.unrouteAll({ behavior: 'wait' }).catch((error: unknown) => failures.push(error))
  await browser?.close().catch((error: unknown) => failures.push(error))
  browser = undefined
  page = undefined
  await scaffold?.close().catch((error: unknown) => failures.push(error))
  scaffold = undefined
  if (failures.length > 0) throw new AggregateError(failures, 'Preview request-failure fixture teardown failed')
})

it.skipIf(MODE === 'record').each([
  { name: 'en', locale: 'en-US', width: 1280, height: 900, reload: 'Reload',
    failed: 'Reload · connection failed', retained: 'Could not update the preview. The previous content is still shown. Check the connection and reload.',
    empty: 'Could not load the preview. Check the connection and reload.', close: 'Close preview' },
  { name: 'zh', locale: 'zh-CN', width: 390, height: 844, reload: '重新加载',
    failed: '重新加载 · 连接异常', retained: '未能更新预览，仍显示上次内容；请检查连接后重新加载',
    empty: '未能加载预览，请检查连接后重新加载', close: '关闭预览' },
])('keeps the previous document and offers explicit retry after a $name request failure', async (viewport) => {
  scaffold = await launchWebScaffold({ workbench: true, remoteAuthority: 'app.localhost' })
  const host = scaffold
  await writeFile(join(host.workspaceCwd, 'continuity.md'), '# Previous document\n\nAuthorized preview.\n')
  await writeFile(join(host.workspaceCwd, 'unopened.md'), '# Another document\n')
  const seed = (await readFile(SEED, 'utf8')).replace('"text":"DONE"',
    '"text":"[Open document](continuity.md) [Open another](unopened.md)"')
  const sessionId = await seedSession(host, seed, `preview-request-failure-${viewport.name}`)
  const workspace = await host.ctx.workspaceRegistry.create(host.workspaceCwd)
  await workspace.attachSession(sessionId)
  browser = await chromium.launch()
  page = await browser.newPage({ locale: viewport.locale, viewport: { width: viewport.width, height: viewport.height } })
  const target = page
  const tripwire = watchConsole(target)
  onTestFailed(() => saveFailureShot(target, `workspace-preview-request-failure-${viewport.name}`))
  let blocked: 'stat' | 'read' | undefined
  let denied = false
  let contentReads = 0
  await target.route(/\/api\/workspaceFiles\.(?:stat|read)(?:\?.*)?$/u, async (route) => {
    const method = new URL(route.request().url()).pathname.endsWith('.stat') ? 'stat' : 'read'
    if (method === 'read') contentReads += 1
    if (method === 'stat' && denied) await route.fulfill({ status: 403, body: 'Forbidden' })
    else if (method === blocked) await route.abort('internetdisconnected')
    else await route.continue()
  })
  await target.addInitScript((id) => {
    if (window === window.top) localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
  }, sessionId)
  await target.goto(host.authenticatedUrl, { waitUntil: 'load' })
  await target.getByRole('button', { name: 'Open document', exact: true }).click()
  const preview = target.getByRole('region', { name: 'continuity.md', exact: true })
  const heading = preview.getByRole('heading', { name: 'Previous document', exact: true })
  await heading.waitFor()
  const reload = preview.getByRole('button', { name: viewport.reload, exact: true })
  const alert = preview.locator(':scope > [role="alert"]')
  const body = preview.locator('[data-workspace-markdown]')
  const original = { body: await body.boundingBox(), reload: await reload.boundingBox() }
  const initialReads = contentReads
  expect(initialReads).toBe(1)
  blocked = 'stat'
  await reload.click()
  await expect.poll(() => alert.textContent()).toBe(viewport.retained)
  expect(await body.boundingBox()).toEqual(original.body)
  expect(await reload.boundingBox()).toEqual(original.reload)
  expect(await reload.innerText()).toBe(viewport.failed)
  expect(await reload.getAttribute('data-workspace-preview-reconnecting')).toBeNull()
  expect(contentReads).toBe(initialReads)
  await compareOrRefreshGolden(fileURLToPath(new URL(`${viewport.name}-retained.expected.md`, EXPECTED)), [
    await captureStableAria(target, '[data-workspace-preview-request-failed]', host.workspaceCwd),
    await captureStableAria(target, 'section[aria-label="continuity.md"] > [role="alert"]', host.workspaceCwd),
    await captureStableAria(target, '[data-workspace-markdown]', host.workspaceCwd),
  ].join('\n'), MODE)
  blocked = undefined
  await reload.click()
  await expect.poll(() => contentReads).toBe(initialReads + 1)
  await alert.waitFor({ state: 'hidden' })
  await expect.poll(() => reload.isEnabled()).toBe(true)
  blocked = 'read'
  await reload.click()
  await expect.poll(() => alert.textContent()).toBe(viewport.retained)
  await heading.waitFor()
  expect(await body.boundingBox()).toEqual(original.body)
  expect(contentReads).toBe(initialReads + 2)
  blocked = undefined
  await reload.click()
  await expect.poll(() => contentReads).toBe(initialReads + 3)
  await alert.waitFor({ state: 'hidden' })
  await expect.poll(() => reload.isEnabled()).toBe(true)
  await preview.getByRole('button', { name: viewport.close, exact: true }).click()
  blocked = 'read'
  await target.getByRole('button', { name: 'Open another', exact: true }).click()
  const unopened = target.getByRole('region', { name: 'unopened.md', exact: true })
  await expect.poll(() => unopened.getByRole('alert').textContent()).toBe(viewport.empty)
  expect(await unopened.getByRole('heading').count()).toBe(0)
  await compareOrRefreshGolden(fileURLToPath(new URL(`${viewport.name}-empty.expected.md`, EXPECTED)),
    await captureStableAria(target, 'section[aria-label="unopened.md"]', host.workspaceCwd), MODE)
  blocked = undefined
  await unopened.getByRole('button', { name: viewport.reload, exact: true }).click()
  await unopened.getByRole('heading', { name: 'Another document', exact: true }).waitFor()
  const readsBeforeDenial = contentReads
  denied = true
  await unopened.getByRole('button', { name: viewport.reload, exact: true }).click()
  await expect.poll(() => unopened.getByRole('alert').textContent()).toContain('HTTP 403')
  expect(await unopened.getByRole('heading').count()).toBe(0)
  expect(await unopened.getByRole('button', { name: viewport.reload, exact: true }).isEnabled()).toBe(false)
  expect(contentReads).toBe(readsBeforeDenial)
  expect(tripwire.warnings).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
})
