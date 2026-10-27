/** Real Office conversion and PDF rendering through the shipped authorized Workspace preview. */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type Response } from 'playwright'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-office-to-pdf'
import { realOfficeBytes } from './office-fixture.ts'
import { pdfResourceFixture } from '../../../packages/client/ui-workbench/tests/pdf-resource-fixture.ts'
import { launchWebScaffold, seedSession, watchConsole, captureStableAria, compareOrRefreshGolden, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { expectPdfResolution, hideDocumentZoom, newEnglishPage, revealDocumentZoom, saveFailureShot } from './support.ts'

const FORMATS = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'] as const
// Workbooks take the read-only browser-parsed sheet surface, not Office→PDF.
const SPREADSHEETS: ReadonlySet<string> = new Set(['xlsx', 'xls'])
const PDF_RESOURCES = ['vector', 'standard', 'cjk', 'jpx', 'jbig2'] as const
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./snapshots/workspace-office/pdf.expected.md', import.meta.url))

describe('web e2e: authorized Office preview', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let metadataRoot: string | undefined
  const resourceRequests: string[] = []
  beforeAll(async () => {
    metadataRoot = await mkdtemp(join(tmpdir(), 'dsh-office-metadata-web-'))
    const metadata = join(metadataRoot, 'metadata')
    await mkdir(metadata, { mode: 0o700 })
    await writeFile(join(metadata, 'font-metadata.json'), '{invalid', { flag: 'wx', mode: 0o600 })
    const overlay = join(metadataRoot, 'cordis.patch.yml')
    await writeFile(overlay, `- id: office-to-pdf\n  config:\n    fontMetadataCacheDirectory: ${JSON.stringify(metadata)}\n- id: connection\n  config:\n    serverTiming: true\n`,
      { flag: 'wx', mode: 0o600 })
    scaffold = await launchWebScaffold({ workbench: true, extraOverlayPath: overlay })
    expect(scaffold.ctx.get('officeToPdf')).toBeDefined()
    for (const extension of FORMATS) await writeFile(join(scaffold.workspaceCwd, `preview.${extension}`), realOfficeBytes(extension))
    for (const kind of PDF_RESOURCES) await writeFile(join(scaffold.workspaceCwd, `resource-${kind}.pdf`), pdfResourceFixture(kind))
    await writeFile(join(scaffold.workspaceCwd, 'broken.docx'), 'This is not an Office archive.')
    const links = [
      ...FORMATS.map(extension => `[Preview ${extension}](preview.${extension})`),
      ...PDF_RESOURCES.map(kind => `[Resource ${kind}](resource-${kind}.pdf)`), '[Broken document](broken.docx)',
    ].join('\n\n')
    const source = (await readFile(SEED, 'utf8')).replace('"text":"DONE"', `"text":${JSON.stringify(links)}`)
    const history = await seedSession(scaffold, source, 'workspace-office-history')
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(history)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (/\/client\.(?:cmaps|fonts|wasm)\.js$/u.test(path)) resourceRequests.push(path)
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  }, 120_000)
  afterAll(async () => {
    try { await browser?.close() }
    finally {
      try { await scaffold?.close() }
      finally { if (metadataRoot !== undefined) await rm(metadataRoot, { recursive: true, force: true }) }
    }
  })

  it('loads binary groups only for real PDFs that need them and reuses the loaded decoder group', async () => {
    const tripwire = watchConsole(page)
    for (const kind of PDF_RESOURCES) {
      await page.getByRole('button', { name: `Resource ${kind}`, exact: true }).click()
      const preview = page.getByRole('region', { name: `resource-${kind}.pdf`, exact: true })
      const canvas = preview.locator('canvas').first()
      await canvas.waitFor({ state: 'visible' })
      await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(0)
      await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
        const context = element.getContext('2d')!
        const data = context.getImageData(0, 0, element.width, element.height).data
        return data.some((value, index) => index % 4 === 3 && value > 200
          && (data[index - 3]! < 200 || data[index - 2]! < 200 || data[index - 1]! < 200))
      })).toBe(true)
      if (kind === 'vector') expect(resourceRequests).toEqual([])
      if (kind === 'standard') expect(resourceRequests.filter(path => path.endsWith('/client.fonts.js'))).toHaveLength(1)
      if (kind === 'cjk') {
        await preview.locator('[data-pdf-text]').getByText('日本語', { exact: false }).waitFor()
        expect(resourceRequests.filter(path => path.endsWith('/client.cmaps.js'))).toHaveLength(1)
      }
      if (kind === 'jpx' || kind === 'jbig2') {
        expect(resourceRequests.filter(path => path.endsWith('/client.wasm.js'))).toHaveLength(1)
      }
      await preview.getByRole('button', { name: 'Close preview', exact: true }).click()
      await expect.poll(() => preview.count()).toBe(0)
    }
    expect(resourceRequests).toHaveLength(3)
    expect(tripwire.pageErrors).toEqual([])
  })

  it.each(['docx', 'xlsx'] as const)('prepares the selected %s preview while metadata is pending', async (extension) => {
    if (scaffold === undefined || browser === undefined) throw new Error('Web scaffold is unavailable')
    const previewPage = await newEnglishPage(browser)
    const release = Promise.withResolvers<undefined>()
    const requests: string[] = []
    const conversions: Response[] = []
    let workerStarts = 0
    previewPage.on('request', request => requests.push(new URL(request.url()).pathname))
    previewPage.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/workspaceFiles.renderOffice') conversions.push(response)
    })
    previewPage.on('worker', () => { workerStarts += 1 })
    try {
      onTestFailed(() => saveFailureShot(previewPage, `workspace-viewer-before-stat-${extension}`))
      await previewPage.route('**/api/workspaceFiles.stat*', async (route) => {
        await release.promise
        await route.continue()
      })
      await previewPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await previewPage.getByRole('button', { name: `Preview ${extension}`, exact: true }).click()
      await expect.poll(() => requests.includes('/api/workspaceFiles.stat')).toBe(true)
      const selected = extension === 'docx' ? '/client.pdf.js' : '/client.excel.js'
      const other = extension === 'docx' ? '/client.excel.js' : '/client.pdf.js'
      await expect.poll(() => requests.filter(path => path.endsWith(selected)).length).toBe(1)
      expect(requests.some(path => path.endsWith(other))).toBe(false)
      if (extension === 'docx') {
        await expect.poll(() => requests.filter(path => path === '/api/workspaceFiles.renderOffice').length).toBe(1)
        await expect.poll(() => conversions.length, { timeout: 60_000 }).toBe(1)
        const response = conversions[0]!
        expect(response.ok()).toBe(true)
        expect(await response.finished()).toBeNull()
        const body = await response.json() as { result: { ok: boolean } }
        expect(body.result.ok).toBe(true)
        expect(await previewPage.locator('[data-pdf-preview]').count()).toBe(0)
      } else {
        expect(requests.some(path => /\/api\/workspaceFiles\.(?:readBytes|renderOffice)$/u.test(path))).toBe(false)
      }
      expect(workerStarts).toBe(0)
      release.resolve(undefined)
      const preview = previewPage.getByRole('region', { name: `preview.${extension}`, exact: true })
      const content = preview.locator(extension === 'docx' ? '[data-pdf-text]' : '#luckysheet-functionbox-cell')
      await expect.poll(async () => (await content.allTextContents()).join(''), { timeout: 60_000 }).toContain('Office preview')
      expect(workerStarts).toBeGreaterThan(0)
      if (extension === 'docx') {
        expect(requests.filter(path => path === '/api/workspaceFiles.renderOffice')).toHaveLength(1)
        await compareOrRefreshGolden(GOLDEN,
          await captureStableAria(previewPage, '[data-pdf-preview]', scaffold.workspaceCwd), webSnapshotMode())
      }
    } finally {
      release.resolve(undefined)
      try { await previewPage.unrouteAll({ behavior: 'wait' }) }
      finally { await previewPage.close() }
    }
  })

  it.each(['docx', 'xlsx'] as const)('keeps the %s viewer through an authorized reread of identical bytes', async (extension) => {
    if (scaffold === undefined || browser === undefined) throw new Error('Web scaffold is unavailable')
    const fixture = scaffold
    const file = join(fixture.workspaceCwd, `preview.${extension}`)
    const original = await readFile(file)
    const replacement = join(fixture.workspaceCwd, `reload-replacement.${extension}`)
    const release = Promise.withResolvers<undefined>()
    const endpoint = extension === 'docx' ? '/api/workspaceFiles.renderOffice' : '/api/workspaceFiles.readBytes'
    const reloadPage = await newEnglishPage(browser)
    let workerStarts = 0
    try {
      onTestFailed(() => saveFailureShot(reloadPage, `workspace-unchanged-${extension}`))
      await reloadPage.goto(fixture.authenticatedUrl, { waitUntil: 'load' })
      reloadPage.on('worker', () => { workerStarts += 1 })
      await reloadPage.getByRole('button', { name: `Preview ${extension}`, exact: true }).click()
      const preview = reloadPage.getByRole('region', { name: `preview.${extension}`, exact: true })
      const content = preview.locator(extension === 'docx' ? '[data-pdf-text]' : '#luckysheet-functionbox-cell')
      const text = async (): Promise<string> => (await content.allTextContents()).join('')
      await expect.poll(text, { timeout: 60_000 }).toContain('Office preview')
      const canvas = preview.locator('canvas').first()
      await canvas.waitFor({ state: 'visible' })
      const initialCanvas = await canvas.elementHandle()
      if (initialCanvas === null) throw new Error('Rendered canvas is unavailable')
      const initialWorkers = workerStarts
      expect(initialWorkers).toBeGreaterThan(0)
      const initialAlerts = await preview.getByRole('alert').allTextContents()
      const reload = preview.getByRole('button', { name: 'Reload', exact: true })
      await reloadPage.route(`**${endpoint}*`, async (route) => {
        await release.promise
        await route.continue()
      })
      const reread = await Promise.allSettled([
        reloadPage.waitForRequest(request => new URL(request.url()).pathname === endpoint),
        reload.click(),
      ])
      for (const outcome of reread) if (outcome.status === 'rejected') throw outcome.reason
      expect(await reload.isEnabled()).toBe(false)
      expect(await initialCanvas.isVisible()).toBe(true)
      release.resolve(undefined)
      await expect.poll(() => reload.isEnabled()).toBe(true)
      expect(await preview.getByRole('alert').allTextContents()).toEqual(initialAlerts)
      await expect.poll(text).toContain('Office preview')
      await canvas.waitFor({ state: 'visible' })
      expect(await initialCanvas.evaluate(element => element.isConnected)).toBe(true)
      expect(workerStarts).toBe(initialWorkers)
      await reloadPage.unrouteAll({ behavior: 'wait' })
      if (extension === 'docx') {
        await compareOrRefreshGolden(GOLDEN,
          await captureStableAria(reloadPage, '[data-pdf-preview]', fixture.workspaceCwd), webSnapshotMode())
      }

      const part = extension === 'docx' ? 'word/document.xml' : 'xl/worksheets/sheet1.xml'
      const files = unzipSync(original)
      const updated = strFromU8(files[part]!).replace('Office preview 中文文档', 'Updated preview content')
      expect(updated).not.toBe(strFromU8(files[part]!))
      files[part] = strToU8(updated)
      await writeFile(replacement, zipSync(files), { flag: 'wx' })
      await rename(replacement, file)
      await reload.click()
      await expect.poll(text, { timeout: 60_000 }).toContain('Updated preview content')
      await expect.poll(() => reload.isEnabled()).toBe(true)
      expect(await initialCanvas.evaluate(element => element.isConnected)).toBe(false)
      expect(workerStarts).toBeGreaterThan(initialWorkers)
    } finally {
      release.resolve(undefined)
      try { await reloadPage.unrouteAll({ behavior: 'wait' }) }
      finally {
        try {
          await writeFile(file, original)
          await rm(replacement, { force: true })
        } finally { await reloadPage.close() }
      }
    }
  })

  it.each(FORMATS)('previews %s with the installed surface and selectable content', async (extension) => {
    if (scaffold === undefined) throw new Error('Web scaffold is unavailable')
    onTestFailed(() => saveFailureShot(page, `workspace-office-${extension}`))
    const tripwire = watchConsole(page)
    const button = page.getByRole('button', { name: `Preview ${extension}`, exact: true })
    let renderResponse: Response | undefined
    if (extension === 'docx') {
      const outcomes = await Promise.allSettled([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspaceFiles.renderOffice'),
        button.click(),
      ])
      for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
      if (outcomes[0].status === 'fulfilled') renderResponse = outcomes[0].value
    } else {
      await button.click()
    }
    const preview = page.getByRole('region', { name: `preview.${extension}`, exact: true })
    if (SPREADSHEETS.has(extension)) {
      const sheet = preview.locator('[data-excel-preview]')
      await sheet.waitFor({ timeout: 60_000 })
      // A1 is selected on load; the formula bar exposes the stored cell text.
      await expect.poll(
        () => preview.locator('#luckysheet-functionbox-cell').textContent(),
        { timeout: 60_000 },
      ).toContain('Office preview')
    } else {
      await preview.locator('[data-pdf-text]').getByText('Office preview', { exact: false }).first().waitFor({ timeout: 60_000 })
    }
    const canvas = preview.locator('canvas').first()
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.width > 0 && element.height > 0)).toBe(true)
    expect(await canvas.evaluate((element: HTMLCanvasElement) => {
      const bytes = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
      return bytes.some((value, index) => index % 4 !== 3 && value < 200)
    })).toBe(true)
    if (extension === 'docx') {
      if (renderResponse === undefined) throw new Error('Office response observation is unavailable')
      const headers = await renderResponse.allHeaders()
      expect(headers['server-timing']).toMatch(/^dsh_rpc;dur=\d+\.\d{2}, dsh_conn;dur=\d+\.\d{2}$/)
      if (metadataRoot === undefined) throw new Error('Metadata fixture is unavailable')
      const metadata = JSON.parse(await readFile(join(metadataRoot, 'metadata/font-metadata.json'), 'utf8')) as {
        format: number
        records: unknown[]
      }
      expect(metadata.format).toBe(1)
      expect(metadata.records.length).toBeGreaterThan(0)
      const snapshot = await captureStableAria(page, '[data-pdf-preview]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(GOLDEN, snapshot, webSnapshotMode())
      const zoomControls = preview.locator('[data-document-zoom-controls]')
      await expect.poll(() => zoomControls.getAttribute('data-document-zoom-visible')).toBeNull()
      await expectPdfResolution(canvas)
      let zoomMenu = await revealDocumentZoom(page, preview)
      await hideDocumentZoom(page, preview)
      zoomMenu = await revealDocumentZoom(page, preview)
      const cssWidth = (await canvas.boundingBox())!.width
      const intrinsicWidth = await canvas.evaluate(node => Number.parseFloat(node.style.getPropertyValue('--pdf-page-width')))
      await zoomMenu.click()
      await page.getByRole('menuitem', { name: '150%', exact: true }).click()
      await expect.poll(async () => (await canvas.boundingBox())!.width / intrinsicWidth).toBeCloseTo(1.5, 1)
      await expectPdfResolution(canvas)
      const zoomScrollport = preview.locator('[data-document-zoom-scrollport]')
      expect(await zoomScrollport.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)
      // The selectable text layer survives the device-resolution redraw.
      await expect.poll(async () => (await preview.locator('[data-pdf-text]').allTextContents()).join(''))
        .toContain('Office preview')
      zoomMenu = await revealDocumentZoom(page, preview)
      await zoomMenu.click()
      await page.getByRole('menuitem', { name: 'Fit width', exact: true }).click()
      await expect.poll(async () => (await canvas.boundingBox())!.width).toBeCloseTo(cssWidth, 0)
      await expectPdfResolution(canvas)
      expect(await zoomScrollport.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false)
    }
    await preview.getByRole('button', { name: 'Close preview', exact: true }).click()
    await expect.poll(() => preview.count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('reports a damaged document without displaying a successful PDF', async () => {
    await page.getByRole('button', { name: 'Broken document', exact: true }).click()
    const preview = page.getByRole('region', { name: 'broken.docx', exact: true })
    await preview.getByRole('alert').waitFor({ timeout: 60_000 })
    expect(await preview.locator('[data-pdf-preview]').count()).toBe(0)
    expect(await preview.getByRole('button', { name: 'Reload', exact: true }).isEnabled()).toBe(true)
  }, 90_000)
})
