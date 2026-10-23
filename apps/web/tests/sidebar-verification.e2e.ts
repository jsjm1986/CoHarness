/** Resource navigation stays retryable while the real Client revalidates its account after reconnect. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type WebSocketRoute } from 'playwright'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { pdfResourceFixture } from '../../../packages/client/ui-workbench/tests/pdf-resource-fixture.ts'
import { acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./expected/sidebar-verification/pending.expected.md', import.meta.url))
const SESSION = 'sidebar-verification-fixture'
const MODE = webSnapshotMode()
let scaffold: WebScaffold | undefined
let browser: Browser | undefined
let page: Page | undefined
let releaseContext: (() => void) | undefined

afterEach(async () => {
  releaseContext?.()
  releaseContext = undefined
  const failures: unknown[] = []
  await page?.unrouteAll({ behavior: 'wait' }).catch((error: unknown) => failures.push(error))
  await browser?.close().catch((error: unknown) => failures.push(error))
  browser = undefined
  page = undefined
  await scaffold?.close().catch((error: unknown) => failures.push(error))
  scaffold = undefined
  if (failures.length > 0) throw new AggregateError(failures, 'Sidebar verification fixture teardown failed')
})

it.skipIf(MODE === 'record')('keeps the file browser open for a verification refusal and opens the resource on an explicit retry', async () => {
  scaffold = await launchWebScaffold({ workbench: true, remoteAuthority: 'app.localhost' })
  await writeFile(join(scaffold.workspaceCwd, 'existing.html'), '<!doctype html><p>Existing HTML remains available.</p>')
  await writeFile(join(scaffold.workspaceCwd, 'request.pdf'), pdfResourceFixture('vector'))
  const seed = (await readFile(SEED, 'utf8')).replace('"text":"DONE"', '"text":"[Open existing HTML](existing.html)"')
  const sessionId = await seedSession(scaffold, seed, SESSION)
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  await workspace.attachSession(sessionId)
  browser = await chromium.launch()
  page = await newEnglishPage(browser)
  const target = page
  const host = scaffold
  const tripwire = watchConsole(target)
  onTestFailed(() => saveFailureShot(target, 'sidebar-verification'))
  let held = false
  const contextGate = Promise.withResolvers<undefined>()
  releaseContext = () => { contextGate.resolve(undefined) }
  const contextRequested = Promise.withResolvers<undefined>()
  let socket: { client: WebSocketRoute; server: WebSocketRoute } | undefined
  await target.routeWebSocket(/\/api\/events\.host(?:\?|$)/u, (client) => {
    socket = { client, server: client.connectToServer() }
  })
  // Only Gateway metadata is synthetic; the Host, file RPCs, streams and all
  // account/layout consumers belong to the real assembled application.
  await target.route(/\/api\/host\.describe(?:\?.*)?$/u, async (route) => {
    const response = await route.fetch()
    const body = await response.json() as {
      result: { ok: true; value: { executionAuthorityRequired: boolean; runtimeTarget: { kind: 'personal' } } } | { ok: false }
    }
    expect(body.result.ok).toBe(true)
    if (body.result.ok) {
      body.result.value.executionAuthorityRequired = true
      body.result.value.runtimeTarget = { kind: 'personal' }
    }
    await route.fulfill({ response, json: body })
  })
  await target.route(/\/account\/api\/context(?:\?.*)?$/u, async (route) => {
    if (held) { contextRequested.resolve(undefined); await contextGate.promise }
    await route.fulfill({ json: {
      user: { id: 1, username: 'fixture', displayName: 'Fixture', role: 'admin' },
      scope: { kind: 'personal' }, projects: [],
    } })
  })
  await target.route(/\/account\/api\/workbench\/catalog(?:\?.*)?$/u, async (route) => {
    await route.fulfill({ json: {
      personal: { id: 1, name: 'Fixture' }, personalComplete: true, activeRuntime: { kind: 'personal' }, projects: [],
      items: [{ sessionId, runtime: { kind: 'personal' }, visibility: 'personal', title: 'Sidebar fixture',
        creatorUserId: 1, creatorDisplayName: 'Fixture', updatedAt: 1, blank: false, canWrite: true }],
    } })
  })
  await target.addInitScript((id) => {
    if (window === window.top) localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
  }, sessionId)
  await target.goto(host.authenticatedUrl, { waitUntil: 'load' })
  await target.getByRole('button', { name: 'Open existing HTML', exact: true }).click().catch(async (error: unknown) => {
    await saveFailureShot(target, 'sidebar-verification-opening')
    console.info('Sidebar verification opening failure:', JSON.stringify(tripwire))
    throw error
  })
  const sidebar = target.locator('[data-sidebar-right-panel]')
  const htmlTab = sidebar.getByRole('tab', { name: /existing\.html/u })
  await htmlTab.waitFor({ state: 'visible' })
  await target.frameLocator('iframe[data-workspace-html-preview]').getByText('Existing HTML remains available.', { exact: true }).waitFor()
  await target.locator('[data-workbench-toolbar]').getByRole('button', { name: 'Workspace files', exact: true }).click()
  const picker = target.getByRole('dialog', { name: 'Workspace files', exact: true })
  await picker.getByRole('treeitem', { name: 'request.pdf', exact: true }).waitFor()
  const established = socket
  if (established === undefined) throw new Error('Host stream was not established')
  held = true
  const warningsBefore = tripwire.warnings.length
  await established.client.close({ code: 1012, reason: 'Fixture account revalidation' })
  await established.server.close({ code: 1012, reason: 'Fixture account revalidation' })
  await contextRequested.promise
  await expect.poll(() => htmlTab.count()).toBe(0)
  await picker.getByRole('treeitem', { name: 'request.pdf', exact: true }).click()
  const failure = picker.getByRole('alert')
  await expect.poll(() => failure.count()).toBe(1)
  expect(await failure.textContent()).toBe('Checking access permissions. Please try again shortly.')
  expect(await picker.isVisible()).toBe(true)
  expect(await sidebar.getByRole('tab', { name: /request\.pdf/u }).count()).toBe(0)
  await compareOrRefreshGolden(GOLDEN,
    await captureStableAria(target, '[role="dialog"] [role="alert"]', host.workspaceCwd), MODE)
  contextGate.resolve(undefined)
  await htmlTab.waitFor({ state: 'visible' })
  acknowledgeReloadConnectionLoss(tripwire, warningsBefore)
  expect(tripwire.warnings).toEqual([])
  expect(await picker.isVisible()).toBe(true)
  expect(await sidebar.getByRole('tab', { name: /request\.pdf/u }).count()).toBe(0)
  await picker.getByRole('treeitem', { name: 'request.pdf', exact: true }).click()
  await picker.waitFor({ state: 'hidden' })
  const pdf = target.getByRole('region', { name: 'request.pdf', exact: true })
  const canvas = pdf.locator('canvas').first()
  await canvas.waitFor({ state: 'visible' })
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(0)
  await htmlTab.click()
  await target.frameLocator('iframe[data-workspace-html-preview]').getByText('Existing HTML remains available.', { exact: true }).waitFor()
  expect(await sidebar.getByRole('tab', { name: /request\.pdf/u }).count()).toBe(1)
  expect(await target.locator('[data-slot-error]').count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
