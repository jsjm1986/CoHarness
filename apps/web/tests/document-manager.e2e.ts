/**
 * Document manager chrome through the shipped Web composition: desktop list
 * dialog, compact bottom sheet, target-scope upload, and a paged 21-file list.
 * Keyless: chrome cases use fixture document lists. Trash navigation exercises
 * real personal Host storage and a controlled project broker; no model turns
 * are required.
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import type { UserDocRef } from '@deepseek-ai/dsh-userdoc'
import { UserDocDirectoryId, UserDocId } from '@deepseek-ai/dsh-userdoc'
import { pdfFixture } from '../../../packages/client/ui-workbench/tests/pdf-fixture.ts'
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
const EXPECTED_DIR = fileURLToPath(new URL('./expected/document-manager', import.meta.url))
const TRASH_HEADER_EXPECTED = join(EXPECTED_DIR, 'trash-header.expected.md')
const LOADING_EXPECTED = join(EXPECTED_DIR, 'loading.expected.md')
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
  let previewDocument: UserDocRef
  let tripwire: ReturnType<typeof watchConsole> = { warnings: [], pageErrors: [] }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const target = await scaffold.ctx.userDocs.resolveTarget({ name: 'preview-layout.pdf' })
    previewDocument = await scaffold.ctx.userDocs.save(target, new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(pdfFixture()); controller.close() },
    }))
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

  it.each([
    { label: 'desktop', width: 1280, height: 800 },
    { label: 'compact', width: 390, height: 844 },
  ])('$label: PDF preview fills its available body and releases the iframe on close', async ({ label, width, height }) => {
    const compact = width < 768
    page = await browser.newPage({
      viewport: { width, height }, locale: 'en-US', reducedMotion: 'reduce',
      ...(compact ? { hasTouch: true, isMobile: true } : {}),
    })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, `web-e2e-document-preview-${label}`))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    if (compact) await page.getByRole('button', { name: 'Open sidebar' }).click()
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'Document Manager', exact: true })
    await manager.getByText(previewDocument.name, { exact: true }).waitFor()
    const initialFrames = page.frames().length
    const response = page.waitForResponse((reply) => {
      const url = new URL(reply.url())
      return url.pathname === '/api/documents/content' && url.searchParams.get('id') === previewDocument.docId
    })
    if (compact) {
      await manager.getByRole('button', { name: `More actions: ${previewDocument.name}`, exact: true }).click()
      await page.locator('[data-documents-sheet="document-actions"]').getByRole('button', { name: 'Preview', exact: true }).click()
    } else {
      await manager.getByRole('button', { name: `Preview ${previewDocument.name}`, exact: true }).click()
    }
    expect([200, 206]).toContain((await response).status())
    const preview = page.getByRole('dialog', { name: `Preview: ${previewDocument.name}`, exact: true })
    const frame = preview.locator('iframe')
    await frame.waitFor({ state: 'visible' })
    const geometry = await frame.evaluate((element) => {
      const body = element.parentElement!, dialog = element.closest('[role="dialog"]')!
      const box = (node: Element) => {
        const rect = node.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }
      }
      return { frame: box(element), body: box(body), dialog: box(dialog), scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth }
    })
    expect(geometry.body.height).toBeGreaterThan(300)
    expect(geometry.frame.height, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.body.height - 2)
    expect(geometry.frame.bottom).toBeLessThanOrEqual(geometry.body.bottom + 1)
    expect(geometry.dialog.x).toBeGreaterThanOrEqual(-1)
    expect(geometry.dialog.y).toBeGreaterThanOrEqual(-1)
    expect(geometry.dialog.right).toBeLessThanOrEqual(width + 1)
    expect(geometry.dialog.bottom).toBeLessThanOrEqual(height + 1)
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
    const close = preview.getByRole('button', { name: 'Close', exact: true })
    await close.waitFor({ state: 'visible' })
    if (compact) await close.click()
    else await page.keyboard.press('Escape')
    await preview.waitFor({ state: 'detached' })
    expect(await page.locator('iframe').count()).toBe(0)
    await expect.poll(() => page.frames().length).toBe(initialFrames)
    expect(await manager.count()).toBe(1)
  })

  it('desktop: lists folders and date groups with named row actions in a centered dialog', async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-manager-desktop'))
    await mockDocuments(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
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

  it.each([
    { label: 'desktop', width: 1280, height: 800, target: 'personal' },
    { label: 'compact', width: 390, height: 844, target: 'personal' },
    { label: 'desktop', width: 1280, height: 800, target: 'project' },
    { label: 'compact', width: 390, height: 844, target: 'project' },
  ] as const)('$label: returns from $target trash to the same folder and reads a restored file once', async ({ label, width, height, target }) => {
    const compact = width === 390
    let directoryId = 'reports'
    let restoredFile = {
      docId: 'reports/project-restored.txt', name: 'project-restored.txt', bytes: 18,
      mediaType: 'text/plain', modifiedAt: Date.UTC(2026, 9, 23),
    }
    if (target === 'personal') {
      const folder = await scaffold.ctx.userDocs.createDirectory(UserDocDirectoryId(''), `trash-return-${label}`)
      directoryId = folder.directoryId
      onTestFinished(async () => {
        for (const row of (await scaffold.ctx.userDocs.listDirectory(folder.directoryId)).documents) {
          await scaffold.ctx.userDocs.trash(row.docId)
        }
        for (const row of await scaffold.ctx.userDocs.listTrash()) {
          if (row.directoryId === folder.directoryId) await scaffold.ctx.userDocs.purge(row.docId)
        }
        await scaffold.ctx.userDocs.removeDirectory(folder.directoryId)
        expect((await scaffold.ctx.userDocs.listDirectory(UserDocDirectoryId(''))).directories
          .some(row => row.directoryId === folder.directoryId)).toBe(false)
        console.info('[document-trash-return-cleanup]', JSON.stringify({ label, directoryId: folder.directoryId, removed: true }))
      })
      const resolved = await scaffold.ctx.userDocs.resolveTarget({ name: 'restored.txt', directoryId: folder.directoryId })
      const saved = await scaffold.ctx.userDocs.save(resolved, new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('real Host restore\n')); controller.close() },
      }))
      await scaffold.ctx.userDocs.trash(saved.docId)
      restoredFile = saved
    }
    page = await browser.newPage({
      viewport: { width, height }, locale: 'en-US', reducedMotion: 'reduce',
      ...(compact ? { hasTouch: true, isMobile: true } : {}),
    })
    await page.clock.setFixedTime(Date.UTC(2026, 9, 23, 12))
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, `web-e2e-document-trash-${label}-${target}`))
    const origin = new URL(scaffold.authenticatedUrl).origin
    // Account labels and the alternate-project broker are fixture responses. Personal document
    // metadata, trash, restore, and bytes continue to the real private scaffold Host.
    await page.route(url => url.origin === origin && url.pathname === '/account/api/context', async (route) => {
      await route.fulfill({ json: {
        scope: { kind: 'personal' }, projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }],
      } })
    })
    let projectRestored = false
    let restoreWrites = 0
    let holdRestoredListing = false
    const restoredListingRequested = Promise.withResolvers<undefined>()
    const releaseRestoredListing = Promise.withResolvers<undefined>()
    if (target === 'personal') {
      await page.route(url => url.origin === origin && url.pathname === '/api/documents'
        && url.searchParams.get('directory') === directoryId, async (route) => {
        const response = await route.fetch()
        if (holdRestoredListing) {
          restoredListingRequested.resolve(undefined)
          await releaseRestoredListing.promise
        }
        await route.fulfill({ response })
      })
    }
    if (target === 'project') {
      await page.route(url => url.origin === origin && [
        '/api/documents/scope', '/api/documents/scope/trash', '/api/documents/scope/restore',
      ].includes(url.pathname), async (route) => {
        const url = new URL(route.request().url())
        expect(url.searchParams.get('scope')).toBe('project:41')
        if (url.pathname === '/api/documents/scope') {
          const directory = url.searchParams.get('directory') ?? ''
          expect(['', 'reports']).toContain(directory)
          if (holdRestoredListing && directory === directoryId) {
            restoredListingRequested.resolve(undefined)
            await releaseRestoredListing.promise
          }
          await route.fulfill({ json: {
            version: 1, scope: { kind: 'project', label: 'Compiler' }, directoryId: directory,
            directories: directory === '' ? [{ directoryId: 'reports', name: 'reports' }] : [],
            documents: directory === 'reports' && projectRestored ? [restoredFile] : [], limits: LIMITS,
          } })
        } else if (url.pathname === '/api/documents/scope/trash') {
          await route.fulfill({ json: { version: 1, documents: projectRestored ? [] : [{
            ...restoredFile, directoryId: 'reports', trashedAt: Date.UTC(2026, 9, 23), purgeAfter: Date.UTC(2099, 0, 1),
          }] } })
        } else {
          expect(route.request().method()).toBe('POST')
          expect(url.searchParams.get('id')).toBe(restoredFile.docId)
          projectRestored = true
          restoreWrites++
          await route.fulfill({ json: { version: 1, document: restoredFile } })
        }
      })
    }
    const reads: { path: string; scope: string | null; directory: string | null }[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.origin === origin && request.method() === 'GET'
        && (url.pathname === '/api/documents' || url.pathname === '/api/documents/scope')) {
        reads.push({ path: url.pathname, scope: url.searchParams.get('scope'), directory: url.searchParams.get('directory') })
      }
      if (target === 'personal' && url.origin === origin && request.method() === 'POST'
        && url.pathname === '/api/documents/restore') restoreWrites++
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    if (compact) await page.getByRole('button', { name: 'Open sidebar', exact: true }).tap()
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'Document Manager', exact: true })
    await manager.locator('aside button').filter({ hasText: 'Compiler' }).waitFor({ state: 'attached' })
    if (target === 'project') {
      if (compact) {
        await manager.locator('[data-documents-scope-trigger]').tap()
        await page.locator('[data-documents-sheet="scope-view"]').getByRole('option', { name: /Compiler/ }).tap()
      } else await manager.getByRole('button', { name: /Compiler/ }).click()
      await manager.getByRole('status').getByText('Upload target: Compiler', { exact: true }).waitFor()
    }
    const folderName = target === 'personal' ? `trash-return-${label}` : 'reports'
    const folder = manager.getByRole('button', { name: `Open folder ${folderName}`, exact: true })
    if (compact) await folder.tap()
    else await folder.click()
    const breadcrumb = manager.getByRole('navigation', { name: 'Document path', exact: true })
      .getByRole('button', { name: folderName, exact: true })
    await expect.poll(() => breadcrumb.getAttribute('aria-current')).toBe('page')
    await manager.getByText('No documents uploaded yet', { exact: true }).waitFor()
    const before = [...reads]
    const enterTrash = async () => {
      if (compact) {
        await manager.locator('[data-documents-toolbar-more]').tap()
        await page.locator('[data-documents-sheet="toolbar-more"]').getByRole('button', { name: 'Trash', exact: true }).tap()
      } else await manager.getByRole('button', { name: 'Trash', exact: true }).click()
      const trash = manager.getByRole('region', { name: 'Trash', exact: true })
      await trash.getByText(restoredFile.name, { exact: true }).waitFor()
      return trash
    }
    const trash = await enterTrash()
    const back = trash.getByRole('button', { name: 'Back to documents', exact: true })
    expect(await back.count()).toBe(1)
    await back.waitFor({ state: 'visible' })
    const box = await back.boundingBox()
    if (box === null) throw new Error('Trash return action has no visible geometry')
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
    expect(box.y + box.height).toBeLessThanOrEqual(height)
    if (compact) expect(box.height).toBeGreaterThanOrEqual(44)
    expect(await back.evaluate((button) => {
      const box = button.getBoundingClientRect()
      return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('button') === button
    })).toBe(true)
    if (target === 'personal') {
      if (MODE === 'refresh') await mkdir(EXPECTED_DIR, { recursive: true })
      await compareOrRefreshGolden(TRASH_HEADER_EXPECTED,
        await captureStableAria(page, '[data-documents-trash-header]', scaffold.workspaceCwd), MODE)
    }
    await back.focus()
    await page.keyboard.press('Enter')
    await trash.waitFor({ state: 'detached' })
    await expect.poll(() => breadcrumb.getAttribute('aria-current')).toBe('page')
    const returnTarget = compact ? manager.locator('[data-documents-toolbar-more]')
      : manager.getByRole('button', { name: 'Trash', exact: true })
    expect(await returnTarget.evaluate(node => node === document.activeElement)).toBe(true)
    expect(reads).toEqual(before)
    const restoredTrash = await enterTrash()
    const restore = restoredTrash.getByRole('button', { name: `Restore ${restoredFile.name}`, exact: true })
    const [restoreResponse] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname
        === (target === 'personal' ? '/api/documents/restore' : '/api/documents/scope/restore')),
      compact ? restore.tap() : restore.click(),
    ])
    expect(restoreResponse.status()).toBe(200)
    await restore.waitFor({ state: 'detached' })
    expect(reads).toEqual(before)
    expect(restoreWrites).toBe(1)
    const restoredBack = restoredTrash.getByRole('button', { name: 'Back to documents', exact: true })
    holdRestoredListing = true
    try {
      if (compact) await restoredBack.tap()
      else await restoredBack.click()
      await restoredTrash.waitFor({ state: 'detached' })
      await restoredListingRequested.promise
      const loadingSelector = '[data-documents-panel] > [role="status"][aria-live="polite"]'
      const loading = manager.locator(loadingSelector)
      await loading.waitFor({ state: 'visible' })
      expect(await loading.count()).toBe(1)
      expect(await loading.innerText()).toBe('Loading documents')
      expect(await manager.getByText('No documents uploaded yet', { exact: true }).count()).toBe(0)
      expect(await manager.getByText('0 documents', { exact: true }).count()).toBe(0)
      expect(await breadcrumb.getAttribute('aria-current')).toBe('page')
      expect(await returnTarget.evaluate(node => node === document.activeElement)).toBe(true)
      await compareOrRefreshGolden(LOADING_EXPECTED, await captureStableAria(page, loadingSelector, scaffold.workspaceCwd), MODE)
      releaseRestoredListing.resolve(undefined)
      await manager.locator('[data-documents-list]').getByText(restoredFile.name, { exact: true }).waitFor()
      expect(await loading.count()).toBe(0)
      expect(reads.slice(before.length)).toEqual([{
        path: target === 'personal' ? '/api/documents' : '/api/documents/scope',
        scope: target === 'personal' ? null : 'project:41', directory: directoryId,
      }])
      expect(await breadcrumb.getAttribute('aria-current')).toBe('page')
      expect(await returnTarget.evaluate(node => node === document.activeElement)).toBe(true)
      expect(await manager.count()).toBe(1)
      if (target === 'project') await manager.getByRole('status').getByText('Upload target: Compiler', { exact: true }).waitFor()
      else {
        expect((await scaffold.ctx.userDocs.listDirectory(UserDocDirectoryId(directoryId))).documents
          .some(row => row.docId === restoredFile.docId)).toBe(true)
        const stored = await scaffold.ctx.userDocs.read(UserDocId(restoredFile.docId))
        expect(new TextDecoder().decode(stored.data)).toBe('real Host restore\n')
      }
      console.info('[document-trash-return]', JSON.stringify({ label, target, before, after: reads, restoreWrites }))
      expect(tripwire.warnings).toEqual([])
    } finally {
      releaseRestoredListing.resolve(undefined)
      await page.unrouteAll({ behavior: 'wait' })
    }
  })

  it('desktop: pages a 21-file list and shows the oldest file on page two', async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-manager-desktop-paged'))
    await mockDocuments(page, PAGED_PAYLOAD)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
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
    await page.route(/\/account\/api\/context(?:\?.*)?$/, async (route) => {
      await route.fulfill({ json: {
        scope: { kind: 'personal' },
        projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }],
      } })
    })
    await page.route(/\/api\/documents\/transfer\/list(?:\?.*)?$/, async (route) => {
      await route.fulfill({ json: {
        version: 1,
        scope: { kind: 'project', label: 'Compiler' },
        documents: [{ docId: 'shared.txt', name: 'shared.txt', bytes: 7, mediaType: 'text/plain', modifiedAt: 1 }],
      } })
    })
    let popupOpened = false
    page.on('popup', () => { popupOpened = true })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Document Manager' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: /Compiler/ }).waitFor({ timeout: 10_000 })
    const beforeUrl = page.url()
    await dialog.getByRole('button', { name: /Compiler/ }).click()
    await dialog.getByRole('status').getByText('Upload target: Compiler', { exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByText('shared.txt', { exact: true }).waitFor({ timeout: 10_000 })
    expect(page.url()).toBe(beforeUrl)
    expect(await page.getByRole('dialog').count()).toBe(1)
    expect(popupOpened).toBe(false)
  }, 60_000)

  it('desktop: uploads directly to a writable selected scope without reloading the page', async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-manager-target-upload'))
    await mockDocuments(page)
    await page.route(/\/account\/api\/context(?:\?.*)?$/, async (route) => {
      await route.fulfill({ json: {
        scope: { kind: 'personal' },
        projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }],
      } })
    })
    await page.route(/\/api\/documents\/transfer\/list(?:\?.*)?$/, async (route) => {
      await route.fulfill({ json: {
        version: 1,
        scope: { kind: 'project', label: 'Compiler' },
        documents: [{ docId: 'shared.txt', name: 'shared.txt', bytes: 7, mediaType: 'text/plain', modifiedAt: 1 }],
      } })
    })
    const uploadRequests: string[] = []
    await page.route('**/api/documents/transfer/uploads**', async (route) => {
      const request = route.request()
      uploadRequests.push(`${request.method()} ${new URL(request.url()).pathname}?${new URL(request.url()).searchParams.toString()}`)
      const url = new URL(request.url())
      if (request.method() === 'POST' && url.pathname.endsWith('/complete')) {
        await route.fulfill({ json: {
          uploadId: '00000000-0000-4000-8000-000000000000', name: 'target.txt', directoryId: '', bytes: 6,
          fingerprint: 'fixture', chunkBytes: 8 * 1024 * 1024, receivedBytes: 6, expiresAt: Date.now() + 60_000,
          state: 'complete', ref: { docId: 'target.txt', name: 'target.txt', bytes: 6, mediaType: 'text/plain', modifiedAt: 2, path: '' },
        } })
        return
      }
      if (request.method() === 'PUT') {
        await route.fulfill({ json: { state: 'uploading', receivedBytes: 6 } })
        return
      }
      await route.fulfill({ json: {
        uploadId: '00000000-0000-4000-8000-000000000000', name: 'target.txt', directoryId: '', bytes: 6,
        fingerprint: 'fixture', chunkBytes: 8 * 1024 * 1024, receivedBytes: 0, expiresAt: Date.now() + 60_000, state: 'uploading',
      } })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Document Manager' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: /Compiler/ }).click()
    await dialog.getByRole('status').getByText('Upload target: Compiler', { exact: true }).waitFor({ timeout: 10_000 })
    const beforeUrl = page.url()
    await dialog.locator('input[type="file"]').setInputFiles({ name: 'target.txt', mimeType: 'text/plain', buffer: Buffer.from('target') })
    await expect.poll(() => uploadRequests.some(request => request.startsWith('POST /api/documents/transfer/uploads?'))).toBe(true)
    await expect.poll(() => uploadRequests.some(request => request.includes('scope=project%3A41'))).toBe(true)
    expect(page.url()).toBe(beforeUrl)
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
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Document Manager' })
    await dialog.waitFor({ timeout: 10_000 })

    const rowMore = dialog.getByRole('button', { name: 'More actions: brief.txt' })
    const name = dialog.getByText('brief.txt', { exact: true })
    await Promise.all([
      name.waitFor(),
      dialog.getByRole('status').getByText('Project scopes could not be refreshed; showing the last result', { exact: true }).waitFor(),
    ])
    await name.scrollIntoViewIfNeeded()
    const { dialogBox, searchBox, uploadBox, scopeBox, moreBox, nameBox, rowMoreBox } = await dialog.evaluate((root) => {
      const box = (element: Element | null) => {
        const rect = element?.getBoundingClientRect()
        return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
      return {
        dialogBox: box(root),
        searchBox: box(root.querySelector('input[placeholder="Search document name"]')),
        uploadBox: box(root.querySelector('button[aria-label="Upload Document"]')),
        scopeBox: box(root.querySelector('[data-documents-scope-trigger]')),
        moreBox: box(root.querySelector('[data-documents-toolbar-more]')),
        nameBox: box(root.querySelector('[title="brief.txt"]')),
        rowMoreBox: box(root.querySelector('button[aria-label="More actions: brief.txt"]')),
      }
    })
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
    // The phone toolbar is one track: the search field flexes beside the
    // upload/more pair rather than stacking on its own line, so their
    // vertical intervals overlap even though the field is shorter.
    expect(searchBox.y).toBeLessThan(uploadBox.y + uploadBox.height)
    expect(uploadBox.y).toBeLessThan(searchBox.y + searchBox.height)
    expect(scopeBox.height).toBeGreaterThanOrEqual(44)
    // Toolbar controls floor at the shared 40px coarse input height; only
    // list rows and their trailing affordance keep the 44px target.
    expect(moreBox.height).toBeGreaterThanOrEqual(40)
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
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Document Manager' })
    await dialog.waitFor({ timeout: 10_000 })

    const upload = dialog.getByRole('button', { name: 'Upload Document' })
    const more = dialog.locator('[data-documents-toolbar-more]')
    // Measure all four boxes in one synchronous pass: sequential boundingBox
    // calls observe different layouts while the dialog still settles, and on a
    // loaded runner upload/more can read rows apart mid-reflow.
    const boxes = await page.evaluate(() => {
      const box = (el: Element | null | undefined) => {
        const rect = el?.getBoundingClientRect()
        return rect === undefined ? null
          : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find(el => el.getAttribute('aria-label') === 'Document Manager')
      return {
        dialogBox: box(dialog),
        searchBox: box(dialog?.querySelector('input[placeholder="Search document name"]')),
        uploadBox: box(dialog && [...dialog.querySelectorAll('button')]
          .find(el => el.getAttribute('aria-label') === 'Upload Document'
            || el.textContent?.includes('Upload Document'))),
        moreBox: box(dialog?.querySelector('[data-documents-toolbar-more]')),
      }
    })
    const { dialogBox, searchBox, uploadBox, moreBox } = boxes
    if ([dialogBox, searchBox, uploadBox, moreBox].some(box => box === null)) {
      throw new Error('document manager narrow geometry missing')
    }
    // Filters collapse into the more sheet; the search field keeps a usable
    // touch width while sharing the single action track.
    expect(searchBox!.width).toBeGreaterThan(44)
    expect(await dialog.locator('select').count()).toBe(0)
    expect(searchBox!.y).toBeLessThan(uploadBox!.y + uploadBox!.height)
    expect(uploadBox!.y).toBeLessThan(searchBox!.y + searchBox!.height)
    expect(Math.round(uploadBox!.y)).toBe(Math.round(moreBox!.y))
    for (const box of [uploadBox!, moreBox!]) {
      expect(box.height).toBeGreaterThanOrEqual(40)
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
    await page.route(/\/account\/api\/context(?:\?.*)?$/, async (route) => {
      await route.fulfill({ json: {
        scope: { kind: 'personal' },
        projects: [
          { projectId: 41, name: 'Compiler', mode: 'ro' },
          { projectId: 42, name: 'Payments', mode: 'rw' },
        ],
      } })
    })
    await page.route(/\/api\/documents\/transfer\/list(?:\?.*)?$/, async (route) => {
      await route.fulfill({ json: {
        version: 1,
        scope: { kind: 'project', label: 'Compiler' },
        documents: [{ docId: 'shared.txt', name: 'shared.txt', bytes: 7, mediaType: 'text/plain', modifiedAt: 1 }],
      } })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
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
    await page.route(/\/account\/api\/context(?:\?.*)?$/, async (route) => {
      await route.fulfill({ json: {
        scope: { kind: 'personal' },
        projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }],
      } })
    })
    await page.route('**/api/documents/overview**', async (route) => {
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
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
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
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
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

  it('commits exactly the document-manager ARIA expected-output inventory', async () => {
    await assertFixtureInventory(EXPECTED_DIR, ['trash-header.expected.md', 'loading.expected.md'])
  })
})
