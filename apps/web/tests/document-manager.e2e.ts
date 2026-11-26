/**
 * Document manager chrome through the shipped Web composition: desktop list
 * dialog with inline preview, compact bottom sheet, target-scope upload, and a paged 21-file list.
 * Keyless: chrome cases use fixture document lists. Trash navigation exercises
 * real personal Host storage and a controlled project broker. Upload batches
 * use real Host requests with one completion delivery held; no model turns
 * are required.
 */
import { responsiveBrowser, responsiveBrowserName, responsiveMobileEmulation, responsiveViewports, expectViewportFit } from './responsive-browser.ts'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { appendFile, readFile, readdir, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { Browser, Locator, Page } from 'playwright'

import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import type { UserDocRef } from '@deepseek-ai/dsh-userdoc'
import { UserDocDirectoryId, UserDocId } from '@deepseek-ai/dsh-userdoc'
import { pdfFixture } from '../../../packages/client/ui-workbench/tests/pdf-fixture.ts'
import {
  assertFixtureInventory, captureStableAria,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { revealDocumentZoom, saveFailureShot } from './support.ts'
import { auditWorkflowState, compareWorkflowGolden as compareOrRefreshGolden, workflowMatrixEnabled, workflowTouchOptions } from './workflow-responsive-state.ts'
import { auditResponsiveControl, auditResponsiveControls } from './responsive-controls.ts'
import { captureTextContrast, expectTextContrast } from './text-contrast.ts'

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
const UPLOAD_EMPTY_EXPECTED = join(EXPECTED_DIR, 'upload-empty.expected.md')
const UPLOAD_PUBLISHED_EXPECTED = join(EXPECTED_DIR, 'upload-published.expected.md')
const UPLOAD_PARTIAL_EXPECTED = join(EXPECTED_DIR, 'upload-partial.expected.md')
const UPLOAD_RECOVERY_EXPECTED = join(EXPECTED_DIR, 'upload-recovery.expected.md')
const SHORT_TOOLS_EXPECTED = join(EXPECTED_DIR, 'short-tools.expected.md')
const TRASH_CONFLICT_EXPECTED = join(SNAPSHOT_DIR, 'trash-conflict.expected.md')
const MODE = webSnapshotMode()
const previewViewports: { label: string; width: number; height: number }[] = workflowMatrixEnabled
  ? responsiveViewports.map(({ name, width, height }) => ({ label: name, width, height }))
  : [{ label: 'desktop', width: 1280, height: 800 }, { label: 'compact', width: 390, height: 844 }]
const previewCases = previewViewports.flatMap(viewport => (['default', 'without-native'] as const).map(reader => ({ ...viewport, reader })))

async function verifyApplicationPdf(preview: Locator): Promise<void> {
  for (const number of [1, 2]) {
    const page = preview.locator(`[data-pdf-page="${number}"]`)
    await page.scrollIntoViewIfNeeded()
    await page.locator('[data-pdf-text]').getByText('Selectable PDF text', { exact: true }).waitFor()
    const canvas = page.locator('canvas')
    await canvas.waitFor({ state: 'visible' })
    expect(await canvas.evaluate((element: HTMLCanvasElement) => {
      if (element.width === 0 || element.height === 0) return false
      const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
      return pixels.some((value, index) => index % 4 !== 3 && value < 200)
    })).toBe(true)
  }
}

async function expectInitialDocumentsContent(page: Page, manager: Locator, contents: readonly Locator[], viewports: 'short' | 'all' = 'short'): Promise<void> {
  const viewport = page.viewportSize()!
  if (viewports === 'short' && viewport.height > 480) return
  await manager.evaluate((element) => {
    for (const node of [element, ...element.querySelectorAll('*')]) node.scrollTop = 0
  })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => {
    requestAnimationFrame(() => { resolve() })
  })))
  await expect.poll(() => manager.evaluate((element) => {
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      if (node.getAnimations().some(animation => animation.playState === 'running'
        && typeof animation.effect?.getComputedTiming().endTime === 'number'
        && Number.isFinite(animation.effect.getComputedTiming().endTime))) return true
    }
    return false
  }), { message: 'Document entrance animation settles before initial geometry' }).toBe(false)
  const header = await manager.locator('header').first().boundingBox()
  expect(header).not.toBeNull()
  const geometry = []
  for (const content of contents) {
    const bounds = await content.boundingBox()
    const label = await content.getAttribute('aria-label') ?? await content.textContent()
    expect(bounds, label ?? 'Initial document content').not.toBeNull()
    const clip = await content.evaluate((element) => {
      let top = 0, bottom = innerHeight, left = 0, right = innerWidth
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node), rect = node.getBoundingClientRect()
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom) }
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right) }
      }
      return { top, bottom, left, right }
    })
    const receipt = { label, bounds, viewport, clip }
    expect(bounds!.height, JSON.stringify(receipt)).toBeGreaterThan(0)
    expect(bounds!.y, JSON.stringify(receipt)).toBeGreaterThanOrEqual(Math.max(clip.top, header!.y + header!.height) - 1)
    expect(bounds!.y + bounds!.height, JSON.stringify(receipt)).toBeLessThanOrEqual(clip.bottom + 1)
    expect(bounds!.x, JSON.stringify(receipt)).toBeGreaterThanOrEqual(clip.left - 1)
    expect(bounds!.x + bounds!.width, JSON.stringify(receipt)).toBeLessThanOrEqual(clip.right + 1)
    geometry.push(receipt)
  }
  console.info('[documents-initial-visibility]', JSON.stringify(geometry))
}

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


async function assertTooltipInsideManager(page: Page, manager: ReturnType<Page['getByRole']>, label: string): Promise<void> {
  await manager.getByRole('button', { name: label, exact: true }).hover()
  const tooltip = page.getByRole('tooltip', { name: label, exact: true })
  await tooltip.waitFor({ state: 'visible' })
  const bubble = await tooltip.boundingBox()
  const bounds = await manager.boundingBox()
  if (bubble === null || bounds === null) throw new Error('Document tooltip geometry unavailable')
  expect(bubble.x).toBeGreaterThanOrEqual(bounds.x)
  expect(bubble.y).toBeGreaterThanOrEqual(bounds.y)
  expect(bubble.x + bubble.width).toBeLessThanOrEqual(bounds.x + bounds.width)
  expect(bubble.y + bubble.height).toBeLessThanOrEqual(bounds.y + bounds.height)
  await page.mouse.move(0, 0)
  await tooltip.waitFor({ state: 'hidden' })
}
async function assertRowActionClearance(page: Page, manager: ReturnType<Page['getByRole']>, width: number): Promise<void> {
  await manager.evaluate(async element => Promise.allSettled(element.getAnimations().map(animation => animation.finished)))
  const controls = manager.locator('[data-documents-row-kind] button[aria-label^="More actions:"]')
  expect(await controls.count()).toBeGreaterThan(0)
  for (const button of await controls.all()) {
    const name = await button.getAttribute('aria-label')
    if (name?.startsWith('More actions:') !== true) continue
    await button.focus()
    // macOS WebKit uses Option-Tab for buttons without the system-wide full keyboard access preference.
    const modifier = process.platform === 'darwin' && responsiveBrowserName === 'webkit' ? 'Alt+' : ''
    await button.press(`${modifier}Tab`)
    await page.keyboard.press(`${modifier}Shift+Tab`)
    if (width >= 768) await button.hover()
    const box = await button.evaluate((element) => {
      const row = element.closest('[data-documents-row-kind]')!
      const a = element.getBoundingClientRect(), b = row.getBoundingClientRect()
      return { rightClearance: b.right-a.right, leftClearance: a.left-b.left, width: a.width, height: a.height,
        outlineOffset: getComputedStyle(element).outlineOffset, focusVisible: element.matches(':focus-visible') }
    })
    expect(box.focusVisible).toBe(true)
    expect(Number.parseFloat(box.outlineOffset)).toBeLessThanOrEqual(0)
    expect(box.rightClearance).toBeGreaterThanOrEqual(7.5)
    expect(box.leftClearance).toBeGreaterThanOrEqual(0)
    expect(box.width).toBeGreaterThanOrEqual(width === 390 ? 44 : 32)
    expect(box.height).toBeGreaterThanOrEqual(width === 390 ? 44 : 32)
  }
}

describe('web e2e: document manager', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let previewDocument: UserDocRef
  let tripwire: ReturnType<typeof watchConsole> = { warnings: [], pageErrors: [] }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ workbench: true })
    const target = await scaffold.ctx.userDocs.resolveTarget({ name: 'preview-layout.pdf' })
    previewDocument = await scaffold.ctx.userDocs.save(target, new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(pdfFixture(6)); controller.close() },
    }))
    browser = await responsiveBrowser.launch(responsiveBrowserName === 'chromium' ? { channel: 'chromium' } : {})
  }, 120_000)

  afterEach(async ({ task }) => {
    try {
      if (task.result?.state === 'fail' && page && !page.isClosed()) {
        await saveFailureShot(page, `document-manager-${page.viewportSize()?.width}`)
      }
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

  it('compact: resolves computer-owned upload targets and clears denied document rows', async () => {
    page = await browser.newPage({ ...workflowTouchOptions, viewport: { width: 390, height: 844 }, locale: 'en-US', hasTouch: true, isMobile: responsiveMobileEmulation })
    tripwire = watchConsole(page)
    const local = '10000000-0000-4000-8000-000000000001'
    const remote = '10000000-0000-4000-8000-000000000002'
    let releaseLocations!: () => void
    const locationGate = new Promise<void>((resolve) => { releaseLocations = resolve })
    let denied = false
    const requests: string[] = []
    const metadataReads: string[] = []
    page.on('request', (request) => { if (request.url().includes('/account/api/')) metadataReads.push(new URL(request.url()).pathname) })
    await page.route('**/account/api/deployment/context*', route => route.fulfill({ json: {
      mode: 'multi', revision: '1', entry: { nodeId: local, name: 'Local computer' },
      primary: { nodeId: local, name: 'Local computer', origin: new URL(scaffold.authenticatedUrl).origin },
      role: 'primary', scope: 'organization', refreshAfterMs: 30000, legacyMigrationRequired: false,
    } }))
    await page.route('**/account/api/context*', route => route.fulfill({ json: {
      scope: { kind: 'personal' }, user: { id: 7 }, environment: { nodeId: local, nodeName: 'Local computer' },
    } }))
    await page.route('**/account/api/document-locations*', async (route) => {
      await locationGate
      await route.fulfill({ json: { items: [
        { scope: { kind: 'personal', nodeId: local }, name: 'Personal', nodeName: 'Local computer', mode: 'rw' },
        { scope: { kind: 'project', projectId: 41, nodeId: remote }, name: '#41', metadataOnNode: true, nodeName: 'Remote computer', mode: 'rw' },
      ], nextCursor: null } })
    })
    await page.route('**/account/api/project-metadata*', async (route) => {
      const url = new URL(route.request().url())
      expect(url.searchParams.get('dshNode')).toBe(remote)
      expect(url.searchParams.get('ids')).toBe('41')
      await route.fulfill({ json: { items: [{ projectId: 41, nodeId: remote, name: 'Isolated research' }] } })
    })
    await page.route(/\/api\/documents\/overview(?:\?.*)?$/, route => route.fulfill({ json: {
      version: 1, documents: [],
      metrics: { total: 0, active: 0, deleted: 0, personal: 0, project: 0, bytes: 0, operations24h: 0, failures24h: 0 },
    } }))
    await page.route(/\/api\/documents\/scope(?:\?.*)?$/, async (route) => {
      const url = new URL(route.request().url())
      expect(url.searchParams.get('scope')).toBe('project:41')
      expect(url.searchParams.get('dshNode')).toBe(remote)
      requests.push(denied ? 'denied' : 'read')
      if (denied) {
        await route.fulfill({ status: 403, json: { error: { code: 'COLLABORATION_FORBIDDEN', message: 'Project access revoked' } } })
        return
      }
      const response = await scaffold.hostFetch('/api/documents?directory=')
      const body: unknown = await response.json()
      await route.fulfill({ status: response.status, json: body })
    })
    try {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
      await page.getByRole('button', { name: 'Documents', exact: true }).click()
      const manager = page.getByRole('dialog', { name: 'Document Manager', exact: true })
      await manager.getByText('preview-layout.pdf', { exact: true }).waitFor()
      releaseLocations()
      await manager.locator('[data-documents-scope-trigger]').click()
      const scopeSheet = page.getByRole('dialog', { name: 'Choose document scope', exact: true })
      await scopeSheet.getByRole('button', { name: /Isolated research/ }).waitFor()
      await scopeSheet.getByRole('button', { name: /All accessible documents/ }).click()
      await manager.getByRole('button', { name: 'Choose upload scope', exact: true }).click()
      const upload = page.getByRole('dialog', { name: 'Choose upload scope', exact: true })
      await upload.getByRole('button', { name: /Isolated research/ }).waitFor()
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'computer-upload-targets.expected.md'),
        await captureStableAria(page, '[data-documents-sheet="scope-upload"]', scaffold.workspaceCwd), MODE)
      await upload.getByRole('button', { name: /Isolated research/ }).click()
      await manager.getByText('preview-layout.pdf', { exact: true }).waitFor()
      denied = true
      await manager.locator('[data-documents-toolbar-more]').click()
      await page.locator('[data-documents-sheet="toolbar-more"]').getByRole('button', { name: 'Refresh', exact: true }).click()
      await manager.getByText('Project access revoked', { exact: true }).waitFor()
      expect(await manager.getByText('preview-layout.pdf', { exact: true }).count()).toBe(0)
      expect(await manager.getByRole('button', { name: 'Upload Document', exact: true }).isDisabled()).toBe(true)
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'computer-scope-denied.expected.md'),
        await captureStableAria(page, '[role="dialog"][aria-label="Document Manager"]', scaffold.workspaceCwd), MODE)
      await auditWorkflowState(page, 'documents', 'computer-access-denied', manager)
      expect(requests).toEqual(['read', 'denied'])
      expect(metadataReads.filter(path => path === '/account/api/project-metadata')).toHaveLength(1)
    } finally { releaseLocations() }
  })

  it.each(previewCases)('$label: $reader PDF preview fills its available body and releases the reader on close', async ({ label, width, height, reader }) => {
    const compact = width < 768
    const fullScreen = compact || width <= 1100 && height <= 480
    page = await browser.newPage({ ...workflowTouchOptions,
      viewport: { width, height }, locale: 'en-US', reducedMotion: 'reduce',
      ...(compact ? { hasTouch: true, isMobile: responsiveMobileEmulation } : {}),
    })
    if (reader === 'without-native') await page.addInitScript(() => {
      Object.defineProperty(navigator, 'pdfViewerEnabled', { configurable: true, value: false })
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
    // Response headers prove the content route served; a fetched response can be
    // aborted after delivery (reader lifecycle), which leaves finished() pending
    // forever, so readiness below comes from the rendered reader itself.
    expect([200, 206]).toContain((await response).status())
    const preview = fullScreen
      ? page.getByRole('dialog', { name: `Preview: ${previewDocument.name}`, exact: true })
      : manager.getByRole('complementary', { name: `Preview: ${previewDocument.name}`, exact: true })
    const frame = preview.locator('[data-document-pdf-host]')
    await frame.waitFor({ state: 'visible' })
    const close = preview.getByRole('button', { name: fullScreen ? 'Back to documents' : 'Close preview', exact: true })
    const output = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
    const expectHeaderVisible = async (): Promise<void> => {
      if (!fullScreen) return
      for (const control of [preview.getByRole('heading', { name: previewDocument.name, exact: true }), close]) {
        const bounds = await control.boundingBox()
        expect(bounds).not.toBeNull()
        expect(bounds!.x).toBeGreaterThanOrEqual(-1)
        expect(bounds!.y).toBeGreaterThanOrEqual(-1)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height + 1)
      }
      expect(await close.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return hit !== null && element.contains(hit)
      }), 'Preview Back control remains directly reachable').toBe(true)
    }
    await expectHeaderVisible()
    expect(await preview.locator('iframe').count()).toBe(0)
    const pdfViewerEnabled = await page.evaluate(() => navigator.pdfViewerEnabled)
    if (output) {
      await mkdir(output, { recursive: true })
      await page.screenshot({ path: join(output, `${responsiveBrowserName}-document-pdf-${reader}-${label}-start.png`), animations: 'disabled' })
    }
    await verifyApplicationPdf(preview)
    const geometry = await preview.evaluate((container) => {
      const element = container.querySelector('[data-document-pdf-host]')!
      const body = element.parentElement!
      const box = (node: Element) => {
        const rect = node.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }
      }
      const bodyBox = box(body)
      const style = getComputedStyle(body)
      const paddingTop = Number.parseFloat(style.paddingTop)
      const paddingBottom = Number.parseFloat(style.paddingBottom)
      const availableBody = {
        height: body.clientHeight - paddingTop - paddingBottom,
        bottom: bodyBox.y + body.clientTop + body.clientHeight - paddingBottom,
      }
      return {
        frame: box(element), body: bodyBox, availableBody, container: box(container),
        scrollWidth: container.scrollWidth, clientWidth: container.clientWidth,
      }
    })
    expect(geometry.availableBody.height).toBeGreaterThan(Math.min(300, height * 0.2))
    expect(geometry.frame.height, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.availableBody.height - 2)
    expect(geometry.frame.bottom).toBeLessThanOrEqual(geometry.availableBody.bottom + 1)
    expect(geometry.container.x).toBeGreaterThanOrEqual(-1)
    expect(geometry.container.y).toBeGreaterThanOrEqual(-1)
    expect(geometry.container.right).toBeLessThanOrEqual(width + 1)
    expect(geometry.container.bottom).toBeLessThanOrEqual(height + 1)
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
    await close.waitFor({ state: 'visible' })
    await expectViewportFit(page, preview, [close])
    await (await revealDocumentZoom(page, preview)).focus()
    await auditResponsiveControls(page, preview, 'document PDF preview')
    await expectHeaderVisible()
    if (output) {
      await page.screenshot({ path: join(output, `${responsiveBrowserName}-document-pdf-${reader}-${label}-actions.png`), animations: 'disabled' })
    }
    await auditResponsiveControl(page, frame, 'document PDF reading area')
    await auditResponsiveControl(page,
      preview.locator('[data-pdf-page="2"] [data-pdf-text]').getByText('Selectable PDF text', { exact: true }),
      'document PDF second-page text')
    if (output) {
      await page.screenshot({ path: join(output, `${responsiveBrowserName}-document-pdf-${reader}-${label}.png`) })
      await appendFile(join(output, 'document-pdf.jsonl'), JSON.stringify({
        engine: responsiveBrowserName, width, height, state: 'pdf-preview', reader, status: 'passed',
        actualReader: 'application', pdfViewerEnabled,
      }) + '\n')
    }
    if (fullScreen) await close.click()
    else {
      await close.focus()
      await page.keyboard.press('Escape')
    }
    await preview.waitFor({ state: 'detached' })
    expect(await page.locator('iframe, [data-document-pdf-host]').count()).toBe(0)
    await expect.poll(() => page.frames().length).toBe(initialFrames)
    expect(await manager.count()).toBe(1)
  })

  it.each([768, 1280, 1440])('keeps upload information inside the document dialog at %ipx', async (width) => {
    page = await browser.newPage({ ...workflowTouchOptions, viewport: { width, height: 800 }, locale: 'en-US', reducedMotion: 'reduce' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, `web-e2e-document-tooltip-${String(width)}`))
    await mockDocuments(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'Document Manager', exact: true })
    await manager.getByText('brief.txt', { exact: true }).waitFor()
    const trigger = manager.getByRole('button', { name: 'Upload information', exact: true })
    if (workflowMatrixEnabled) await trigger.tap()
    else {
      await assertTooltipInsideManager(page, manager, 'Upload information')
      await trigger.click()
    }
    const information = page.getByRole('dialog', { name: 'Upload information', exact: true })
    await information.waitFor()
    if (width === 1280) await auditWorkflowState(page, 'documents', 'upload-information', information)
    await information.getByRole('button', { name: 'Close', exact: true }).click()
    await expect.poll(() => manager.isVisible()).toBe(true)
  }, workflowMatrixEnabled ? 180_000 : 60_000)

  it('desktop: lists folders and date groups with named row actions in a centered dialog', async () => {
    page = await browser.newPage({ ...workflowTouchOptions, viewport: { width: 1280, height: 800 }, locale: 'en-US' })
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
    await page.route(/\/api\/documents\/content(?:\?.*)?$/, async (route) => {
      await route.fulfill({ contentType: 'text/plain', body: 'Preview fixture for the document manager.' })
    })
    await dialog.getByRole('button', { name: 'Preview brief.txt', exact: true }).click()
    const preview = dialog.getByRole('complementary', { name: 'Preview: brief.txt' })
    await preview.getByText('Preview fixture for the document manager.', { exact: true }).waitFor()
    expect(await dialog.getByRole('checkbox', { name: 'brief.txt', exact: true }).isChecked()).toBe(false)
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DESKTOP_EXPECTED, snapshot, MODE)
  }, workflowMatrixEnabled ? 180_000 : 60_000)

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
    page = await browser.newPage({ ...workflowTouchOptions,
      viewport: { width, height }, locale: 'en-US', reducedMotion: 'reduce',
      ...(compact ? { hasTouch: true, isMobile: responsiveMobileEmulation } : {}),
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
        await page.locator('[data-documents-sheet="scope-view"]').getByRole('button', { name: /Compiler/ }).tap()
      } else await manager.getByRole('button', { name: /Compiler/ }).click()
      if (compact) await manager.locator('[data-documents-scope-trigger]').getByText('Compiler', { exact: true }).waitFor()
      else await manager.getByText('Upload target: Compiler', { exact: true }).filter({ visible: true }).waitFor()
    }
    const folderName = target === 'personal' ? `trash-return-${label}` : 'reports'
    const folder = manager.getByRole('button', { name: `Open folder ${folderName}`, exact: true })
    if (compact) await folder.tap()
    else await folder.click()
    const breadcrumb = manager.getByRole('navigation', { name: 'Document path', exact: true })
      .getByRole(compact ? 'heading' : 'button', { name: folderName, exact: true })
    await expect.poll(() => breadcrumb.getAttribute('aria-current')).toBe('page')
    await manager.getByText('No documents uploaded yet', { exact: true }).waitFor()
    const before = [...reads]
    const enterTrash = async () => {
      if (compact) {
        await manager.locator('[data-documents-toolbar-more]').tap()
        await page.locator('[data-documents-sheet="toolbar-more"]').getByRole('button', { name: 'Trash', exact: true }).tap()
      } else await manager.locator('[data-documents-trash-toggle]').click()
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
    if (label === 'desktop') await auditWorkflowState(page, 'documents', `${target}-trash`, manager)
    await back.focus()
    await page.keyboard.press('Enter')
    await trash.waitFor({ state: 'detached' })
    await expect.poll(() => breadcrumb.getAttribute('aria-current')).toBe('page')
    const returnTarget = compact ? manager.locator('[data-documents-toolbar-more]')
      : manager.locator('[data-documents-trash-toggle]')
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
      const loadingSelector = '[data-documents-browse-body] > [role="status"][aria-live="polite"]'
      const loading = manager.locator(loadingSelector)
      await loading.waitFor({ state: 'visible' })
      expect(await loading.count()).toBe(1)
      expect(await loading.innerText()).toBe('Loading documents')
      expect(await manager.getByText('No documents uploaded yet', { exact: true }).count()).toBe(0)
      expect(await manager.getByText(/\b0 documents$/u).count()).toBe(0)
      expect(await breadcrumb.getAttribute('aria-current')).toBe('page')
      expect(await returnTarget.evaluate(node => node === document.activeElement)).toBe(true)
      await compareOrRefreshGolden(LOADING_EXPECTED, await captureStableAria(page, loadingSelector, scaffold.workspaceCwd), MODE)
      if (label === 'desktop') {
        await auditWorkflowState(page, 'documents', `${target}-restored-list-loading`, manager, [], undefined, async () => {
          const overflow = await manager.evaluate((element) => {
            const content = element.querySelector('[data-documents-panel]')!.parentElement!
            return content.scrollWidth - content.clientWidth
          })
          expect(overflow, 'Location permissions remain readable without horizontal scrolling').toBeLessThanOrEqual(1)
        })
        // Compact navigation replaces the original trigger during the viewport sweep.
        await returnTarget.focus()
      }
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
      if (target === 'project') {
        if (compact) await manager.locator('[data-documents-scope-trigger]').getByText('Compiler', { exact: true }).waitFor()
        else await manager.getByText('Upload target: Compiler', { exact: true }).filter({ visible: true }).waitFor()
      }
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
  it('desktop: reports a real reused-path trash conflict and preserves both documents', async () => {
    const name = 'reused-path-audit.txt'
    const upload = async (text: string): Promise<string> => {
      const digest = createHash('sha256').update(text).digest('hex')
      const started = await scaffold.hostFetch('/api/documents/uploads', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, name, directory: '', bytes: text.length, fingerprint: digest }),
      })
      expect(started.status).toBe(200)
      const session = await started.json() as { uploadId: string }
      const path = `/api/documents/uploads/${session.uploadId}`
      const chunk = await scaffold.hostFetch(`${path}/chunks/0`, {
        method: 'PUT', headers: { 'content-range': `bytes 0-${text.length - 1}/${text.length}`, 'x-dsh-chunk-sha256': digest }, body: text,
      })
      expect(chunk.status).toBe(200)
      expect((await scaffold.hostFetch(`${path}/complete`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, sha256: digest }),
      })).status).toBe(202)
      let completed: { state: string; ref?: { docId: string } } | undefined
      await expect.poll(async () => {
        const response = await scaffold.hostFetch(path)
        completed = await response.json() as NonNullable<typeof completed>
        return completed.state
      }).toBe('complete')
      return completed!.ref!.docId
    }
    const original = await upload('old')
    expect((await scaffold.hostFetch(`/api/documents/trash?id=${encodeURIComponent(original)}`, { method: 'POST' })).status).toBe(200)
    expect(await upload('new')).toBe(original)
    page = await browser.newPage({ ...workflowTouchOptions, viewport: { width: 1280, height: 800 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-trash-conflict'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'Document Manager' })
    await manager.getByRole('button', { name: `More actions: ${name}`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    const response = page.waitForResponse(item => new URL(item.url()).pathname === '/api/documents/trash' && item.request().method() === 'POST')
    await page.getByRole('dialog', { name: 'Confirm Deletion' }).getByRole('button', { name: 'Confirm Delete' }).click()
    expect((await response).status()).toBe(409)
    await page.getByRole('alert').getByText('An older document remains in trash at this path.', { exact: false }).waitFor()
    expect(await manager.getByText(name, { exact: true }).count()).toBe(1)
    await compareOrRefreshGolden(TRASH_CONFLICT_EXPECTED, await captureStableAria(page, '[role="alert"]', scaffold.workspaceCwd), MODE)
    await auditWorkflowState(page, 'documents', 'reused-path-trash-conflict', manager)
    expect(await readFile(join(scaffold.documentRoot, original), 'utf8')).toBe('new')
    const restored = await scaffold.hostFetch(`/api/documents/restore?id=${encodeURIComponent(original)}&name=saved-old-audit.txt`, { method: 'POST' })
    expect(restored.status).toBe(200)
    expect(await readFile(join(scaffold.documentRoot, 'saved-old-audit.txt'), 'utf8')).toBe('old')
    expect(await readFile(join(scaffold.documentRoot, original), 'utf8')).toBe('new')
  }, workflowMatrixEnabled ? 180_000 : 60_000)

  it.each(['light', 'dark'] as const)('%s: pages a 21-file list and shows the oldest file on page two', async (colorScheme) => {
    page = await browser.newPage({ ...workflowTouchOptions, viewport: { width: 1280, height: 800 }, locale: 'en-US', colorScheme })
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
    const checkbox = dialog.getByRole('checkbox', { name: 'f-01.txt', exact: true })
    const checkboxElement = await checkbox.elementHandle()
    if (checkboxElement === null) throw new Error('Paged document checkbox is missing')
    try {
      await checkbox.focus()
      const inspectPagedRow = async () => {
        expect(await checkboxElement.evaluate(node => node.isConnected && node === document.activeElement),
          'The same document checkbox keeps focus across viewport changes').toBe(true)
        const row = dialog.locator('[data-documents-row-kind="document"]').filter({ hasText: 'f-01.txt' })
        const bytes = row.getByText(/\b21 B\b/u).filter({ visible: true })
        await expect.poll(() => bytes.count(), { message: 'The visible document row includes its byte size exactly once' }).toBe(1)
        await expectInitialDocumentsContent(page, dialog, [row], 'all')
        await auditResponsiveControl(page, bytes, `documents/paged-library-${colorScheme}/file-size`)
      }
      await inspectPagedRow()
      await auditWorkflowState(page, 'documents', `paged-library-${colorScheme}`, dialog, [], inspectPagedRow)
    } finally {
      await checkboxElement.dispose()
    }
  }, workflowMatrixEnabled ? 180_000 : 60_000)

  it('desktop: switches the document scope in place without opening a runtime page', async () => {
    page = await browser.newPage({ ...workflowTouchOptions, viewport: { width: 1280, height: 800 }, locale: 'en-US' })
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
    await dialog.getByRole('heading', { name: 'Compiler', exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByText('shared.txt', { exact: true }).waitFor({ timeout: 10_000 })
    expect(page.url()).toBe(beforeUrl)
    expect(await page.getByRole('dialog').count()).toBe(1)
    expect(popupOpened).toBe(false)
  }, workflowMatrixEnabled ? 180_000 : 60_000)

  it('desktop: uploads directly to a writable selected scope without reloading the page', async () => {
    page = await browser.newPage({ ...workflowTouchOptions, viewport: { width: 1280, height: 800 }, locale: 'en-US' })
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
    await dialog.getByRole('heading', { name: 'Compiler', exact: true }).waitFor({ timeout: 10_000 })
    const beforeUrl = page.url()
    await dialog.locator('input[type="file"]').setInputFiles({ name: 'target.txt', mimeType: 'text/plain', buffer: Buffer.from('target') })
    await expect.poll(() => uploadRequests.some(request => request.startsWith('POST /api/documents/transfer/uploads?'))).toBe(true)
    await expect.poll(() => uploadRequests.some(request => request.includes('scope=project%3A41'))).toBe(true)
    expect(page.url()).toBe(beforeUrl)
  }, workflowMatrixEnabled ? 180_000 : 60_000)

  it.each(['success', 'partial-failure', 'catalog-recovery'] as const)(
    'desktop: shows real upload batch publication through a held completion: %s',
    async (outcome) => {
      const folderName = `u01-upload-${outcome}`
      const folder = await scaffold.ctx.userDocs.createDirectory(UserDocDirectoryId(''), folderName)
      onTestFinished(async () => {
        for (const document of (await scaffold.ctx.userDocs.listDirectory(folder.directoryId)).documents) {
          await scaffold.ctx.userDocs.trash(document.docId)
        }
        for (const document of await scaffold.ctx.userDocs.listTrash()) {
          if (document.directoryId === folder.directoryId) await scaffold.ctx.userDocs.purge(document.docId)
        }
        await scaffold.ctx.userDocs.removeDirectory(folder.directoryId)
        expect((await scaffold.ctx.userDocs.listDirectory(UserDocDirectoryId(''))).directories
          .some(directory => directory.directoryId === folder.directoryId)).toBe(false)
        console.info('[upload-batch-cleanup]', JSON.stringify({ outcome, removed: true }))
      })
      page = await browser.newPage({ ...workflowTouchOptions, viewport: { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce' })
      const fixtureTime = new Date(Date.UTC(2026, 9, 24, 12))
      await page.clock.setFixedTime(fixtureTime)
      tripwire = watchConsole(page)
      onTestFailed(() => saveFailureShot(page, `web-e2e-document-upload-batch-${outcome}`))
      const origin = new URL(scaffold.authenticatedUrl).origin
      const release = Promise.withResolvers<undefined>()
      let secondHeld = false
      let completions = 0
      let directoryReads = 0
      const startedFiles: string[] = []
      const pending = new Set<Promise<void>>()
      const failures: unknown[] = []
      page.on('request', (request) => {
        const url = new URL(request.url())
        if (url.origin !== origin) return
        if (request.method() === 'GET' && url.pathname === '/api/documents'
          && url.searchParams.get('directory') === folder.directoryId) directoryReads++
        if (request.method() === 'POST' && url.pathname === '/api/documents/uploads') {
          startedFiles.push((request.postDataJSON() as { name: string }).name)
        }
      })
      // File mtime supplies displayed dates independently of the browser clock.
      // Only this private folder's published files receive fixed fixture dates.
      await page.route((url: URL) => url.origin === origin && url.pathname === '/api/documents'
        && url.searchParams.get('directory') === folder.directoryId, async (route) => {
        try {
          if (route.request().method() === 'GET' && completions > 0) {
            const listing = await scaffold.ctx.userDocs.listDirectory(folder.directoryId)
            for (const document of listing.documents) {
              if (document.modifiedAt !== fixtureTime.getTime()) await utimes(document.path, fixtureTime, fixtureTime)
            }
          }
          await route.continue()
        } catch (error) {
          failures.push(error)
          await route.abort().catch((abortError: unknown) => { failures.push(abortError) })
        }
      })
      // Only the second completion request is delayed or rejected. Chunks,
      // verification polling, publication, and listing responses use the real private Host.
      const isCompletion = (url: URL): boolean => url.origin === origin
        && /^\/api\/documents\/uploads\/[^/]+\/complete$/u.test(url.pathname)
      await page.route(isCompletion, async (route) => {
        const operation = (async () => {
          if (route.request().method() !== 'POST') { await route.continue(); return }
          completions++
          if (completions !== 2) { await route.continue(); return }
          secondHeld = true
          await release.promise
          if (outcome === 'partial-failure') {
            await route.fulfill({ status: 500, json: { code: 'DOCUMENT_UPLOAD_STORAGE', error: 'Synthetic completion failure' } })
          } else if (outcome === 'catalog-recovery') {
            await route.fulfill({ status: 409, json: {
              error: { code: 'DOCUMENT_CATALOG_RECOVERY_REQUIRED', message: 'Document catalog recovery is required for this scope.' },
            } })
          } else await route.continue()
        })()
        pending.add(operation)
        try { await operation } catch (error) {
          failures.push(error)
          await route.abort().catch((abortError: unknown) => { failures.push(abortError) })
        } finally { pending.delete(operation) }
      })
      try {
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await page.getByRole('button', { name: 'Documents', exact: true }).click()
        const manager = page.getByRole('dialog', { name: 'Document Manager', exact: true })
        await manager.getByRole('button', { name: `Open folder ${folderName}`, exact: true }).click()
        await manager.getByText('No documents uploaded yet', { exact: true }).waitFor()
        if (outcome === 'success') await compareOrRefreshGolden(UPLOAD_EMPTY_EXPECTED,
          await captureStableAria(page, '[data-documents-panel]', scaffold.workspaceCwd), MODE)
        if (outcome === 'success') await auditWorkflowState(page, 'documents', 'empty-folder', manager, [], async () => {
          expect(await manager.getByRole('textbox', { name: 'Search document name', exact: true }).count()).toBe(0)
          expect(await manager.getByText('Folders: 0 · Documents: 0', { exact: true }).count()).toBe(0)
          if (page.viewportSize()!.width < 768) {
            expect(await manager.getByRole('heading', { name: folderName, exact: true }).count()).toBe(1)
          }
          expect(await manager.getByRole('button', { name: 'Upload Document', exact: true }).count()).toBe(1)
          expect(await manager.getByRole('button', { name: 'New Folder', exact: true }).count()).toBe(1)
          expect(await manager.getByRole('button', { name: 'Retry', exact: true }).isVisible()).toBe(true)
          await expectInitialDocumentsContent(page, manager, [
            manager.getByText('No documents uploaded yet', { exact: true }),
            manager.getByRole('button', { name: 'Retry', exact: true }),
            manager.getByText('Some locations need refreshing', { exact: true }),
            ...await manager.getByRole('button', { name: 'Upload Document', exact: true }).all(),
            ...await manager.getByRole('button', { name: 'New Folder', exact: true }).all(),
          ])
        })
        const input = manager.locator('input[type="file"]')
        const files = ['a', 'b', 'c'].map(name => ({
          name: `u01-${name}.txt`, mimeType: 'text/plain',
          buffer: Buffer.from(`U01 ${name} synthetic fixture\n`.padEnd(48, ' ')),
        }))
        const readsBefore = directoryReads
        await input.setInputFiles(files)
        await expect.poll(() => secondHeld, { timeout: 30_000 }).toBe(true)
        const batchProgress = manager.getByRole('progressbar', { name: 'Files uploaded', exact: true })
        await batchProgress.waitFor()
        expect(await batchProgress.getAttribute('value')).toBe('1')
        expect(await batchProgress.getAttribute('max')).toBe('3')
        await manager.getByText('Finalizing file 2 of 3', { exact: true }).waitFor()
        expect(await manager.getByRole('button', { name: 'Upload Document', exact: true }).isDisabled()).toBe(true)
        const firstPublished = await scaffold.ctx.userDocs.listDirectory(folder.directoryId)
        expect(firstPublished.documents.map(document => document.name)).toEqual(['u01-a.txt'])
        expect(startedFiles).toEqual(['u01-a.txt', 'u01-b.txt'])
        expect(completions).toBe(2)
        expect(directoryReads).toBe(readsBefore)
        expect(await manager.getByText('Uploaded: 1 / 3', { exact: true }).count()).toBe(1)
        expect(await manager.getByText('No documents uploaded yet', { exact: true }).count()).toBe(0)
        expect(await manager.getByText(/Documents: 0$/u).count()).toBe(0)
        expect(await input.isDisabled()).toBe(true)
        expect(await manager.getByText('Uploaded: 3 / 3', { exact: true }).count()).toBe(0)
        if (MODE === 'refresh') await mkdir(EXPECTED_DIR, { recursive: true })
        await compareOrRefreshGolden(UPLOAD_PUBLISHED_EXPECTED,
          await captureStableAria(page, '[data-documents-panel] [role="status"][aria-live="polite"]', scaffold.workspaceCwd), MODE)
        await auditWorkflowState(page, 'documents', `upload-${outcome}-pending-publication`, manager,
          [manager.getByRole('status').filter({ hasText: 'Uploaded: 1 / 3' })], async () => {
            await expectInitialDocumentsContent(page, manager, [
              manager.getByRole('button', { name: 'Retry', exact: true }),
              manager.getByText('Some locations need refreshing', { exact: true }),
              manager.getByText('Finalizing file 2 of 3', { exact: true }),
              manager.getByText('u01-b.txt', { exact: true }),
              batchProgress,
              manager.getByText('Uploaded: 1 / 3', { exact: true }),
            ])
            const root = page.viewportSize()!.width < 768
              ? manager.getByRole('button', { name: 'Back', exact: true })
              : manager.getByRole('navigation', { name: 'Document path', exact: true })
                .getByRole('button', { name: 'Root folder', exact: true })
            const bounds = await root.boundingBox()
            expect(bounds?.height, 'Touch breadcrumb height').toBeGreaterThanOrEqual(44)
            expect(bounds?.width, 'Touch breadcrumb width').toBeGreaterThanOrEqual(44)
            for (const select of await manager.locator('select:visible').all()) {
              expect((await select.boundingBox())?.height, 'Touch document select height').toBeGreaterThanOrEqual(44)
            }
          })
        release.resolve(undefined)
        const rows = manager.locator('[data-documents-list]')
        await rows.getByText('u01-a.txt', { exact: true }).waitFor()
        if (outcome !== 'success') {
          const alert = manager.getByRole('alert')
          await alert.waitFor()
          expect(await alert.textContent()).toContain('u01-b.txt')
          expect(await alert.textContent()).toContain('Files not started: 1.')
          expect(startedFiles).toEqual(['u01-a.txt', 'u01-b.txt'])
          expect(await rows.getByText('u01-b.txt', { exact: true }).count()).toBe(0)
          expect(await manager.getByText('Uploaded: 1 / 3', { exact: true }).count()).toBe(1)
          await compareOrRefreshGolden(outcome === 'catalog-recovery' ? UPLOAD_RECOVERY_EXPECTED : UPLOAD_PARTIAL_EXPECTED,
            await captureStableAria(page, '[data-documents-panel] [role="alert"]', scaffold.workspaceCwd), MODE)
          if (workflowMatrixEnabled) expectTextContrast(await captureTextContrast(page,
            [{ label: 'upload-failure', text: alert }], `documents-upload-${outcome}`))
        } else {
          await rows.getByText('u01-c.txt', { exact: true }).waitFor()
          expect(startedFiles).toEqual(files.map(file => file.name))
          expect(await manager.getByRole('alert').count()).toBe(0)
        }
        await expect.poll(() => input.isDisabled()).toBe(false)
        await auditWorkflowState(page, 'documents', `upload-${outcome}-settled`, manager, [], async () => {
          if (outcome === 'success') await expectInitialDocumentsContent(page, manager, [
            rows.locator('[data-documents-row-kind="document"]').first(),
            manager.getByRole('button', { name: 'Retry', exact: true }),
          ])
        }, async () => {
          const geometry = await manager.evaluate((element) => {
            const header = element.querySelector('header')!
            const scope = element.querySelector('[data-documents-scope-trigger]')!
            const ancestors = []
            for (let current: Element | null = scope; current !== null && element.contains(current); current = current.parentElement) {
              const rect = current.getBoundingClientRect()
              const style = getComputedStyle(current)
              ancestors.push({ class: current.className, top: rect.top, height: rect.height,
                scrollTop: current.scrollTop, overflow: style.overflow, display: style.display, position: style.position })
            }
            const headerBox = header.getBoundingClientRect()
            return { header: { top: headerBox.top, bottom: headerBox.bottom },
              scope: { top: scope.getBoundingClientRect().top }, ancestors }
          })
          expect(geometry.header.top, JSON.stringify(geometry)).toBeGreaterThanOrEqual(-1)
          if (page.viewportSize()!.width < 768 && page.viewportSize()!.height > 480) {
            expect(geometry.scope.top, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.header.bottom - 1)
          }
        })
        expect(directoryReads).toBe(readsBefore + 1)
        expect(await manager.getByRole('navigation', { name: 'Document path', exact: true })
          .getByRole('button', { name: folderName, exact: true }).getAttribute('aria-current')).toBe('page')
        const published = await scaffold.ctx.userDocs.listDirectory(folder.directoryId)
        expect(published.documents.length).toBe(outcome === 'success' ? 3 : 1)
        for (const document of published.documents) {
          expect(document.modifiedAt).toBe(fixtureTime.getTime())
          const expected = files.find(file => file.name === document.name)
          if (expected === undefined) throw new Error('Unexpected document in upload fixture directory')
          expect(Buffer.from((await scaffold.ctx.userDocs.read(document.docId)).data)).toEqual(expected.buffer)
        }
        if (outcome === 'success') {
          const resizeKeepingFocus = async (control: Locator, height: number): Promise<void> => {
            await page.setViewportSize({ width: 872, height })
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => {
              requestAnimationFrame(() => { resolve() })
            })))
            expect(await control.evaluate(node => node === document.activeElement)).toBe(true)
          }
          const inlineSearch = manager.getByRole('textbox', { name: 'Search document name', exact: true })
          await inlineSearch.fill('u01')
          await resizeKeepingFocus(inlineSearch, 230)
          await inlineSearch.press('End')
          await inlineSearch.pressSequentially('-a')
          expect(await inlineSearch.inputValue()).toBe('u01-a')
          await manager.locator('[data-documents-toolbar-more]').click()
          const tools = page.locator('[data-documents-sheet="toolbar-more"]')
          const search = tools.getByRole('textbox', { name: 'Search document name', exact: true })
          await search.waitFor()
          expect(await search.inputValue()).toBe('u01-a')
          await search.focus()
          await resizeKeepingFocus(search, 600)
          await resizeKeepingFocus(search, 230)
          await search.fill('')
          await tools.getByText('Folders: 0 · Documents: 3', { exact: true }).waitFor()
          await expect.poll(() => rows.locator('[data-documents-row-kind="document"]').count()).toBe(3)
          await compareOrRefreshGolden(SHORT_TOOLS_EXPECTED,
            await captureStableAria(page, '[data-documents-sheet="toolbar-more"]', scaffold.workspaceCwd), MODE)
          await auditWorkflowState(page, 'documents', 'toolbar-tools', tools)
          await search.fill('u01-a')
          await tools.getByRole('button', { name: 'Close', exact: true }).click()
          await expect.poll(() => rows.getByRole('listitem').count()).toBe(1)
          await rows.getByText('u01-a.txt', { exact: true }).waitFor()
          const filteredMore = manager.locator('[data-documents-toolbar-more]')
          expect(await filteredMore.textContent()).toContain('Filtered')
          expect(await filteredMore.getAttribute('aria-label')).toBe('More actions · Filtered')
          await expectInitialDocumentsContent(page, manager, [rows.getByRole('listitem'), filteredMore])
          await compareOrRefreshGolden(join(EXPECTED_DIR, 'short-filtered-folder.expected.md'),
            await captureStableAria(page, '[data-documents-panel]', scaffold.workspaceCwd), MODE)
          await manager.locator('[data-documents-toolbar-more]').click()
          await search.fill('')
          await expect.poll(() => rows.getByRole('listitem').count()).toBe(3)
          await tools.getByRole('button', { name: 'Close', exact: true }).click()
          await rows.getByRole('checkbox', { name: 'u01-a.txt', exact: true }).check()
          await manager.locator('[data-documents-toolbar-more]').click()
          const selectPage = tools.getByRole('checkbox', { name: 'Select this page', exact: true })
          expect(await selectPage.evaluate((node: HTMLInputElement) => node.indeterminate)).toBe(true)
          await tools.getByRole('button', { name: 'Close', exact: true }).click()
          await manager.locator('[data-documents-toolbar-more]').click()
          expect(await selectPage.evaluate((node: HTMLInputElement) => node.indeterminate)).toBe(true)
          await selectPage.check()
          await tools.getByRole('button', { name: 'Close', exact: true }).click()
          for (const file of files) expect(await rows.getByRole('checkbox', { name: file.name, exact: true }).isChecked()).toBe(true)
          await manager.locator('[data-documents-toolbar-more]').click()
          await selectPage.uncheck()
          await tools.getByRole('button', { name: 'Close', exact: true }).click()
          for (const file of files) expect(await rows.getByRole('checkbox', { name: file.name, exact: true }).isChecked()).toBe(false)
        }
        expect(tripwire.warnings).toEqual([])
        expect(tripwire.pageErrors).toEqual([])
        console.info('[upload-batch-publication]', JSON.stringify({
          outcome, secondHeld, completions, startedFiles, directoryReads,
          publishedNames: published.documents.map(document => document.name),
        }))
      } catch (error) {
        failures.push(error)
      } finally {
        release.resolve(undefined)
        const settled = await Promise.allSettled([...pending])
        for (const result of settled) if (result.status === 'rejected') failures.push(result.reason)
        if (secondHeld) {
          const storedCount = async (): Promise<number> => (await scaffold.ctx.userDocs.listDirectory(folder.directoryId)).documents.length
          await expect.poll(storedCount, { timeout: 30_000 })
            .toBe(outcome === 'success' ? 3 : 1).catch((error: unknown) => { failures.push(error) })
          await expect.poll(() => page.getByRole('progressbar').count(), { timeout: 30_000 }).toBe(0)
            .catch((error: unknown) => { failures.push(error) })
        }
        await page.unrouteAll({ behavior: 'wait' }).catch((error: unknown) => { failures.push(error) })
        // Unfinished sessions count against the shared admission limit until
        // they are cancelled; enumerate the session root rather than trusting
        // response-body capture, which races page teardown.
        const sessionRoot = join(scaffold.documentRoot, '.upload-sessions', 'v1')
        for (const uploadId of await readdir(sessionRoot).catch(() => [] as string[])) {
          const session = await scaffold.hostFetch(`/api/documents/uploads/${uploadId}`)
            .catch((error: unknown) => { failures.push(error); return undefined })
          const state = session?.status === 200 ? (await session.json() as { state?: string }).state : undefined
          if (state === 'uploading' || state === 'verifying') {
            await scaffold.hostFetch(`/api/documents/uploads/${uploadId}`, { method: 'DELETE' })
              .catch((error: unknown) => { failures.push(error) })
          }
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, `Real upload batch ${outcome} journey failed`)
    },
  )
  it.each(['personal', 'project'] as const)('desktop: keeps the default %s upload on its computer for metadata and chunks', async (kind) => {
    page = await browser.newPage({ ...workflowTouchOptions, viewport: { width: 1280, height: 800 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, `web-e2e-document-manager-default-${kind}-upload`))
    const nodeId = '00000000-0000-4000-8000-000000000041'
    const scopeKey = kind === 'personal' ? 'personal' : 'project:41'
    const document = { docId: 'default-target.txt', name: 'default-target.txt', bytes: 6,
      mediaType: 'text/plain', modifiedAt: Date.UTC(2026, 7, 14), path: '' }
    const session = { uploadId: '00000000-0000-4000-8000-000000000041', name: document.name,
      directoryId: '', bytes: document.bytes, fingerprint: 'fixture', chunkBytes: 8 * 1024 * 1024,
      receivedBytes: 0, expiresAt: Date.now() + 60_000, state: 'uploading' }
    let published = false
    const uploads: Array<{ method: string; path: string; scope: string | null; node: string | null }> = []
    await page.route(/\/account\/api\/context(?:\?.*)?$/, route => route.fulfill({ json: {
      scope: kind === 'personal' ? { kind } : { kind, projectId: 41, projectName: 'Compiler', mode: 'rw' },
      environment: { nodeId, nodeName: 'Office computer' },
      projects: kind === 'personal' ? [] : [{ projectId: 41, name: 'Compiler', mode: 'rw' }],
    } }))
    await page.route(/\/api\/documents(?:\/scope)?(?:\?.*)?$/, route => route.fulfill({ json: {
      limits: LIMITS, directoryId: '', directories: [], documents: published ? [document] : [], totalDocuments: published ? 1 : 0,
    } }))
    await page.route(/\/api\/documents\/(?:transfer\/)?uploads(?:\/[^?]*)?(?:\?.*)?$/, async (route) => {
      const request = route.request(), url = new URL(request.url())
      const addressed = { method: request.method(), path: url.pathname,
        scope: url.searchParams.get('scope'), node: url.searchParams.get('dshNode') }
      uploads.push(addressed)
      if (!addressed.path.startsWith('/api/documents/transfer/uploads') || addressed.scope !== scopeKey || addressed.node !== nodeId) {
        await route.fulfill({ status: 409, json: { error: 'runtime-catalog/ambiguous-target' } }); return
      }
      if (url.pathname.endsWith('/complete')) {
        published = true
        await route.fulfill({ json: { ...session, receivedBytes: document.bytes, state: 'complete', ref: document } })
      } else await route.fulfill({ json: session })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const manager = page.getByRole('dialog', { name: kind === 'personal' ? 'Document Manager' : 'Project Documents: Compiler', exact: true })
    await manager.getByText('No documents uploaded yet', { exact: true }).waitFor()
    const beforeUrl = page.url()
    const chosen = page.waitForEvent('filechooser')
    await manager.getByRole('button', { name: 'Upload Document', exact: true }).first().click()
    const fileChooser = await chosen
    const completionPath = `/api/documents/transfer/uploads/${session.uploadId}/complete`
    const [completed] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === completionPath
        && response.request().method() === 'POST'),
      fileChooser.setFiles({ name: document.name, mimeType: 'text/plain', buffer: Buffer.from('target') }),
    ])
    expect(completed.ok()).toBe(true)
    await manager.getByRole('checkbox', { name: document.name, exact: true }).waitFor()
    expect(uploads.map(upload => upload.method)).toEqual(['POST', 'PUT', 'POST'])
    expect(page.url()).toBe(beforeUrl)
    expect(await manager.getByRole('alert').count()).toBe(0)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, `default-${kind}-upload.expected.md`),
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
  }, workflowMatrixEnabled ? 180_000 : 60_000)

  it('compact: uses a scope trigger, upload primary, and one row action sheet', async () => {
    page = await browser.newPage({ ...workflowTouchOptions,
      viewport: { width: 390, height: 844 },
      locale: 'en-US',
      hasTouch: true,
      isMobile: responsiveMobileEmulation,
    })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-manager-compact'))
    await mockDocuments(page)
    await page.route(/\/api\/documents\/content(?:\?.*)?$/, route => route.fulfill({
      contentType: 'text/plain', body: 'Brief document text.\n',
    }))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Document Manager' })
    await dialog.waitFor({ timeout: 10_000 })

    const rowMore = dialog.getByRole('button', { name: 'More actions: brief.txt' })
    const name = dialog.getByText('brief.txt', { exact: true })
    await name.scrollIntoViewIfNeeded()
    await dialog.evaluate(async element => Promise.allSettled(element.getAnimations().map(animation => animation.finished)))
    const dialogBox = await dialog.boundingBox()
    const searchBox = await dialog.getByRole('group', { name: 'Document filters', exact: true }).boundingBox()
    const uploadBox = await dialog.getByRole('button', { name: 'Upload Document' }).boundingBox()
    const scopeTrigger = dialog.locator('[data-documents-scope-trigger]')
    const more = dialog.locator('[data-documents-toolbar-more]')
    const scopeBox = await scopeTrigger.boundingBox()
    const moreBox = await more.boundingBox()
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
    expect(searchBox.width).toBeGreaterThanOrEqual(dialogBox.width - 26)
    expect(searchBox.y).toBeGreaterThanOrEqual(uploadBox.y + uploadBox.height)
    expect(scopeBox.height).toBeGreaterThanOrEqual(44)
    expect(uploadBox.height).toBeGreaterThanOrEqual(44)
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
    if (!workflowMatrixEnabled) {
      await page.setViewportSize({ width: 768, height: 844 })
      await actionSheet.waitFor({ state: 'visible' })
      await actionSheet.getByRole('button', { name: 'Close', exact: true }).click()
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
      await page.setViewportSize({ width: 390, height: 844 })
      await rowMore.click()
      await actionSheet.waitFor({ state: 'visible' })
    }
    const actionSnapshot = await captureStableAria(page, '[data-documents-sheet="document-actions"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(COMPACT_ACTIONS_EXPECTED, actionSnapshot, MODE)
    await auditWorkflowState(page, 'documents', 'document-actions', actionSheet)
    await preview.click()
    const previewDialog = page.getByRole('dialog', { name: 'Preview: brief.txt' })
    await previewDialog.waitFor({ timeout: 10_000 })
    const previewDialogBox = await previewDialog.boundingBox()
    if (previewDialogBox === null) throw new Error('compact preview geometry missing')
    expect(previewDialogBox.x).toBeGreaterThanOrEqual(0)
    expect(previewDialogBox.y).toBeGreaterThanOrEqual(-1)
    expect(previewDialogBox.x + previewDialogBox.width).toBeLessThanOrEqual(391)
    expect(previewDialogBox.y + previewDialogBox.height).toBeLessThanOrEqual(845)
    const previewText = page.locator('[data-document-preview] pre').getByText('Brief document text.', { exact: true })
    await previewText.waitFor()
    const textPreviewSurface = page.getByRole('dialog').filter({ has: page.locator('[data-document-preview]') })
    await auditWorkflowState(page, 'documents', 'text-preview',
      textPreviewSurface, [previewText], async () => {
        await expectInitialDocumentsContent(page, textPreviewSurface, [previewText, textPreviewSurface.locator('footer')])
      })
    await page.keyboard.press('Escape')
    await actionSheet.waitFor({ state: 'detached', timeout: 10_000 })

    const overflow = await dialog.evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(COMPACT_EXPECTED, snapshot, MODE)
  }, workflowMatrixEnabled ? 180_000 : 60_000)

  it('compact narrow: dedicates a row to search and keeps primary actions together', async () => {
    page = await browser.newPage({ ...workflowTouchOptions,
      viewport: { width: 320, height: 568 },
      locale: 'en-US',
      hasTouch: true,
      isMobile: responsiveMobileEmulation,
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
    await Promise.all([
      dialog.getByRole('group', { name: 'Document filters' }).waitFor(),
      upload.waitFor(),
      more.waitFor(),
    ])
    // Measure all four boxes in one synchronous pass: sequential boundingBox
    // calls observe different layouts while the dialog still settles, and on a
    // loaded runner upload/more can read rows apart mid-reflow.
    const boxes = await dialog.evaluate((element) => {
      const box = (el: Element | null | undefined) => {
        const rect = el?.getBoundingClientRect()
        return rect === undefined ? null
          : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
      const filters = element.querySelector('[role="group"][aria-label="Document filters"]')
      const filterContainer = filters?.parentElement?.parentElement
      const filterStyle = filterContainer === undefined || filterContainer === null ? undefined : getComputedStyle(filterContainer)
      return {
        dialogBox: box(element),
        filterRowWidth: filterStyle === undefined ? 0 : filterContainer!.clientWidth
          - Number.parseFloat(filterStyle.paddingLeft) - Number.parseFloat(filterStyle.paddingRight),
        searchBox: box(filters),
        uploadBox: box([...element.querySelectorAll('button')]
          .find(el => el.getAttribute('aria-label') === 'Upload Document'
            || el.textContent?.includes('Upload Document'))),
        moreBox: box(element.querySelector('[data-documents-toolbar-more]')),
      }
    })
    const { dialogBox, searchBox, uploadBox, moreBox } = boxes
    if ([dialogBox, searchBox, uploadBox, moreBox].some(box => box === null)) {
      throw new Error('document manager narrow geometry missing')
    }
    expect(boxes.filterRowWidth).toBeGreaterThan(0)
    expect(searchBox!.width).toBeGreaterThanOrEqual(boxes.filterRowWidth - 1)
    expect(await dialog.locator('select').count()).toBe(0)
    expect(searchBox!.y).toBeGreaterThanOrEqual(uploadBox!.y + uploadBox!.height)
    expect(Math.round(uploadBox!.y)).toBe(Math.round(moreBox!.y))
    for (const box of [uploadBox!, moreBox!]) {
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(321)
    }
    expect(await upload.locator('svg').count()).toBeGreaterThan(0)
    const browseBeforeMore = browseRequests
    await more.click()
    const moreSheet = page.locator('[data-documents-sheet="toolbar-more"]')
    await moreSheet.waitFor({ timeout: 10_000 })
    expect(await moreSheet.locator('[data-documents-sheet-scrollport]').count()).toBe(1)
    expect(await moreSheet.locator('select').count()).toBe(1)
    expect(await moreSheet.getByRole('radio').count()).toBe(5)
    await moreSheet.locator('select').nth(0).selectOption('pdf')
    await moreSheet.getByRole('radio', { name: 'Name', exact: true }).check()
    expect(browseRequests).toBe(browseBeforeMore)
    for (const control of [
      moreSheet.getByRole('button', { name: 'New Folder' }),
      moreSheet.getByRole('button', { name: 'Refresh' }),
    ]) {
      const box = await control.boundingBox()
      if (box === null) throw new Error('more-sheet action geometry missing')
      expect(Math.round(box.height * 100) / 100).toBeGreaterThanOrEqual(44)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(321)
    }
    await moreSheet.getByRole('button', { name: 'Close' }).click()
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(321)
    const overflow = await dialog.evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
  }, workflowMatrixEnabled ? 180_000 : 60_000)

  it('compact: switches scopes and exposes permission-safe batch actions', async () => {
    page = await browser.newPage({ ...workflowTouchOptions,
      viewport: { width: 390, height: 844 },
      locale: 'en-US',
      hasTouch: true,
      isMobile: responsiveMobileEmulation,
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
    await auditWorkflowState(page, 'documents', 'scope-picker', scopeSheet)
    await scopeSheet.getByPlaceholder('Search document scopes').fill('Compiler')
    await auditWorkflowState(page, 'documents', 'scope-picker-filtered', scopeSheet)
    await scopeSheet.getByRole('button', { name: /Compiler/ }).click()
    await manager.locator('[data-documents-scope-trigger]').getByText('Compiler', { exact: true }).waitFor({ timeout: 10_000 })
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
    await auditWorkflowState(page, 'documents', 'readonly-batch-actions', batchSheet)
    await batchSheet.getByRole('button', { name: 'Close' }).click()
    await auditWorkflowState(page, 'documents', 'readonly-scope-batch-selection', manager, [], undefined, async () => {
      if (page.viewportSize()!.width >= 768) return
      const count = await batchBar.getByText('1 selected', { exact: true }).boundingBox()
      const actions = await batchBar.getByRole('button', { name: 'Batch actions' }).boundingBox()
      if (count === null || actions === null) throw new Error('Selection summary and action must both be visible')
      expect(Math.abs(count.y + count.height / 2 - actions.y - actions.height / 2)).toBeLessThanOrEqual(1)
    })
  }, workflowMatrixEnabled ? 180_000 : 60_000)

  it('compact: renders the all-scope metadata view as a bounded card list', async () => {
    page = await browser.newPage({ ...workflowTouchOptions,
      viewport: { width: 390, height: 844 },
      locale: 'en-US',
      hasTouch: true,
      isMobile: responsiveMobileEmulation,
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
    await scopeSheet.getByRole('button', { name: /All accessible documents/ }).click()
    const overview = manager.getByRole('region', { name: 'All accessible documents', exact: true })
    await overview.waitFor({ timeout: 10_000 })
    await manager.locator('[class*="overviewList"]').getByText('notes.txt', { exact: true }).waitFor({ timeout: 10_000 })
    const overviewSnapshot = await captureStableAria(page, '[data-documents-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(COMPACT_OVERVIEW_EXPECTED, overviewSnapshot, MODE)
    const overviewRow = overview.getByRole('listitem')
    await auditWorkflowState(page, 'documents', 'all-scope-overview', manager, [], async () => {
      await expectInitialDocumentsContent(page, manager, [overviewRow])
    }, async () => {
      const horizontalOverflow = await overview.evaluate((element) => {
        let largest = 0
        for (let node: HTMLElement | null = element as HTMLElement; node !== null && node.getAttribute('role') !== 'dialog'; node = node.parentElement) {
          largest = Math.max(largest, node.scrollWidth - node.clientWidth)
        }
        return largest
      })
      expect(horizontalOverflow, 'Catalog search and metadata fit without horizontal scrolling').toBeLessThanOrEqual(1)
    })
    const overviewMore = manager.locator('[data-documents-row-more="overview"]')
    expect(await overviewMore.getAttribute('aria-label')).toBe('More actions: notes.txt')
    await overviewMore.click()
    const overviewSheet = page.locator('[data-documents-sheet="overview-actions"]')
    await overviewSheet.waitFor({ timeout: 10_000 })
    expect(await overviewSheet.getByRole('heading', { name: 'More actions', exact: true }).count()).toBe(1)
    expect(await overviewSheet.getByRole('button', { name: 'View', exact: true }).count()).toBe(1)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'overview-actions.expected.md'),
      await captureStableAria(page, '[data-documents-sheet="overview-actions"]', scaffold.workspaceCwd), MODE)
    await auditWorkflowState(page, 'documents', 'overview-actions', overviewSheet)
    const overviewBox = await overviewSheet.boundingBox()
    if (overviewBox === null) throw new Error('compact overview action geometry missing')
    expect(overviewBox.x).toBeGreaterThanOrEqual(0)
    expect(overviewBox.x + overviewBox.width).toBeLessThanOrEqual(391)
    await overviewSheet.getByRole('button', { name: 'Close' }).click()

    const originalViewport = page.viewportSize()!
    await page.setViewportSize({ width: 872, height: 600 })
    const overviewSearch = overview.getByRole('textbox', { name: 'Search document name', exact: true })
    await overviewSearch.fill('notes')
    const searchElement = await overviewSearch.elementHandle()
    if (searchElement === null) throw new Error('Overview search is missing')
    try {
      await page.setViewportSize({ width: 872, height: 230 })
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => {
        requestAnimationFrame(() => { resolve() })
      })))
      expect(await searchElement.evaluate(node => node.isConnected && node === document.activeElement),
        'Overview search retains its DOM node and focus when height becomes short').toBe(true)
      await overviewSearch.press('End')
      await overviewSearch.pressSequentially('.txt')
      expect(await overviewSearch.inputValue()).toBe('notes.txt')
      await overviewSearch.press('Tab')
      expect(await overview.getByRole('combobox', { name: 'Type', exact: true }).evaluate(node => node === document.activeElement),
        'The inline filter group remains available when focus moves from search to type').toBe(true)
      await overviewSearch.focus()
      const overviewToolsButton = overview.locator('[data-documents-overview-more]')
      await overviewToolsButton.click()
      const overviewTools = page.locator('[data-documents-sheet="toolbar-more"]')
      expect(await overviewTools.getByRole('textbox', { name: 'Search document name', exact: true }).inputValue()).toBe('notes.txt')
      await overviewTools.getByLabel('Type', { exact: true }).selectOption('text')
      await overviewTools.getByRole('radio', { name: 'Name', exact: true }).check()
      await overviewTools.getByRole('button', { name: 'Close', exact: true }).click()
      await overviewRow.getByText('notes.txt', { exact: true }).waitFor()
      const inspectFilteredOverview = async () => {
        if (page.viewportSize()!.height > 480) return
        expect(await overviewToolsButton.textContent()).toContain('Filtered')
        expect(await overviewToolsButton.getAttribute('aria-label')).toBe('More actions · Filtered')
        await expectInitialDocumentsContent(page, manager, [overviewRow, overviewToolsButton])
      }
      await inspectFilteredOverview()
      expectTextContrast(await captureTextContrast(page,
        [{ label: 'active-filter', text: overviewToolsButton.getByText('Filtered', { exact: true }) }], 'documents-active-filter'))
      await compareOrRefreshGolden(join(EXPECTED_DIR, 'overview-short-filtered.expected.md'),
        await captureStableAria(page, '[data-documents-panel]', scaffold.workspaceCwd), MODE)
      await auditWorkflowState(page, 'documents', 'all-scope-overview-filtered', manager, [], inspectFilteredOverview)
      await overviewToolsButton.click()
      expect(await overviewTools.getByRole('textbox', { name: 'Search document name', exact: true }).inputValue()).toBe('notes.txt')
      expect(await overviewTools.getByLabel('Type', { exact: true }).inputValue()).toBe('text')
      expect(await overviewTools.getByRole('radio', { name: 'Name', exact: true }).isChecked()).toBe(true)
      await overviewTools.getByRole('button', { name: 'Close', exact: true }).click()
    } finally {
      await searchElement.dispose()
      await page.setViewportSize(originalViewport)
    }
  }, workflowMatrixEnabled ? 180_000 : 60_000)

  it('uses the desktop workbench exactly at the shared 768px boundary', async () => {
    page = await browser.newPage({ ...workflowTouchOptions, viewport: { width: 768, height: 800 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-manager-boundary'))
    await mockDocuments(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Document Manager' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.locator('[data-documents-list] [title="brief.txt"]').waitFor({ timeout: 10_000 })
    expect(await dialog.locator('[data-documents-scope-trigger]').count()).toBe(1)
    expect(await dialog.locator('aside[aria-label="Document scopes"]').isVisible()).toBe(false)
    expect(await dialog.locator('aside[aria-label="Document scopes"]').count()).toBe(1)
    const overflow = await dialog.evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
  }, workflowMatrixEnabled ? 180_000 : 60_000)

  it.each([1280, 1024, 768, 390])('secondary dialogs keep complete names, destination values and pinned actions at %ipx', async (width) => {
    page = await browser.newPage({ ...workflowTouchOptions, viewport: { width, height: 844 }, locale: 'en-US',
      hasTouch: workflowMatrixEnabled || width === 390 })
    tripwire = watchConsole(page)
    const out = process.env.DSH_DOCUMENT_DIALOG_SCREENSHOTS
    const longName = '客户交付资料与产品需求说明_完整的目录名称必须可以阅读_2026年10月'
    const folders = Array.from({ length: 7 }, (_, index) => ({ directoryId: `folder-${index}`, name: index === 6 ? longName : `Archive ${index}`, path: '', modifiedAt: 1 }))
    const moves: string[] = []
    const creations: string[] = []
    await mockDocuments(page)
    await page.route(/\/account\/api\/context(?:\?.*)?$/, route => route.fulfill({ json: {
      scope: { kind: 'personal' }, projects: [
        { projectId: 41, name: 'Compiler', mode: 'rw' }, { projectId: 42, name: longName, mode: 'rw' },
      ],
    } }))
    await page.route(/\/api\/documents\/directories(?:\?.*)?$/, route => route.fulfill({ json: { directories: folders } }))
    await page.route(/\/api\/documents\/transfer\/directories(?:\?.*)?$/, route => route.fulfill({
      json: { version: 1, directories: folders },
    }))
    await page.route(/\/api\/documents\/move(?:\?.*)?$/, (route) => {
      moves.push(new URL(route.request().url()).searchParams.get('directory') ?? '')
      return route.fulfill({ status: 409, json: { error: 'Move could not be completed' } })
    })
    await page.route(/\/api\/documents\/folders(?:\?.*)?$/, (route) => {
      const name = new URL(route.request().url()).searchParams.get('name') ?? ''
      creations.push(name)
      return route.fulfill({ json: { directoryId: 'new', name, path: '', modifiedAt: 1 } })
    })
    await page.route(/\/api\/documents(?:\/scope)?\/history(?:\?.*)?$/, route => route.fulfill({ json: { version: 1, items: [
      { id: 'history-1', eventKind: 'upload', documentName: longName+'.pdf', createdAt: 1, actor: { displayName: 'Design review' } },
    ] } }))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    if (width === 390) await page.getByRole('button', { name: 'Open sidebar' }).click()
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'Document Manager', exact: true })
    await manager.getByText('brief.txt', { exact: true }).waitFor()
    await assertRowActionClearance(page, manager, width)
    if (out !== undefined) await page.screenshot({ path: join(out, `row-hover-${width}.png`) })
    if (width >= 768) {
      await page.route(/\/api\/documents\/content(?:\?.*)?$/, route => route.fulfill({ contentType: 'text/plain', body: 'Reading fixture' }))
      await manager.getByRole('button', { name: 'Preview brief.txt', exact: true }).click()
      await assertRowActionClearance(page, manager, width)
      if (out !== undefined) await page.screenshot({ path: join(out, `row-hover-preview-${width}.png`) })
      await manager.getByRole('button', { name: 'Close preview', exact: true }).click()
    }
    const assertFits = async (dialog: ReturnType<Page['getByRole']>) => {
      const geometry = await dialog.evaluate(element => ({
        x: element.getBoundingClientRect().x, right: element.getBoundingClientRect().right,
        scroll: element.scrollWidth, client: element.clientWidth,
      }))
      expect(geometry.x).toBeGreaterThanOrEqual(0)
      expect(geometry.right).toBeLessThanOrEqual(width+1)
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.client+1)
      const footer = dialog.locator('[data-documents-dialog-actions]')
      if (await footer.count() > 0) for (const button of await footer.getByRole('button').all()) {
        const box = await button.boundingBox()
        expect(box?.height).toBeGreaterThanOrEqual(width === 390 ? 44 : 32)
      }
    }
    const shot = async (kind: string, dialog: Locator) => {
      if (width === 1280) await auditWorkflowState(page, 'documents', `secondary-${kind}`, dialog)
      if (out !== undefined) await page.screenshot({ path: join(out, `${kind}-${width}.png`) })
    }
    const rowAction = async (name: string) => {
      await manager.getByRole('button', { name: 'More actions: brief.txt', exact: true }).click()
      if (width === 390) await page.getByRole('dialog', { name: 'More actions', exact: true }).getByRole('button', { name, exact: true }).click()
      else await page.getByRole('menuitem', { name, exact: true }).click()
    }
    if (width === 390) {
      await manager.getByRole('button', { name: 'More actions', exact: true }).click()
      await page.getByRole('dialog', { name: 'More actions', exact: true }).getByRole('button', { name: 'New Folder', exact: true }).click()
    } else await manager.getByRole('button', { name: 'New Folder', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'New Folder', exact: true })
    await shot('create-empty', create)
    await create.getByRole('textbox', { name: 'Folder name' }).fill('review-folder')
    await assertFits(create)
    await shot('create', create)
    await create.getByRole('textbox', { name: 'Folder name' }).press('Enter')
    await create.waitFor({ state: 'hidden' })
    expect(creations).toEqual(['review-folder'])

    await rowAction('Move')
    const move = page.getByRole('dialog', { name: 'Move Documents', exact: true })
    expect(await move.getByText('Documents to move: 1', { exact: true }).count()).toBe(1)
    const group = move.getByRole('radiogroup', { name: 'Destination folder' })
    await group.getByRole('radio', { name: longName, exact: true }).check()
    await group.getByRole('radio', { name: longName, exact: true }).press('ArrowUp')
    expect(await group.getByRole('radio', { name: 'Archive 5', exact: true }).isChecked()).toBe(true)
    await group.getByRole('radio', { name: 'Archive 5', exact: true }).press('ArrowDown')
    expect(await group.getByRole('radio', { name: longName, exact: true }).isChecked()).toBe(true)
    await group.getByRole('textbox', { name: 'Search destination folders' }).fill('no-matching-folder')
    expect(await group.getByText('Selected: '+longName, { exact: true }).isVisible()).toBe(true)
    await shot('move-no-match', move)
    await group.getByRole('textbox', { name: 'Search destination folders' }).fill('')
    await assertFits(move)
    await shot('move', move)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'secondary-move.expected.md'), await captureStableAria(page, '[data-documents-dialog="move"]', scaffold.workspaceCwd), MODE)
    if (workflowMatrixEnabled && width === 1280) {
      await page.setViewportSize({ width: 320, height: 568 })
      await group.getByRole('radio', { name: longName, exact: true }).click()
    }
    await move.getByRole('button', { name: 'Confirm Move', exact: true }).click()
    const moveError = move.getByRole('alert')
    await moveError.waitFor()
    await expect.poll(() => moveError.evaluate((element) => {
      const error = element.getBoundingClientRect()
      const body = element.closest('[data-documents-sheet-scrollport]')!.getBoundingClientRect()
      return Math.max(body.top - error.top, error.bottom - body.bottom)
    }), { message: 'Failed moves reveal their error without manual scrolling or moving focus' }).toBeLessThanOrEqual(1)
    const failureShots = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
    if (failureShots !== undefined) {
      await page.screenshot({ path: join(failureShots, `${responsiveBrowserName}-documents-move-error-initial-${width}.png`), animations: 'disabled' })
    }
    expect(moves).toEqual(['folder-6'])
    await shot('move-error', move)
    if (workflowMatrixEnabled && width === 1280) await page.setViewportSize({ width, height: 844 })
    await move.getByRole('button', { name: 'Cancel', exact: true }).click()

    await rowAction('Copy to…')
    const copy = page.getByRole('dialog', { name: 'Copy Document Snapshots', exact: true })
    expect(await copy.getByText('Documents to copy: 1', { exact: true }).count()).toBe(1)
    await copy.getByRole('radiogroup', { name: 'Target folder' }).getByRole('textbox', { name: 'Search destination folders' }).waitFor()
    await assertFits(copy)
    await shot('copy', copy)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'secondary-copy.expected.md'), await captureStableAria(page, '[data-documents-dialog="copy"]', scaffold.workspaceCwd), MODE)
    await copy.getByRole('button', { name: 'Cancel', exact: true }).click()

    await rowAction('Delete')
    const deletion = page.getByRole('dialog', { name: 'Confirm Deletion', exact: true })
    await shot('delete-document', deletion)
    await deletion.getByRole('button', { name: 'Cancel', exact: true }).click()

    for (const [action, title] of [['Rename', 'Rename Folder'], ['Delete', 'Delete Folder']] as const) {
      await manager.getByRole('button', { name: 'More actions: folder reports', exact: true }).click()
      if (width === 390) {
        const actions = page.getByRole('dialog', { name: 'More actions', exact: true })
        await actions.getByRole('button', { name: action, exact: true }).click()
      } else await page.getByRole('menuitem', { name: action, exact: true }).click()
      const folderDialog = page.getByRole('dialog', { name: title, exact: true })
      if (action === 'Rename') await folderDialog.getByRole('textbox', { name: 'Folder name' }).fill(longName)
      await shot(action === 'Rename' ? 'rename-folder' : 'delete-folder', folderDialog)
      await folderDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    }

    if (width === 390) {
      await manager.getByRole('button', { name: 'More actions', exact: true }).click()
      await page.getByRole('dialog', { name: 'More actions', exact: true }).getByRole('button', { name: 'History', exact: true }).click()
    } else if (width <= 1100) {
      await manager.getByRole('button', { name: 'More actions', exact: true }).click()
      await page.getByRole('menuitem', { name: 'History', exact: true }).click()
    } else await manager.getByRole('button', { name: 'History', exact: true }).click()
    const history = page.getByRole('dialog', { name: 'Document operation history', exact: true })
    await history.getByText(longName+'.pdf', { exact: false }).waitFor()
    await assertFits(history)
    await shot('history', history)
    await history.getByRole('button', { name: 'Close', exact: true }).click()
  }, workflowMatrixEnabled ? 180_000 : 60_000)

  it('keeps a search in the destination folder when its response is delayed', async () => {
    page = await browser.newPage({ ...workflowTouchOptions, viewport: { width: 1280, height: 800 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-manager-folder-search'))
    let releaseFolder!: () => void
    let enteredFolder!: () => void
    const ready = new Promise<void>((resolve) => { releaseFolder = resolve })
    const entered = new Promise<void>((resolve) => { enteredFolder = resolve })
    const reads: Array<{ directory: string; query: string }> = []
    await page.route(/\/api\/documents(?:\?.*)?$/, async (route) => {
      const url = new URL(route.request().url())
      if (route.request().method() !== 'GET') { await route.continue(); return }
      const directory = url.searchParams.get('directory') ?? ''
      const query = url.searchParams.get('q') ?? ''
      reads.push({ directory, query })
      if (directory === 'reports' && query === '') { enteredFolder(); await ready }
      await route.fulfill({ json: { ...LIST_PAYLOAD, directoryId: directory,
        directories: directory === '' ? LIST_PAYLOAD.directories : [],
        documents: directory === '' ? [] : [{ ...LIST_PAYLOAD.documents[0]!, docId: 'reports/report.txt', name: 'report.txt' }],
        totalDocuments: directory === '' ? 0 : 1 } })
    })
    try {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await page.getByRole('button', { name: 'Documents', exact: true }).click()
      const manager = page.getByRole('dialog', { name: 'Document Manager', exact: true })
      await manager.getByRole('button', { name: 'Open folder reports', exact: true }).click()
      await entered
      await manager.getByRole('textbox', { name: 'Search document name', exact: true }).fill('report')
      releaseFolder()
      await manager.getByText('report.txt', { exact: true }).waitFor()
      await expect.poll(() => reads.at(-1)).toEqual({ directory: 'reports', query: 'report' })
      expect(reads.some(read => read.directory === '' && read.query === 'report')).toBe(false)
      await manager.getByRole('button', { name: 'Close', exact: true }).click()
      await page.getByRole('button', { name: 'Documents', exact: true }).click()
      await manager.getByText('report.txt', { exact: true }).waitFor()
      expect(await manager.getByRole('textbox', { name: 'Search document name', exact: true }).inputValue()).toBe('report')
      await manager.getByRole('navigation', { name: 'Document path', exact: true }).getByRole('button', { name: 'reports', exact: true }).waitFor()
      await expect.poll(() => reads.at(-1)?.directory).toBe('reports')
      await expect.poll(() => manager.getByRole('button', { name: 'Back', exact: true }).isEnabled()).toBe(true)
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'folder-search.expected.md'),
        await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
      await auditWorkflowState(page, 'documents', 'folder-search-retained', manager, [], async () => {
        if (page.viewportSize()!.height > 480) return
        const more = manager.locator('[data-documents-toolbar-more]')
        expect(await more.textContent()).toContain('Filtered')
        expect(await more.getAttribute('aria-label')).toBe('More actions · Filtered')
        await expectInitialDocumentsContent(page, manager, [manager.locator('[data-documents-row-kind="document"]'), more])
      })
    } finally {
      releaseFolder()
      await page.unrouteAll({ behavior: 'wait' })
    }
  }, workflowMatrixEnabled ? 180_000 : 60_000)

  it('keeps immediate searches on the selected remote scope and ignores a superseded scope response', async () => {
    page = await browser.newPage({ ...workflowTouchOptions, viewport: { width: 1280, height: 800 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-manager-scope-search'))
    const local = '10000000-0000-4000-8000-000000000001'
    const remote = '10000000-0000-4000-8000-000000000002'
    const other = '10000000-0000-4000-8000-000000000003'
    const runtimeId = '20000000-0000-4000-8000-000000000001'
    const windows = Promise.withResolvers<undefined>()
    const windowsEntered = Promise.withResolvers<undefined>()
    const linux = Promise.withResolvers<undefined>()
    const linuxEntered = Promise.withResolvers<undefined>()
    const linuxFinished = Promise.withResolvers<undefined>()
    const reads: Array<{ scope: string; node: string | null; query: string }> = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (request.method() === 'GET' && /\/api\/documents(?:\/scope)?$/.test(url.pathname)) {
        reads.push({ scope: url.searchParams.get('scope') ?? 'runtime', node: url.searchParams.get('dshNode'), query: url.searchParams.get('q') ?? '' })
      }
    })
    await page.route(/\/api\/host\.describe(?:\?.*)?$/, async (route) => {
      const response = await route.fetch()
      const body = await response.json() as {
        result: { ok: true; value: { executionAuthorityRequired: boolean; runtimeTarget: { kind: 'personal'; runtimeId: string; nodeId: string } } } | { ok: false }
      }
      expect(body.result.ok).toBe(true)
      if (body.result.ok) {
        body.result.value.executionAuthorityRequired = true
        body.result.value.runtimeTarget = { kind: 'personal', runtimeId, nodeId: local }
      }
      await route.fulfill({ response, json: body })
    })
    await page.route('**/account/api/deployment/context*', route => route.fulfill({ json: {
      mode: 'multi', revision: '1', entry: { nodeId: local, name: 'Local computer' },
      primary: { nodeId: local, name: 'Local computer', origin: new URL(scaffold.authenticatedUrl).origin },
      role: 'primary', scope: 'organization', refreshAfterMs: 30000, legacyMigrationRequired: false,
    } }))
    await page.route('**/account/api/context*', route => route.fulfill({ json: {
      scope: { kind: 'personal' }, user: { id: 7, username: 'fixture', displayName: 'Fixture', role: 'admin' },
      projects: [], environment: { id: runtimeId, nodeId: local, nodeName: 'Local computer' },
    } }))
    await page.route('**/account/api/document-locations*', route => route.fulfill({ json: { items: [
      { scope: { kind: 'personal', nodeId: local }, name: 'Personal', nodeName: 'Local computer', mode: 'rw' },
      { scope: { kind: 'personal', nodeId: remote }, name: 'Personal', nodeName: 'Windows computer', mode: 'rw' },
      { scope: { kind: 'personal', nodeId: other }, name: 'Personal', nodeName: 'Linux computer', mode: 'rw' },
    ], nextCursor: null } }))
    await page.route(/\/api\/documents\/scope(?:\?.*)?$/, async (route) => {
      const url = new URL(route.request().url())
      const node = url.searchParams.get('dshNode')
      const query = url.searchParams.get('q') ?? ''
      expect([remote, other]).toContain(node)
      expect(url.searchParams.get('scope')).toBe('personal')
      const name = node === remote ? 'windows-report.txt' : 'linux-report.txt'
      try {
        if (query === '' && node === remote) { windowsEntered.resolve(undefined); await windows.promise }
        if (query === '' && node === other) { linuxEntered.resolve(undefined); await linux.promise }
        await route.fulfill({ json: { ...LIST_PAYLOAD, directories: [], totalDocuments: 1,
          documents: [{ ...LIST_PAYLOAD.documents[0]!, docId: name, name }] } })
      } finally {
        if (node === other) linuxFinished.resolve(undefined)
      }
    })
    try {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: 'Documents', exact: true }).click()
      const manager = page.getByRole('dialog', { name: 'Document Manager', exact: true })
      await manager.getByText(previewDocument.name, { exact: true }).waitFor()
      const search = manager.getByRole('textbox', { name: 'Search document name', exact: true })
      await manager.locator('aside').getByRole('button', { name: /Windows computer/ }).click()
      await windowsEntered.promise
      await search.fill('windows')
      await manager.getByText('Loading: Personal documents · Windows computer', { exact: false }).waitFor()
      windows.resolve(undefined)
      await expect.poll(() => reads.at(-1)).toEqual({ scope: 'personal', node: remote, query: 'windows' })
      await manager.getByText('windows-report.txt', { exact: true }).waitFor()
      expect(await search.inputValue()).toBe('windows')
      expect(reads.some(read => read.scope === 'runtime' && read.query === 'windows')).toBe(false)

      await manager.locator('aside').getByRole('button', { name: /Linux computer/ }).click()
      await linuxEntered.promise
      await search.fill('linux')
      const aborted = page.waitForEvent('requestfailed', { predicate: (request) => {
        const url = new URL(request.url())
        return url.pathname.endsWith('/api/documents/scope') && url.searchParams.get('dshNode') === other
      } })
      await manager.locator('aside').getByRole('button', { name: /Windows computer/ }).click()
      await aborted
      await search.fill('windows')
      linux.resolve(undefined)
      await linuxFinished.promise
      await expect.poll(() => reads.at(-1)).toEqual({ scope: 'personal', node: remote, query: 'windows' })
      await manager.getByText('windows-report.txt', { exact: true }).waitFor()
      expect(await search.inputValue()).toBe('windows')
      expect(await manager.getByText('linux-report.txt', { exact: true }).count()).toBe(0)
      expect(reads.filter(read => read.query !== '').every(read => read.scope === 'personal' && read.node === remote)).toBe(true)
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'scope-search.expected.md'),
        await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
    } finally {
      windows.resolve(undefined)
      linux.resolve(undefined)
      await page.unrouteAll({ behavior: 'wait' })
    }
  }, 60_000)

  it('explains the real receiving limit without deleting retained upload sessions', async () => {
    const retained: string[] = []
    const uploadPage = await browser.newPage({ ...workflowTouchOptions, viewport: { width: 1280, height: 900 }, locale: 'en-US' })
    try {
      for (let i = 0; i < 2; i += 1) {
        const created = await scaffold.hostFetch('/api/documents/uploads', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: 1, name: `retained-${i}.txt`, directory: '', bytes: 1,
            fingerprint: createHash('sha256').update(`retained-upload-limit-${i}`).digest('hex') }),
        })
        expect(created.status).toBe(200)
        retained.push((await created.json() as { uploadId: string }).uploadId)
      }
      await uploadPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await uploadPage.getByRole('button', { name: 'Documents', exact: true }).click()
      const manager = uploadPage.getByRole('dialog', { name: 'Document Manager', exact: true })
      const chosen = uploadPage.waitForEvent('filechooser')
      await manager.getByRole('button', { name: 'Upload Document', exact: true }).first().click()
      await (await chosen).setFiles({ name: 'limit-new-file.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
      const alert = manager.getByRole('alert')
      await expect.poll(() => alert.innerText()).toContain('Reselect a previous file to resume it')
      for (const uploadId of retained) {
        const inspected = await scaffold.hostFetch(`/api/documents/uploads/${uploadId}`)
        expect(inspected.status).toBe(200)
        expect(await inspected.json()).toMatchObject({ state: 'uploading', receivedBytes: 0 })
      }
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'upload-busy.expected.md'),
        await captureStableAria(uploadPage, '[role="alert"]', scaffold.workspaceCwd), MODE)
      await auditWorkflowState(uploadPage, 'documents', 'receiving-limit', manager)
    } finally {
      await uploadPage.close()
      for (const uploadId of retained) {
        expect((await scaffold.hostFetch(`/api/documents/uploads/${uploadId}`, { method: 'DELETE' })).status).toBe(204)
      }
    }
  }, workflowMatrixEnabled ? 180_000 : 60_000)

  it('commits exactly the document-manager snapshot inventory', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'computer-upload-targets.expected.md',
      'computer-scope-denied.expected.md',
      'compact-actions.expected.md',
      'compact-batch.expected.md',
      'compact.expected.md',
      'compact-overview.expected.md',
      'overview-actions.expected.md',
      'compact-scope.expected.md',
      'desktop-paged.expected.md',
      'desktop.expected.md',
      'default-personal-upload.expected.md',
      'default-project-upload.expected.md',
      'folder-search.expected.md',
      'scope-search.expected.md',
      'secondary-move.expected.md',
      'secondary-copy.expected.md',
      'trash-conflict.expected.md',
      'upload-busy.expected.md',
    ])
  })

  it('commits exactly the document-manager ARIA expected-output inventory', async () => {
    await assertFixtureInventory(EXPECTED_DIR, [
      'trash-header.expected.md', 'loading.expected.md', 'upload-empty.expected.md', 'upload-published.expected.md', 'upload-partial.expected.md', 'upload-recovery.expected.md', 'short-tools.expected.md',
      'short-filtered-folder.expected.md', 'overview-short-filtered.expected.md',
    ])
  })
})
