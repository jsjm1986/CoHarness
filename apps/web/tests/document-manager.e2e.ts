/**
 * Document manager chrome through the shipped Web composition: desktop list
 * dialog and compact bottom sheet. Keyless: the Host document list is routed
 * to a fixture payload; no model turns.
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
const MODE = webSnapshotMode()

const LIST_PAYLOAD = {
  limits: {
    maxFileBytes: 104_857_600,
    maxFilesPerMessage: 20,
    maxMessageBytes: 100,
    maxInlineTextBytes: 256,
  },
  documents: [
    { docId: '2026-08-14/brief.txt', name: 'brief.txt', bytes: 21, mediaType: 'text/plain' },
    { docId: '2026-08-16/notes.txt', name: 'notes.txt', bytes: 30_720, mediaType: 'text/plain' },
  ],
}

async function mockDocuments(page: Page): Promise<void> {
  await page.route('**/api/documents', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname !== '/api/documents' || route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    await route.fulfill({ json: LIST_PAYLOAD })
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

  it('desktop: lists date groups with named row actions in a centered dialog', async () => {
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
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DESKTOP_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('compact: bottom sheet stacks search above upload and keeps row actions inside the dialog', async () => {
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
    const previewBox = await dialog.getByRole('button', { name: 'Preview brief.txt' }).boundingBox()
    const nameBox = await dialog.getByText('brief.txt', { exact: true }).boundingBox()
    if (dialogBox === null || searchBox === null || uploadBox === null || previewBox === null || nameBox === null) {
      throw new Error('document manager compact geometry missing')
    }
    expect(dialogBox.y + dialogBox.height).toBeGreaterThan(700)
    expect(searchBox.y + searchBox.height).toBeLessThanOrEqual(uploadBox.y + 2)
    expect(previewBox.height).toBeGreaterThanOrEqual(44)
    expect(nameBox.y + nameBox.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height)

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(COMPACT_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('commits exactly the document-manager snapshot inventory', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['compact.expected.md', 'desktop.expected.md'])
  })
})
