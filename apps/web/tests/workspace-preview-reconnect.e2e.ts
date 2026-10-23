/** A retained read-only CSV keeps its cell geometry through its pooled project transport's outage. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type WebSocketRoute } from 'playwright'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const EXPECTED = new URL('./expected/workspace-preview-reconnect/', import.meta.url)
const MODE = webSnapshotMode()
let scaffold: WebScaffold | undefined
let browser: Browser | undefined
let page: Page | undefined
let releaseConnection: (() => void) | undefined

afterEach(async () => {
  releaseConnection?.()
  releaseConnection = undefined
  const failures: unknown[] = []
  await page?.unrouteAll({ behavior: 'wait' }).catch((error: unknown) => failures.push(error))
  await browser?.close().catch((error: unknown) => failures.push(error))
  browser = undefined
  page = undefined
  await scaffold?.close().catch((error: unknown) => failures.push(error))
  scaffold = undefined
  if (failures.length > 0) throw new AggregateError(failures, 'Preview reconnect fixture teardown failed')
})

it.skipIf(MODE === 'record').each([
  { name: 'desktop', width: 1280, height: 900, locale: 'en-US' },
  { name: 'narrow', width: 390, height: 844, locale: 'en-US' },
  { name: 'narrow-zh', width: 390, height: 844, locale: 'zh-CN' },
])('keeps CSV cells, selection, scrolling and resource retry stable during a $name outage', async (viewport) => {
  const chinese = viewport.locale === 'zh-CN'
  const labels = chinese
    ? { select: '选择工作台', workbench: '我的工作台', add: '添加对话', reload: '重新加载', close: '关闭预览', reconnecting: '重新加载 · 重连中' }
    : { select: 'Select workbench', workbench: 'My workbench', add: 'Add conversation', reload: 'Reload', close: 'Close preview', reconnecting: 'Reload · reconnecting' }
  scaffold = await launchWebScaffold({ workbench: true })
  const csv = Array.from({ length: 80 }, (_row, row) =>
    Array.from({ length: 8 }, (_column, column) => `R${String(row + 1)}C${String(column + 1)}`).join(',')).join('\n')
  await writeFile(join(scaffold.workspaceCwd, 'continuity.csv'), csv)
  await writeFile(join(scaffold.workspaceCwd, 'readiness.md'), 'Ready after reconnect')
  const source = (await readFile(SEED, 'utf8')).replace('"text":"DONE"', '"text":"[Open CSV](continuity.csv) [Open readiness](readiness.md)"')
  const sessionId = await seedSession(scaffold, source, `preview-reconnect-${viewport.name}`)
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  await workspace.attachSession(sessionId)
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, locale: viewport.locale })
  const target = page
  const host = scaffold
  onTestFailed(() => saveFailureShot(target, `workspace-preview-reconnect-${viewport.name}`))
  const tripwire = watchConsole(target)
  let recovery: PromiseWithResolvers<undefined> | undefined
  let retryRequested = Promise.withResolvers<undefined>()
  let heldDescribe = 0
  await target.route(/\/api\/host\.describe(?:\?.*)?$/u, async (route) => {
    const pooled = new URL(route.request().url()).searchParams.get('dshTarget') === 'project:7'
    const pending = pooled ? recovery : undefined
    if (pending !== undefined) {
      heldDescribe += 1
      retryRequested.resolve(undefined)
      await pending.promise
    }
    const response = await route.fetch()
    const body = await response.json() as { result: { ok: boolean; value?: { runtimeTarget?: unknown } } }
    expect(body.result.ok).toBe(true)
    if (body.result.value !== undefined) body.result.value.runtimeTarget = pooled ? { kind: 'project', projectId: 7 } : { kind: 'personal' }
    await route.fulfill({ response, json: body })
  })
  // The standalone Host supplies two real transports; only their Gateway runtime aliases and directory are synthetic.
  await target.route(/\/account\/api\/workbench\/catalog(?:\?.*)?$/u, async (route) => {
    await route.fulfill({ json: {
      personalComplete: true, personal: { id: 1, name: 'Fixture' }, activeRuntime: { kind: 'personal' },
      projects: [{ projectId: 7, name: 'Continuity project', mode: 'rw' }],
      items: [{ sessionId, runtime: { kind: 'project', projectId: 7, projectName: 'Continuity project' },
        visibility: 'project', title: 'Continuity CSV', creatorUserId: 1, creatorDisplayName: 'Fixture',
        updatedAt: 1, blank: false, canWrite: true }],
    } })
  })
  let socket: { client: WebSocketRoute; server: WebSocketRoute } | undefined
  let hostSocketOpens = 0
  await target.routeWebSocket(/\/api\/events\.host(?:\?|$)/u, (client) => {
    if (new URL(client.url()).searchParams.get('dshTarget') !== 'project:7') { client.connectToServer(); return }
    hostSocketOpens += 1
    socket = { client, server: client.connectToServer() }
  })
  let byteReads = 0
  const byteReadTargets: (string | null)[] = []
  target.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.endsWith('/workspaceFiles.readBytes')) { byteReads += 1; byteReadTargets.push(url.searchParams.get('dshTarget')) }
  })
  await target.addInitScript((id) => {
    if (window === window.top) localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
  }, sessionId)
  await target.goto(host.authenticatedUrl, { waitUntil: 'load' })
  const toolbar = target.locator('[data-workbench-toolbar]')
  await toolbar.getByRole('button', { name: labels.select, exact: true }).click()
  await target.getByRole('menuitem').filter({ hasText: labels.workbench }).click()
  await toolbar.getByRole('button', { name: labels.add, exact: true }).click()
  const picker = target.getByRole('dialog', { name: labels.add, exact: true })
  await picker.getByRole('button', { name: 'Continuity CSV', exact: true }).click()
  await picker.waitFor({ state: 'hidden' })
  await target.getByRole('button', { name: 'Open CSV', exact: true }).click()
  const preview = target.getByRole('region', { name: 'continuity.csv', exact: true })
  const sheet = preview.locator('[data-excel-preview]')
  await sheet.waitFor()
  const selectedAddress = sheet.locator('.fortune-name-box')
  const formula = sheet.locator('#luckysheet-functionbox-cell')
  await expect.poll(() => formula.textContent()).toBe('R1C1')
  expect(await selectedAddress.textContent()).toBe('A1')
  await sheet.locator('.fortune-cell-area').click({ position: { x: 10, y: 10 } })
  const selection = sheet.locator('.luckysheet-cell-selected')
  await expect.poll(async () => {
    const bounds = await selection.boundingBox()
    return bounds !== null && bounds.width > 2 && bounds.height > 2
  }).toBe(true)
  const a1 = await selection.boundingBox()
  if (a1 === null || a1.width <= 0 || a1.height <= 0) throw new Error('Initial CSV cell has no layout')
  const c2 = { x: a1.x + a1.width * 2.5, y: a1.y + a1.height * 1.5 }
  await target.mouse.click(c2.x, c2.y)
  await expect.poll(() => selectedAddress.textContent()).toBe('C2')
  await expect.poll(() => formula.textContent()).toBe('R2C3')
  await target.mouse.click(a1.x + a1.width / 2, a1.y + a1.height / 2)
  await expect.poll(() => selectedAddress.textContent()).toBe('A1')
  const reload = preview.getByRole('button', { name: labels.reload, exact: true })
  const scroll = sheet.locator('.luckysheet-scrollbar-y')
  const alert = preview.locator(':scope > [role="alert"]')
  const before = {
    body: await sheet.boundingBox(), reload: await reload.boundingBox(), scroll: await scroll.evaluate(node => node.scrollTop),
  }
  expect(byteReads).toBe(1)
  expect(byteReadTargets).toEqual(['project:7'])
  await reload.focus()
  let warningStart = tripwire.warnings.length
  const disconnect = async (outageAlert = alert): Promise<void> => {
    const established = socket
    if (established === undefined) throw new Error('Host stream was not established')
    recovery = Promise.withResolvers<undefined>()
    retryRequested = Promise.withResolvers<undefined>()
    releaseConnection = () => { recovery?.resolve(undefined) }
    await established.client.close({ code: 1012, reason: 'Fixture workspace outage' })
    await established.server.close({ code: 1012, reason: 'Fixture workspace outage' })
    await outageAlert.waitFor().catch(async (error: unknown) => {
      console.info('[preview-continuity-outage-failure]', JSON.stringify({
        viewport, previewCount: await preview.count(), alerts: await target.getByRole('alert').allTextContents(),
        heldDescribe, hostSocketOpens, warnings: tripwire.warnings, errors: tripwire.pageErrors,
      }))
      await saveFailureShot(target, `workspace-preview-reconnect-${viewport.name}`)
      throw error
    })
    expect(await outageAlert.textContent()).toBe('Workspace connection is reconnecting')
    await retryRequested.promise
  }
  const recover = async (outageAlert = alert): Promise<void> => {
    const pending = recovery
    recovery = undefined
    releaseConnection = undefined
    pending?.resolve(undefined)
    await outageAlert.waitFor({ state: 'hidden' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(tripwire.warnings).toEqual([])
  }
  await disconnect()
  const during = {
    body: await sheet.boundingBox(), reload: await reload.boundingBox(), scroll: await scroll.evaluate(node => node.scrollTop),
  }
  console.info('[preview-continuity-geometry]', JSON.stringify({ viewport, before, during }))
  expect(before.body).not.toBeNull()
  expect(during.body).not.toBeNull()
  expect(Math.abs(during.body!.y - before.body!.y)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(during.body!.height - before.body!.height)).toBeLessThanOrEqual(0.5)
  expect(during.reload).toEqual(before.reload)
  expect(during.scroll).toBe(before.scroll)
  expect(await reload.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await selectedAddress.textContent()).toBe('A1')
  expect(byteReads).toBe(1)
  expect(await reload.innerText()).toBe(labels.reconnecting)
  const alertId = await alert.getAttribute('id')
  expect(alertId).not.toBeNull()
  expect(await reload.getAttribute('aria-describedby')).toBe(alertId)
  await compareOrRefreshGolden(fileURLToPath(new URL(chinese ? 'reconnecting-zh.expected.md' : 'reconnecting.expected.md', EXPECTED)), [
    await captureStableAria(target, '[data-workspace-preview-reconnecting]', host.workspaceCwd),
    await captureStableAria(target, 'section[aria-label="continuity.csv"] > [role="alert"]', host.workspaceCwd),
  ].join('\n'), MODE)
  await target.mouse.click(c2.x, c2.y)
  await expect.poll(() => selectedAddress.textContent()).toBe('C2')
  await expect.poll(() => formula.textContent()).toBe('R2C3')
  await target.mouse.move(c2.x, c2.y)
  await target.mouse.wheel(0, 400)
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
  const scrollTop = await scroll.evaluate(node => node.scrollTop)
  await recover()
  expect(await scroll.evaluate(node => node.scrollTop)).toBe(scrollTop)
  expect(await selectedAddress.textContent()).toBe('C2')
  expect(byteReads).toBe(1)
  await reload.focus()
  const scrolledBody = await sheet.boundingBox()
  warningStart = tripwire.warnings.length
  await disconnect()
  expect(await scroll.evaluate(node => node.scrollTop)).toBe(scrollTop)
  expect(await sheet.boundingBox()).toEqual(scrolledBody)
  expect(await selectedAddress.textContent()).toBe('C2')
  expect(await reload.evaluate(node => node === document.activeElement)).toBe(true)
  expect(byteReads).toBe(1)
  await recover()
  await reload.click()
  await expect.poll(() => byteReads).toBe(2)
  await expect.poll(() => formula.textContent()).toBe('R1C1')
  if (chinese) {
    const compactWidth = 200
    await target.setViewportSize({ width: compactWidth, height: viewport.height })
    const close = preview.getByRole('button', { name: labels.close, exact: true })
    const compactBefore = { body: await sheet.boundingBox(), reload: await reload.boundingBox(), close: await close.boundingBox() }
    console.info('[preview-continuity-wrapped-actions-before]', JSON.stringify({ width: compactWidth, before: compactBefore }))
    expect(compactBefore.reload).not.toBeNull()
    expect(compactBefore.close).not.toBeNull()
    expect(compactBefore.reload!.y).toBeGreaterThan(compactBefore.close!.y)
    await reload.focus()
    warningStart = tripwire.warnings.length
    await disconnect()
    const compactDuring = { body: await sheet.boundingBox(), reload: await reload.boundingBox(), close: await close.boundingBox() }
    console.info('[preview-continuity-wrapped-actions]', JSON.stringify({
      width: compactWidth, before: compactBefore, during: compactDuring,
    }))
    expect(compactDuring).toEqual(compactBefore)
    expect(compactDuring.reload!.x).toBeGreaterThanOrEqual(0)
    expect(compactDuring.reload!.x + compactDuring.reload!.width).toBeLessThanOrEqual(compactWidth)
    expect(await reload.evaluate(node => node === document.activeElement)).toBe(true)
    expect(byteReads).toBe(2)
    await recover()
    await target.setViewportSize({ width: viewport.width, height: viewport.height })
  }
  await preview.getByRole('button', { name: labels.close, exact: true }).click()
  await preview.waitFor({ state: 'hidden' })
  await target.getByRole('button', { name: 'Open readiness', exact: true }).click()
  const readiness = target.getByRole('region', { name: 'readiness.md', exact: true })
  await readiness.getByText('Ready after reconnect', { exact: true }).waitFor()
  const readinessAlert = readiness.locator(':scope > [role="alert"]')
  warningStart = tripwire.warnings.length
  await disconnect(readinessAlert)
  await recover(readinessAlert)
  await readiness.getByRole('button', { name: labels.close, exact: true }).click()
  await readiness.waitFor({ state: 'hidden' })
  await target.getByRole('button', { name: 'Open CSV', exact: true }).click()
  await sheet.waitFor()
  await alert.waitFor({ state: 'hidden' })
  await expect.poll(() => formula.textContent()).toBe('R1C1')
  expect(byteReads).toBe(3)
  await compareOrRefreshGolden(fileURLToPath(new URL(chinese ? 'idle-reopened-zh.expected.md' : 'idle-reopened.expected.md', EXPECTED)),
    await captureStableAria(target, 'section[aria-label="continuity.csv"] > div:first-child', host.workspaceCwd), MODE)
  // The fixture injects one real wire-level denial; the ordinary reader and UI must discard the body.
  await target.route(/\/api\/workspaceFiles\.stat(?:\?.*)?$/u, async (route) => {
    const response = await route.fetch()
    const body = await response.json() as Record<string, unknown>
    body.result = { ok: false, error: {
      code: 'workspace-file/unknown-session', message: 'Preview access is unavailable', details: { sessionId },
    } }
    await route.fulfill({ response, json: body })
  })
  await reload.click()
  await expect.poll(() => alert.textContent()).toBe('Preview access is unavailable')
  await expect.poll(() => sheet.count()).toBe(0)
  expect(await reload.isDisabled()).toBe(true)
  expect(await reload.getAttribute('data-workspace-preview-reconnecting')).toBeNull()
  expect(byteReadTargets).toEqual(['project:7', 'project:7', 'project:7'])
  expect(await target.locator('[data-slot-error]').count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
