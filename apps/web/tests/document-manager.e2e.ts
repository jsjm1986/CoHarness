/**
 * Document manager chrome through the shipped Web composition: desktop list
 * dialog, compact bottom sheet, and a paged 21-file list. Keyless: the Host
 * document list is routed to a fixture payload; no model turns.
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/document-manager', import.meta.url))
const DESKTOP_EXPECTED = join(SNAPSHOT_DIR, 'desktop.expected.md')
const COMPACT_EXPECTED = join(SNAPSHOT_DIR, 'compact.expected.md')
const COMPACT_ACTIONS_EXPECTED = join(SNAPSHOT_DIR, 'compact-actions.expected.md')
const COMPACT_SCOPE_EXPECTED = join(SNAPSHOT_DIR, 'compact-scope.expected.md')
const COMPACT_BATCH_EXPECTED = join(SNAPSHOT_DIR, 'compact-batch.expected.md')
const COMPACT_OVERVIEW_EXPECTED = join(SNAPSHOT_DIR, 'compact-overview.expected.md')
const PAGED_EXPECTED = join(SNAPSHOT_DIR, 'desktop-paged.expected.md')
const MODE = webSnapshotMode()

const LIMITS = {
  maxFileBytes: null,
  maxFilesPerMessage: 20,
  maxMessageBytes: 100,
  maxInlineTextBytes: 256,
  upload: { protocol: 'resumable-v1', chunkBytes: 8 * 1024 * 1024, sessionTtlMs: 86400000, resumable: true },
}

const LIST_PAYLOAD = {
  limits: LIMITS,
  directoryId: '',
  directories: [
    { directoryId: 'reports', path: '/workspace/documents/reports', name: 'reports', modifiedAt: 1 },
  ],
  documents: [
    { docId: '2026-08-14/brief.txt', name: 'brief.txt', bytes: 21, mediaType: 'text/plain', modifiedAt: Date.UTC(2026, 7, 14) },
    { docId: '2026-08-16/notes.txt', name: 'notes.txt', bytes: 30_720, mediaType: 'text/plain', modifiedAt: Date.UTC(2026, 7, 16) },
  ],
}

const PAGED_PAYLOAD = {
  limits: LIMITS,
  directoryId: '',
  directories: [],
  documents: Array.from({ length: 21 }, (_, i) => {
    const day = String(i + 1).padStart(2, '0')
    return {
      docId: `2026-08-${day}/f-${day}.txt`,
      name: `f-${day}.txt`,
      bytes: 21,
      mediaType: 'text/plain',
      modifiedAt: Date.UTC(2026, 7, i + 1),
    }
  }),
}

async function mockDocuments(page: Page, payload: typeof LIST_PAYLOAD = LIST_PAYLOAD): Promise<void> {
  await page.route(/\/api\/documents(?:\?.*)?$/, async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname !== '/api/documents' || route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    await route.fulfill({ json: payload })
  })
}

describe('web e2e: document manager', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole> = { warnings: [], pageErrors: [] }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
  }, 120_000)

  afterEach(async () => {
    try {
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page?.close()
    }
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'document manager e2e cleanup failed')
  })

  it('desktop: lists folders and date groups with named row actions in a centered dialog', async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-manager-desktop'))
    await mockDocuments(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Document Manager' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByText('brief.txt').waitFor({ timeout: 10_000 })
    await dialog.getByText('notes.txt').waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Open folder reports' }).waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DESKTOP_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('desktop: pages a 21-file list and shows the oldest file on page two', async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-manager-desktop-paged'))
    await mockDocuments(page, PAGED_PAYLOAD)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Document Manager' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByText('f-21.txt').waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Next page' }).click()
    await dialog.getByText('f-01.txt').waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(PAGED_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('desktop: switches the document scope in place without opening a runtime page', async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-manager-scope'))
    await mockDocuments(page)
    await page.route('**/account/api/context', async (route) => {
      await route.fulfill({ json: {
        scope: { kind: 'personal' },
        projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }],
      } })
    })
    await page.route('**/api/documents/transfer/list', async (route) => {
      await route.fulfill({ json: {
        version: 1,
        scope: { kind: 'project', label: 'Compiler' },
        documents: [{ docId: 'shared.txt', name: 'shared.txt', bytes: 7, mediaType: 'text/plain', modifiedAt: 1 }],
      } })
    })
    let popupOpened = false
    page.on('popup', () => { popupOpened = true })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Document Manager' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: /Compiler/ }).waitFor({ timeout: 10_000 })
    const beforeUrl = page.url()
    await dialog.getByRole('button', { name: /Compiler/ }).click()
    await dialog.getByText('Viewing: Compiler', { exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByText('shared.txt', { exact: true }).waitFor({ timeout: 10_000 })
    expect(page.url()).toBe(beforeUrl)
    expect(await page.getByRole('dialog').count()).toBe(1)
    expect(popupOpened).toBe(false)
  }, 60_000)

  it('compact: uses a scope trigger, upload primary, and one row action sheet', async () => {
    page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      locale: 'en-US',
      hasTouch: true,
      isMobile: true,
    })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-manager-compact'))
    await mockDocuments(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Document Manager' })
    await dialog.waitFor({ timeout: 10_000 })

    const dialogBox = await dialog.boundingBox()
    const searchBox = await dialog.getByPlaceholder('Search document name').boundingBox()
    const uploadBox = await dialog.getByRole('button', { name: 'Upload Document' }).boundingBox()
    const scopeTrigger = dialog.locator('[data-documents-scope-trigger]')
    const more = dialog.locator('[data-documents-toolbar-more]')
    const scopeBox = await scopeTrigger.boundingBox()
    const moreBox = await more.boundingBox()
    const rowMore = dialog.getByRole('button', { name: 'More actions: brief.txt' })
    const name = dialog.getByText('brief.txt', { exact: true })
    await name.scrollIntoViewIfNeeded()
    const nameBox = await name.boundingBox()
    const rowMoreBox = await rowMore.boundingBox()
    if (dialogBox === null
      || searchBox === null
      || uploadBox === null
      || scopeBox === null
      || moreBox === null
      || rowMoreBox === null
      || nameBox === null) {
      throw new Error('document manager compact geometry missing')
    }
    expect(dialogBox.x).toBeGreaterThanOrEqual(0)
    expect(dialogBox.y).toBeGreaterThanOrEqual(-1)
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(391)
    expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(845)
    expect(searchBox.y + searchBox.height).toBeLessThanOrEqual(uploadBox.y + 2)
    expect(scopeBox.height).toBeGreaterThanOrEqual(44)
    expect(moreBox.height).toBeGreaterThanOrEqual(44)
    expect(rowMoreBox.height).toBeGreaterThanOrEqual(44)
    expect(nameBox.y + nameBox.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height)

    await rowMore.click()
    const actionSheet = page.locator('[data-documents-sheet="document-actions"]')
    await actionSheet.waitFor({ timeout: 10_000 })
    expect(await actionSheet.locator('[data-documents-sheet-scrollport]').count()).toBe(1)
    expect(await actionSheet.locator('[class*="handle"]').count()).toBe(0)
    const preview = actionSheet.getByRole('button', { name: 'Preview' })
    const previewBox = await preview.boundingBox()
    if (previewBox === null) throw new Error('document action sheet geometry missing')
    expect(previewBox.height).toBeGreaterThanOrEqual(44)
    const actionLayer = await actionSheet.evaluate(element => ({
      opacity: getComputedStyle(element.closest('[role="dialog"]') ?? element).opacity,
      transform: getComputedStyle(element.closest('[role="dialog"]') ?? element).transform,
    }))
    expect(actionLayer.opacity).toBe('1')
    expect(actionLayer.transform).toBe('none')
    const actionHit = await actionSheet.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return hit?.closest('[data-documents-sheet="document-actions"]') !== null
    })
    expect(actionHit).toBe(true)
    const actionSnapshot = await captureStableAria(page, '[data-documents-sheet="document-actions"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(COMPACT_ACTIONS_EXPECTED, actionSnapshot, MODE)
    await preview.click()
    const previewDialog = page.getByRole('dialog', { name: 'Preview: brief.txt' })
    await previewDialog.waitFor({ timeout: 10_000 })
    const previewDialogBox = await previewDialog.boundingBox()
    if (previewDialogBox === null) throw new Error('compact preview geometry missing')
    expect(previewDialogBox.x).toBeGreaterThanOrEqual(0)
    expect(previewDialogBox.y).toBeGreaterThanOrEqual(-1)
    expect(previewDialogBox.x + previewDialogBox.width).toBeLessThanOrEqual(391)
    expect(previewDialogBox.y + previewDialogBox.height).toBeLessThanOrEqual(845)
    await page.keyboard.press('Escape')
    await actionSheet.waitFor({ state: 'detached', timeout: 10_000 })

    const overflow = await dialog.evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(COMPACT_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('compact narrow: keeps filters in the more sheet and primary actions in one track', async () => {
    page = await browser.newPage({
      viewport: { width: 320, height: 568 },
      locale: 'en-US',
      hasTouch: true,
      isMobile: true,
    })
    tripwire = watchConsole(page)
    let browseRequests = 0
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (request.method() === 'GET' && url.pathname === '/api/documents' && url.searchParams.has('directory')) browseRequests += 1
    })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-manager-narrow'))
    await mockDocuments(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Document Manager' })
    await dialog.waitFor({ timeout: 10_000 })

    const search = dialog.getByPlaceholder('Search document name')
    const upload = dialog.getByRole('button', { name: 'Upload Document' })
    const more = dialog.locator('[data-documents-toolbar-more]')
    const [dialogBox, searchBox, uploadBox, moreBox] = await Promise.all([
      dialog.boundingBox(), search.boundingBox(), upload.boundingBox(), more.boundingBox(),
    ])
    if ([dialogBox, searchBox, uploadBox, moreBox].some(box => box === null)) {
      throw new Error('document manager narrow geometry missing')
    }
    expect(searchBox!.width).toBeGreaterThan(200)
    expect(await dialog.locator('select').count()).toBe(0)
    expect(searchBox!.y + searchBox!.height).toBeLessThanOrEqual(uploadBox!.y + 1)
    expect(Math.round(uploadBox!.y)).toBe(Math.round(moreBox!.y))
    for (const box of [uploadBox!, moreBox!]) {
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(321)
    }
    expect(await upload.evaluate(element => getComputedStyle(element).whiteSpace)).toBe('nowrap')
    expect(await upload.locator('svg').count()).toBeGreaterThan(0)
    const browseBeforeMore = browseRequests
    await more.click()
    const moreSheet = page.locator('[data-documents-sheet="toolbar-more"]')
    await moreSheet.waitFor({ timeout: 10_000 })
    expect(await moreSheet.locator('[data-documents-sheet-scrollport]').count()).toBe(1)
    expect(await moreSheet.locator('select').count()).toBe(2)
    await moreSheet.locator('select').nth(0).selectOption('pdf')
    await moreSheet.locator('select').nth(1).selectOption('name:asc')
    expect(browseRequests).toBe(browseBeforeMore)
    for (const control of [
      moreSheet.getByRole('button', { name: 'New Folder' }),
      moreSheet.getByRole('button', { name: 'Refresh' }),
    ]) {
      const box = await control.boundingBox()
      if (box === null) throw new Error('more-sheet action geometry missing')
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(321)
    }
    await moreSheet.getByRole('button', { name: 'Close' }).click()
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(321)
    const overflow = await dialog.evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
  }, 60_000)

  it('compact: switches scopes and exposes permission-safe batch actions', async () => {
    page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      locale: 'en-US',
      hasTouch: true,
      isMobile: true,
    })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-manager-scope-compact'))
    await mockDocuments(page)
    await page.route('**/account/api/context', async (route) => {
      await route.fulfill({ json: {
        scope: { kind: 'personal' },
        projects: [
          { projectId: 41, name: 'Compiler', mode: 'ro' },
          { projectId: 42, name: 'Payments', mode: 'rw' },
        ],
      } })
    })
    await page.route('**/api/documents/transfer/list', async (route) => {
      await route.fulfill({ json: {
        version: 1,
        scope: { kind: 'project', label: 'Compiler' },
        documents: [{ docId: 'shared.txt', name: 'shared.txt', bytes: 7, mediaType: 'text/plain', modifiedAt: 1 }],
      } })
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'Document Manager' })
    await manager.waitFor({ timeout: 10_000 })
    await manager.getByText('brief.txt', { exact: true }).waitFor({ timeout: 10_000 })

    await manager.locator('[data-documents-scope-trigger]').click()
    const scopeSheet = page.locator('[data-documents-sheet="scope-view"]')
    await scopeSheet.waitFor({ timeout: 10_000 })
    const scopeSnapshot = await captureStableAria(page, '[data-documents-sheet="scope-view"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(COMPACT_SCOPE_EXPECTED, scopeSnapshot, MODE)
    await scopeSheet.getByPlaceholder('Search document scopes').fill('Compiler')
    await scopeSheet.getByRole('option', { name: /Compiler/ }).click()
    await manager.locator('[data-documents-panel]').getByText('Viewing: Compiler', { exact: true }).waitFor({ timeout: 10_000 })
    await manager.getByText('shared.txt', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await page.locator('[role="dialog"]').count()).toBe(1)

    await manager.getByRole('checkbox', { name: 'shared.txt' }).check()
    const batchBar = manager.locator('[data-documents-batch-bar]')
    await batchBar.getByRole('button', { name: 'Batch actions' }).click()
    const batchSheet = page.locator('[data-documents-sheet="batch-actions"]')
    await batchSheet.waitFor({ timeout: 10_000 })
    const batchSnapshot = await captureStableAria(page, '[data-documents-sheet="batch-actions"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(COMPACT_BATCH_EXPECTED, batchSnapshot, MODE)
    expect(await batchSheet.getByRole('button', { name: 'Copy to another scope' }).isEnabled()).toBe(true)
    expect(await batchSheet.getByRole('button', { name: 'Move selected' }).isDisabled()).toBe(true)
    expect(await batchSheet.getByRole('button', { name: 'Delete selected' }).isDisabled()).toBe(true)
    await batchSheet.getByRole('button', { name: 'Close' }).click()
  }, 60_000)

  it('compact: renders the all-scope metadata view as a bounded card list', async () => {
    page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      locale: 'en-US',
      hasTouch: true,
      isMobile: true,
    })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-manager-overview-compact'))
    await mockDocuments(page)
    await page.route('**/account/api/context', async (route) => {
      await route.fulfill({ json: {
        scope: { kind: 'personal' },
        projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }],
      } })
    })
    await page.route('**/api/documents/overview', async (route) => {
      await route.fulfill({ json: {
        version: 1,
        documents: [{
          catalogId: 'catalog-1',
          docId: '2026-08-16/notes.txt',
          name: 'notes.txt',
          bytes: 30_720,
          mediaType: 'text/plain',
          modifiedAt: Date.UTC(2026, 7, 16),
          scope: { kind: 'personal', label: 'Personal documents' },
          owner: { displayName: 'Alice' },
        }],
      } })
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'Document Manager' })
    await manager.waitFor({ timeout: 10_000 })
    await manager.locator('[data-documents-scope-trigger]').click()
    const scopeSheet = page.locator('[data-documents-sheet="scope-view"]')
    await scopeSheet.getByRole('option', { name: /All accessible documents/ }).click()
    await manager.getByRole('heading', { name: 'All accessible documents' }).waitFor({ timeout: 10_000 })
    await manager.locator('[class*="overviewList"]').getByText('notes.txt', { exact: true }).waitFor({ timeout: 10_000 })
    const overviewSnapshot = await captureStableAria(page, '[data-documents-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(COMPACT_OVERVIEW_EXPECTED, overviewSnapshot, MODE)
    const overviewMore = manager.locator('[data-documents-row-more="overview"]')
    await overviewMore.click()
    const overviewSheet = page.locator('[data-documents-sheet="overview-actions"]')
    await overviewSheet.waitFor({ timeout: 10_000 })
    const overviewBox = await overviewSheet.boundingBox()
    if (overviewBox === null) throw new Error('compact overview action geometry missing')
    expect(overviewBox.x).toBeGreaterThanOrEqual(0)
    expect(overviewBox.x + overviewBox.width).toBeLessThanOrEqual(391)
    await overviewSheet.getByRole('button', { name: 'Close' }).click()
  }, 60_000)

  it('uses the desktop workbench exactly at the shared 768px boundary', async () => {
    page = await browser.newPage({ viewport: { width: 768, height: 800 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-manager-boundary'))
    await mockDocuments(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Document Manager' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.locator('[data-documents-list] [title="brief.txt"]').waitFor({ timeout: 10_000 })
    expect(await dialog.locator('[data-documents-scope-trigger]').count()).toBe(0)
    expect(await dialog.locator('aside[aria-label="Document scopes"]').count()).toBe(1)
    const overflow = await dialog.evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
  }, 60_000)

  it('commits exactly the document-manager snapshot inventory', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'compact-actions.expected.md',
      'compact-batch.expected.md',
      'compact.expected.md',
      'compact-overview.expected.md',
      'compact-scope.expected.md',
      'desktop-paged.expected.md',
      'desktop.expected.md',
    ])
  })
})
