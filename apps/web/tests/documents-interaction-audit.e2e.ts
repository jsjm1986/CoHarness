/** Read-only document UI journeys through the assembled Web app. */
import { responsiveBrowser, responsiveBrowserName, responsiveMobileEmulation, responsiveViewports } from './responsive-browser.ts'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedBlankSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { compareOrRefreshGolden, webSnapshotMode } from './expected.ts'
import { completionBarrier, saveFailureShot } from './support.ts'
import { workflowMatrixEnabled } from './workflow-responsive-state.ts'
import { auditResponsiveControls } from './responsive-controls.ts'

const documentName = '客户需求与产品验收资料_完整文件名称需要方便手机阅读_2026.txt'
const folderName = '客户交付文件夹_包含完整的目录名称'
const limits = { maxFileBytes: null, maxFilesPerMessage: 20, maxMessageBytes: 100, maxInlineTextBytes: 256,
  upload: { protocol: 'resumable-v1', chunkBytes: 8388608, sessionTtlMs: 86400000, resumable: true } }
const item = { docId: 'review.txt', name: documentName, bytes: 1234, mediaType: 'text/plain', modifiedAt: 1 }
const folders = [{ directoryId: 'reports', name: folderName, path: '', modifiedAt: 1 }]

async function fixture(page: Page): Promise<void> {
  await page.route(/\/account\/api\/context(?:\?.*)?$/, route => route.fulfill({ json: {
    scope: { kind: 'personal' }, projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }, { projectId: 42, name: 'Read only', mode: 'ro' }],
  } }))
  await page.route(/\/api\/documents(?:\?.*)?$/, route => route.fulfill({ json: { limits, directoryId: '', directories: folders, documents: [item] } }))
  await page.route(/\/api\/documents\/directories(?:\?.*)?$/, route => route.fulfill({ json: { directories: folders } }))
  await page.route(/\/api\/documents\/transfer\/directories(?:\?.*)?$/,
    route => route.fulfill({ json: { version: 1, directories: folders } }))
  await page.route(/\/api\/documents\/content(?:\?.*)?$/, route => route.fulfill({ contentType: 'text/plain', body: 'Document preview: complete content remains readable.' }))
  await page.route(/\/api\/documents(?:\/scope)?\/history(?:\?.*)?$/, route => route.fulfill({ json: { version: 1, items: [
    { id: 'history', eventKind: 'upload', documentName, createdAt: 1, actor: { displayName: 'Review' } },
  ] } }))
  await page.route(/\/api\/documents(?:\/scope)?\/trash(?:\?.*)?$/, route => route.fulfill({ json: { version: 1, documents: [
    { ...item, directoryId: '', trashId: 'trash-review', incarnationId: 'review-incarnation', trashedAt: 1, purgeAfter: 9999999999999 },
  ] } }))
  await page.route(/\/api\/documents\/overview(?:\?.*)?$/, route => route.fulfill({ json: { version: 1, documents: [
    { ...item, catalogId: 'catalog-review', scope: { kind: 'personal', label: 'Personal documents' }, owner: { displayName: 'Reviewer' } },
  ] } }))
}

describe('web e2e: document interaction coverage', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let consoleState: ReturnType<typeof watchConsole>
  beforeAll(async () => { scaffold = await launchWebScaffold({}); browser = await responsiveBrowser.launch() }, 120_000)
  afterEach(async ({ task }) => {
    try {
      if (task.result?.state === 'fail' && page && !page.isClosed()) {
        await saveFailureShot(page, `documents-interaction-${page.viewportSize()?.width}`)
      }
      expect(consoleState?.pageErrors ?? []).toEqual([])
    }
    finally { await page?.close() }
  })
  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length) throw new AggregateError(failures, 'document UI audit cleanup failed')
  })

  it('closes a pending document dialog and retries failed management scripts', async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 844 }, locale: 'en-US', reducedMotion: 'reduce' })
    consoleState = watchConsole(page)
    await fixture(page)
    const scripts = new Map<string, number>()
    const releaseDocuments = completionBarrier()
    await page.route(/\/client\.(DocumentsModal|PluginManagerPage)\.js(?:\?|$)/u, async (route) => {
      const file = new URL(route.request().url()).pathname.split('/').at(-1)!
      const attempts = (scripts.get(file) ?? 0) + 1
      scripts.set(file, attempts)
      if (attempts === 1) {
        if (file === 'client.DocumentsModal.js') await releaseDocuments.promise
        await route.abort()
      }
      else await route.continue()
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const documents = page.getByRole('button', { name: 'Documents', exact: true })
    await documents.waitFor()
    expect(scripts.has('client.PluginManagerPage.js')).toBe(false)
    const manager = page.getByRole('dialog', { name: 'Document Manager', exact: true })
    let pending: string
    try {
      await documents.click()
      await manager.getByRole('status').getByText('Loading documents').waitFor()
      pending = await manager.ariaSnapshot()
      await manager.getByRole('button', { name: 'Close', exact: true }).click()
      await manager.waitFor({ state: 'hidden' })
      await expect.poll(() => documents.evaluate(element => element === document.activeElement)).toBe(true)
      await documents.click()
      await manager.getByRole('status').getByText('Loading documents').waitFor()
      expect(scripts.get('client.DocumentsModal.js')).toBe(1)
    } finally {
      releaseDocuments.resolve()
    }
    await manager.getByRole('alert').getByText('Could not open the document manager').waitFor()
    const documentFailure = await manager.ariaSnapshot()
    await manager.getByRole('button', { name: 'Retry', exact: true }).click()
    await manager.getByText(documentName, { exact: true }).waitFor()
    await manager.getByRole('button', { name: 'Close', exact: true }).click()
    await expect.poll(() => documents.evaluate(element => element === document.activeElement)).toBe(true)
    expect([...scripts]).toEqual([['client.DocumentsModal.js', 2]])

    const catalog = page.waitForResponse(response => new URL(response.url()).pathname === '/api/pluginManager/catalog')
    await page.getByRole('navigation', { name: 'Panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
    const pluginFailure = page.getByRole('alert').filter({ hasText: 'Could not open Plugins' })
    await pluginFailure.waitFor()
    expect((await catalog).ok()).toBe(true)
    await compareOrRefreshGolden(join(import.meta.dirname, 'snapshots/management-loading/states.expected.md'),
      [pending, documentFailure, await pluginFailure.ariaSnapshot()].join('\n\n'), webSnapshotMode())
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.locator('[data-plugin-panel][aria-busy="false"]').waitFor()
    expect(scripts.get('client.PluginManagerPage.js')).toBe(2)
  })

  it.each(workflowMatrixEnabled ? [
    ...responsiveViewports.map(viewport => ({ ...viewport, touch: true, theme: 'light' as const })),
    { width: 430, height: 932, touch: true, theme: 'dark' as const },
    { width: 768, height: 1024, touch: true, theme: 'dark' as const },
    { width: 1280, height: 844, touch: false, theme: 'light' as const },
  ] : [
    { width: 390, height: 844, touch: true, theme: 'light' as const },
    { width: 430, height: 932, touch: true, theme: 'dark' as const },
    { width: 844, height: 390, touch: true, theme: 'light' as const },
    { width: 768, height: 1024, touch: true, theme: 'dark' as const },
    { width: 1280, height: 844, touch: false, theme: 'light' as const },
  ])('complete menus and dialogs fit $width × $height ($theme)', async ({ width, height, touch, theme }) => {
    page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, isMobile: responsiveMobileEmulation && width < 768, locale: 'en-US', colorScheme: theme, reducedMotion: 'reduce' })
    consoleState = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, `documents-interaction-${width}`))
    const iconRequests: string[] = []
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname.endsWith('/client.FileTypeIcon.js')) iconRequests.push(pathname)
    })
    await fixture(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const compact = width < 768
    const shortViewport = width <= 1100 && height <= 480
    const fullScreenPreview = compact || shortViewport
    if (compact) await page.getByRole('button', { name: 'Open sidebar' }).click()
    const documentsButton = page.getByRole('button', { name: 'Documents', exact: true })
    await documentsButton.waitFor()
    expect(iconRequests).toEqual([])
    await documentsButton.click()
    const manager = page.getByRole('dialog', { name: 'Document Manager', exact: true })
    await manager.getByText(documentName, { exact: true }).waitFor()
    await manager.locator('img[data-document-icon]').first().waitFor()
    expect(iconRequests).toHaveLength(1)
    const out = process.env.DSH_DOCUMENT_AUDIT_SCREENSHOTS
    if (out) await mkdir(out, { recursive: true })
    const shot = async (name: string) => {
      if (out) {
        await page.screenshot({ path: join(out, `${responsiveBrowserName}-${name}-${width}-${theme}.png`) })
        await appendFile(join(out, `${responsiveBrowserName}.jsonl`), JSON.stringify({
          domain: 'documents', state: name, width, height, theme, status: 'passed',
        }) + '\n')
      }
    }
    const fit = async (dialog: ReturnType<Page['getByRole']>) => {
      const viewport = page.viewportSize()!
      await expect.poll(() => dialog.evaluate((element, bounds) => {
        const box = element.getBoundingClientRect()
        return Math.max(-box.x, -box.y, box.right - bounds.width, box.bottom - bounds.height,
          element.scrollWidth - element.clientWidth)
      }, viewport)).toBeLessThanOrEqual(1)
      await auditResponsiveControls(page, dialog, 'document interactions')
    }
    await fit(manager)
    if (compact) {
      const nav = await manager.locator('header').first().boundingBox()
      expect(nav!.height).toBeLessThanOrEqual(60)
    }
    if (touch) {
      const targetGeometry = await manager.getByRole('checkbox', { name: documentName, exact: true }).evaluate((input) => {
        const label = input.closest('label')!.getBoundingClientRect()
        const name = input.closest('[data-documents-row-kind]')!.querySelector('button')!.getBoundingClientRect()
        return { width: label.width, height: label.height, right: label.right, nameLeft: name.left }
      })
      expect(targetGeometry.width).toBeGreaterThanOrEqual(44)
      expect(targetGeometry.height).toBeGreaterThanOrEqual(44)
      expect(targetGeometry.right).toBeLessThanOrEqual(targetGeometry.nameLeft)
    }
    await shot('library')
    const rowMore = manager.getByRole('button', { name: `More actions: ${documentName}`, exact: true })
    const rowAction = async (name: string) => {
      if (compact) await rowMore.tap()
      else await rowMore.click()
      if (compact) {
        const sheet = page.getByRole('dialog', { name: 'More actions', exact: true })
        await fit(sheet)
        await sheet.getByRole('button', { name, exact: true }).click()
      } else {
        const menu = page.getByRole('menu')
        await fit(menu)
        if (touch) for (const item of await menu.getByRole('menuitem').all()) {
          expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44)
        }
        await page.getByRole('menuitem', { name, exact: true }).click()
      }
    }
    for (const [action, title] of [['Move', 'Move Documents'], ['Copy to…', 'Copy Document Snapshots'], ['Delete', 'Confirm Deletion']] as const) {
      await rowAction(action)
      const dialog = page.getByRole('dialog', { name: title, exact: true })
      await fit(dialog)
      if (title === 'Copy Document Snapshots') await dialog.getByRole('radio', { name: 'Root folder', exact: true }).waitFor()
      if (touch) for (const button of await dialog.locator('[data-documents-dialog-actions] button').all()) {
        expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      }
      await shot(action.toLowerCase().replace(/[^a-z]/g, ''))
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect.poll(() => rowMore.evaluate(el => el === document.activeElement)).toBe(true)
    }
    await rowAction('Preview')
    const preview = page.getByRole(fullScreenPreview ? 'dialog' : 'complementary', { name: `Preview: ${documentName}`, exact: true })
    await preview.getByText('Document preview: complete content remains readable.').waitFor()
    await fit(fullScreenPreview ? preview : manager)
    await shot('preview')
    if (compact) {
      for (const name of ['Move', 'Copy to…', 'Delete']) expect(await preview.getByRole('button', { name, exact: true }).innerText()).toContain(name)
    }
    await preview.getByRole('button', { name: fullScreenPreview ? 'Back to documents' : 'Close preview' }).click()

    const folderMore = manager.getByRole('button', { name: `More actions: folder ${folderName}`, exact: true })
    await folderMore.click()
    if (compact) await page.getByRole('dialog', { name: 'More actions', exact: true }).getByRole('button', { name: 'Rename', exact: true }).click()
    else await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    const rename = page.getByRole('dialog', { name: 'Rename Folder', exact: true })
    await fit(rename)
    await shot('rename')
    await rename.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(() => folderMore.evaluate(el => el === document.activeElement)).toBe(true)

    await manager.getByRole('button', { name: 'Upload information', exact: true }).click()
    const info = page.getByRole('dialog', { name: 'Upload information', exact: true })
    await fit(info)
    await info.getByRole('button', { name: 'Close', exact: true }).click()
    const toolbarAction = async (name: string) => {
      if (compact || shortViewport) {
        await manager.getByRole('button', { name: 'More actions', exact: true }).tap()
        await page.getByRole('dialog', { name: 'More actions', exact: true }).getByRole('button', { name, exact: true }).tap()
      } else if (name === 'Browse another scope' || width <= 1100 && name !== 'New Folder') {
        await manager.getByRole('button', { name: 'More actions', exact: true }).click()
        await page.getByRole('menuitem', { name, exact: true }).click()
      } else await manager.getByRole('button', { name, exact: true }).click()
    }
    await toolbarAction('New Folder')
    const create = page.getByRole('dialog', { name: 'New Folder', exact: true })
    await fit(create)
    if (compact) expect(await create.getByRole('textbox').evaluate(el => el === document.activeElement)).toBe(false)
    await create.getByRole('textbox').fill('Complete folder name')
    if (compact && height > 420) {
      await page.setViewportSize({ width, height: 420 })
      await fit(create)
      const footer = await create.locator('[data-documents-dialog-actions]').boundingBox()
      expect(footer!.y+footer!.height).toBeLessThanOrEqual(421)
      await shot('keyboard-space')
      await page.setViewportSize({ width, height })
    }
    await create.getByRole('button', { name: 'Cancel', exact: true }).click()
    await toolbarAction('History')
    const history = page.getByRole('dialog', { name: 'Document operation history', exact: true })
    await fit(history)
    await history.getByText(documentName, { exact: false }).waitFor()
    await shot('history')
    await history.getByRole('button', { name: 'Close', exact: true }).click()
    await toolbarAction('Browse another scope')
    const source = page.getByRole('dialog', { name: 'Choose a document source', exact: true })
    await fit(source)
    await shot('source')
    await source.getByRole('button', { name: compact || shortViewport ? 'Close' : 'Cancel', exact: true }).click()
    await toolbarAction('Trash')
    await manager.getByRole('heading', { name: 'Trash', exact: true }).waitFor()
    await fit(manager)
    await manager.getByRole('button', { name: `Delete permanently ${documentName}`, exact: true }).click()
    const purge = page.getByRole('dialog', { name: 'Delete permanently', exact: true })
    await fit(purge)
    const contrast = await purge.getByRole('button', { name: 'Delete permanently', exact: true }).evaluate((element) => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const context = canvas.getContext('2d')!
      const rgba = (color: string) => {
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = color
        context.fillRect(0, 0, 1, 1)
        return [...context.getImageData(0, 0, 1, 1).data].map(value => value / 255)
      }
      const over = (fg: number[], bg: number[]) => [0, 1, 2].map(i => fg[i]! * fg[3]! + bg[i]! * (1 - fg[3]!))
      let background = [1, 1, 1]
      const layers: Element[] = []
      for (let node: Element | null = element; node !== null; node = node.parentElement) layers.unshift(node)
      for (const node of layers) background = over(rgba(getComputedStyle(node).backgroundColor), background)
      const foreground = over(rgba(getComputedStyle(element).color), background)
      const luminance = (rgb: number[]) => rgb.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
        .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i]!, 0)
      const a = luminance(foreground), b = luminance(background)
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
    })
    expect(contrast).toBeGreaterThanOrEqual(4.5)
    await shot('purge')
    await purge.getByRole('button', { name: 'Cancel', exact: true }).click()
    await manager.locator('section[aria-label="Trash"]').getByRole('button', { name: 'Back to documents', exact: true }).click()
    await manager.getByRole('button', { name: `Preview ${documentName}`, exact: true }).waitFor()

    if (compact) {
      await manager.getByRole('button', { name: 'More actions', exact: true }).click()
      const sheet = page.getByRole('dialog', { name: 'More actions', exact: true })
      await fit(sheet)
      await sheet.getByRole('radio', { name: 'Name', exact: true }).check()
      await sheet.getByRole('radio', { name: 'Z to A', exact: true }).check()
      await shot('tools')
      await sheet.getByRole('button', { name: 'Close', exact: true }).click()
      const scope = manager.locator('[data-documents-scope-trigger]')
      await scope.click()
      const scopes = page.getByRole('dialog', { name: 'Choose document scope', exact: true })
      const search = scopes.getByRole('textbox', { name: 'Search document scopes' })
      await search.fill('Compiler')
      await fit(scopes)
      const geometry = await search.evaluate(el => ({ right: el.getBoundingClientRect().right, parent: el.closest('[data-documents-sheet-scrollport]')!.getBoundingClientRect().right }))
      expect(geometry.right).toBeLessThanOrEqual(geometry.parent)
      await search.fill('')
      await shot('scopes')
      await scopes.getByRole('button', { name: 'Close', exact: true }).tap()
      await expect.poll(() => scope.evaluate(el => el === document.activeElement)).toBe(true)
      await scope.tap()
      await scopes.getByRole('button', { name: /All accessible documents/ }).tap()
    } else if (width <= 1100) {
      await manager.locator('[data-documents-scope-trigger]').click()
      await page.getByRole('dialog', { name: 'Choose document scope', exact: true }).getByRole('button', { name: /All accessible documents/ }).click()
    } else await manager.getByRole('button', { name: /All accessible documents/ }).click()
    await manager.getByRole('region', { name: 'All accessible documents', exact: true }).waitFor()
    await fit(manager)
    await shot('overview')
    await manager.getByRole('button', { name: 'Choose upload scope', exact: true }).click()
    const uploadScope = page.getByRole('dialog', { name: 'Choose upload scope', exact: true })
    await fit(uploadScope)
    await shot('upload-scope')
    await uploadScope.getByRole('button', { name: compact ? 'Close' : 'Cancel', exact: true }).click()
    expect(await manager.locator('[data-documents-browse-body]').getAttribute('inert')).not.toBeNull()
    const visibleButtons = manager.locator('button:visible:not([disabled])')
    await visibleButtons.last().focus()
    await page.keyboard.press('Tab')
    expect(await manager.evaluate(el => el.contains(document.activeElement))).toBe(true)
    await manager.getByRole('button', { name: 'Close', exact: true }).click()
    expect(await page.getByRole('dialog').count()).toBe(0)
  }, 90_000)
  it.each([false, true])('prepares manager code after the composer paints (background failure: %s)', async (fail) => {
    page = await browser.newPage({ viewport: { width: 1280, height: 844 }, locale: 'en-US', reducedMotion: 'reduce' })
    consoleState = watchConsole(page)
    await fixture(page)
    const sessionId = await seedBlankSession(scaffold, fail ? 'document-preparation-failure' : 'document-preparation-success', scaffold.workspaceCwd)
    await (await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)).attachSession(sessionId)
    await page.addInitScript((id) => {
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
    }, sessionId)

    const script = /\/client\.DocumentsModal\.js(?:\?|$)/u
    const editable = page.locator('[data-composer-card] textarea:enabled:not([readonly])').first()
    const firstRequest = Promise.withResolvers<boolean>()
    const release = completionBarrier()
    const dataOrArtwork: string[] = []
    let attempts = 0
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname
      if (/^\/api\/documents(?:\/|$)|\/client\.FileTypeIcon\.js$/u.test(pathname)) dataOrArtwork.push(pathname)
    })
    await page.route(script, async (route) => {
      attempts++
      if (attempts === 1) {
        firstRequest.resolve(await editable.isVisible())
        await release.promise
        if (fail) {  await route.abort(); return }
      }
      await route.continue()
    })

    const documents = page.getByRole('button', { name: 'Documents', exact: true })
    const manager = page.getByRole('dialog', { name: 'Document Manager', exact: true })
    try {
      await Promise.all([
        page.waitForRequest(script, { timeout: 10_000 }),
        page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' }),
      ])
      expect(await firstRequest.promise).toBe(true)
      expect(dataOrArtwork).toEqual([])
      expect(await manager.count()).toBe(0)
      await editable.fill('Draft entered during document preparation')
      expect(await editable.inputValue()).toBe('Draft entered during document preparation')
      if (fail) {
        const rejected = page.waitForEvent('requestfailed', request => script.test(request.url()))
        release.resolve()
        await rejected
        await page.locator('script[src*="/client.DocumentsModal.js"]').waitFor({ state: 'detached' })
        expect(await page.getByRole('alert').filter({ hasText: 'Could not open the document manager' }).count()).toBe(0)
      }
      await documents.click()
      if (!fail) {
        await manager.getByRole('status').getByText('Loading documents').waitFor()
        expect(attempts).toBe(1)
        release.resolve()
      }
      await manager.getByText(documentName, { exact: true }).waitFor()
      expect(attempts).toBe(fail ? 2 : 1)
    } finally {
      release.resolve()
    }
  })

})
