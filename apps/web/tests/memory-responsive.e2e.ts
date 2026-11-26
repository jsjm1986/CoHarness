/** Durable memory CRUD, keyboard disclosure and narrow layouts through the shipped Web application. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { clientSessionKey, RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-memory'
import type { MemoryEntry } from '@deepseek-ai/dsh-memory/client'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, webSnapshotMode, watchConsole, type WebScaffold } from './scaffold.ts'
import { centerControlInScrollports, expectViewportFit, responsiveBrowser, responsiveBrowserName, responsiveMobileEmulation, responsiveViewports } from './responsive-browser.ts'
import { saveFailureShot } from './support.ts'
import { auditResponsiveControl } from './responsive-controls.ts'
import { captureTextContrast, expectTextContrast } from './text-contrast.ts'
import { expectSwitchContrast } from './switch-contrast.ts'
import { expectControlBoundaryContrast } from './control-boundary-contrast.ts'
import { auditWorkflowState, newWorkflowPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'

const SESSION = SessionId('memory-responsive-root')
const GOLDEN = fileURLToPath(new URL('./snapshots/memory-responsive/editor.expected.md', import.meta.url))

async function openMemory(page: Page, world: WebScaffold): Promise<void> {
  await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
  await page.locator('[data-sidebar-right-guide-entry="memory"]').click()
  await page.getByRole('textbox', { name: 'Search memory', exact: true }).waitFor()
}

/** Measure memory actions and feedback with the shared rendered-text checks. */
async function expectMemoryContrast(page: Page, controls: readonly Locator[], state: string): Promise<void> {
  expectTextContrast(await captureTextContrast(page,
    controls.map((text, index) => ({ label: `text-${index}`, text })), `memory-${state}`))
}

/** Inspect feedback in its current position without scrolling it into reach. */
async function expectFeedbackVisible(feedback: Locator): Promise<void> {
  await expect.poll(() => feedback.evaluate((node) => {
    const box = node.getBoundingClientRect()
    let top = 0; let bottom = innerHeight; let left = 0; let right = innerWidth
    for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      const clip = parent.getBoundingClientRect()
      if (style.overflowY !== 'visible') { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom) }
      if (style.overflowX !== 'visible') { left = Math.max(left, clip.left); right = Math.min(right, clip.right) }
    }
    return box.width > 0 && box.height > 0 && box.top >= top - 1 && box.bottom <= bottom + 1
      && box.left >= left - 1 && box.right <= right + 1
      && node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
  })).toBe(true)
}

describe('web e2e: responsive memory', () => {
  let scaffold: WebScaffold
  let browser: Browser
  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const result = await scaffold.ctx.apiProxy.sessions.create({ rpcId: RpcId('memory-create'), payload: { sessionId: SESSION, cwd: scaffold.workspaceCwd } })
    if (!result.result.ok) throw new Error(result.result.error.message)
    await (await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)).attachSession(SESSION)
    browser = await responsiveBrowser.launch()
  })
  afterAll(async () => { try { await browser?.close() } finally { await scaffold?.close() } })

  it.each([{ width: 872, height: 229 }, { width: 568, height: 230 }, { width: 390, height: 320 }])(
    'keeps the editor usable at $width × $height when browser chrome reduces the available height', async ({ width, height }) => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-US', hasTouch: true,
        isMobile: responsiveMobileEmulation, reducedMotion: 'reduce' })
      const tripwire = watchConsole(page)
      try {
        await openMemory(page, scaffold)
        await page.getByRole('button', { name: 'New', exact: true }).tap()
        const key = `short-panel-${width}-${height}`
        const content = page.getByLabel('Content', { exact: true })
        const draft = 'Long memory content retains its draft during native rotation. '.repeat(10)
        await page.getByLabel('Key', { exact: true }).fill(key)
        await page.getByLabel('Summary', { exact: true }).fill('Short-height editor')
        await content.fill(draft)
        await content.blur()
        await page.setViewportSize({ width, height })
        const panel = page.locator('div[data-sidebar-right-tab]').filter({ has: content })
        const save = page.getByRole('button', { name: 'Save', exact: true })
        for (const control of [page.getByLabel('Kind', { exact: true }), page.getByLabel('Key', { exact: true }),
          page.getByLabel('Summary', { exact: true }), content, save, page.getByRole('button', { name: 'Cancel', exact: true })]) {
          await auditResponsiveControl(page, control, 'memory-focused-field', 'center')
          await expectViewportFit(page, panel, [control])
          await centerControlInScrollports(control)
          const clipped = await control.evaluate((element) => {
            const box = element.getBoundingClientRect()
            const ancestors: string[] = []
            for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
              if (!['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(parent).overflowY)) continue
              const bounds = parent.getBoundingClientRect()
              if (box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1) ancestors.push(parent.className)
            }
            return ancestors
          })
          expect(clipped, await control.getAttribute('id') ?? 'editor action').toEqual([])
          expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44)
        }
        expect(await content.inputValue()).toBe(draft)
        await content.scrollIntoViewIfNeeded()
        const directory = process.env.DSH_MOBILE_SCREENSHOTS
        if (directory !== undefined) {
          await mkdir(directory, { recursive: true })
          await page.screenshot({ path: join(directory, `memory-short-${responsiveBrowserName}-${width}-${height}.png`), animations: 'disabled' })
        }
        await page.setViewportSize({ width: 390, height: 844 })
        expect(await content.inputValue()).toBe(draft)
        await expect.poll(async () => (await content.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(140)
        await save.tap()
        await page.getByText(key, { exact: true }).waitFor()
        expect(tripwire.pageErrors).toEqual([])
      } catch (error) { await saveFailureShot(page, `memory-short-${responsiveBrowserName}-${width}-${height}`); throw error }
      finally { await page.close() }
    })

  it('desktop pointer keeps the editor and tab controls aligned', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US', reducedMotion: 'reduce' })
    try {
      await openMemory(page, scaffold)
      await page.getByRole('button', { name: 'New', exact: true }).click()
      const save = page.getByRole('button', { name: 'Save', exact: true })
      await expectViewportFit(page, page.locator('div[data-sidebar-right-tab]').filter({ has: save }), [save])
      const rightbar = page.locator('[data-sidebar-right-panel][data-sidebar-right-open]')
      const composer = page.locator('[data-composer-seat]')
      for (const control of [composer.getByRole('button', { name: /^Select model/ }),
        composer.getByRole('button', { name: 'Send message', exact: true })]) {
        await expect.poll(async () => {
          const panel = await rightbar.boundingBox()
          const button = await control.boundingBox()
          return panel === null || button === null ? Infinity : button.x + button.width - panel.x
        }, { message: 'New Session controls stay beside the open Memory panel' }).toBeLessThanOrEqual(1)
      }
      const desktopGolden = fileURLToPath(new URL('./snapshots/memory-responsive/desktop-composer.expected.md', import.meta.url))
      await compareOrRefreshGolden(desktopGolden, await captureStableAria(page, '[data-composer-seat]', scaffold.workspaceCwd), webSnapshotMode())
      const directory = process.env.DSH_MOBILE_SCREENSHOTS
      if (directory !== undefined) {
        await mkdir(directory, { recursive: true })
        await page.screenshot({ path: join(directory, `memory-${responsiveBrowserName}-desktop-pointer.png`), animations: 'disabled' })
      }
    } finally { await page.close() }
  })

  it.each(responsiveViewports)('$name creates, searches, expands with the keyboard, edits and deletes a durable entry', async ({ width, height, name }) => {
    const page = await browser.newPage({ viewport: { width, height }, locale: 'en-US', hasTouch: true,
      isMobile: responsiveMobileEmulation && width < 768, reducedMotion: 'reduce' })
    const tripwire = watchConsole(page)
    const key = `responsive-${width}-${height}`
    const summary = 'A durable memory with a long readable summary across phone and tablet layouts'
    try {
      await openMemory(page, scaffold)
      const panel = page.locator('div[data-sidebar-right-tab]').filter({ has: page.getByRole('textbox', { name: 'Search memory', exact: true }) })
      const create = panel.getByRole('button', { name: 'New', exact: true })
      await expectViewportFit(page, panel, [create, panel.getByRole('button', { name: 'Refresh', exact: true })])
      for (const control of [create, panel.getByRole('button', { name: 'Refresh', exact: true })]) {
        expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44)
      }
      await create.click()
      const kind = panel.getByLabel('Kind', { exact: true })
      const keyField = panel.getByLabel('Key', { exact: true })
      const summaryField = panel.getByLabel('Summary', { exact: true })
      const content = panel.getByLabel('Content', { exact: true })
      const save = panel.getByRole('button', { name: 'Save', exact: true })
      const cancel = panel.getByRole('button', { name: 'Cancel', exact: true })
      await expectViewportFit(page, panel, [kind, keyField, summaryField, content, save, cancel])
      for (const control of [kind, keyField, summaryField, content]) {
        expect(await control.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16)
        expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44)
      }
      await kind.evaluate((element) => { element.style.fontSize = '32px' })
      expect((await kind.boundingBox())?.height).toBeGreaterThanOrEqual(52)
      await kind.evaluate((element) => { element.style.fontSize = '' })
      for (const control of [save, cancel]) expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44)
      if (width === 390 && height === 844) {
        await compareOrRefreshGolden(GOLDEN, await captureStableAria(page, 'div[data-sidebar-right-tab]:has(input[aria-label="Search memory"])', scaffold.workspaceCwd), webSnapshotMode())
      }
      if (process.env.DSH_MOBILE_SCREENSHOTS !== undefined) {
        await mkdir(process.env.DSH_MOBILE_SCREENSHOTS, { recursive: true })
        await page.screenshot({ path: join(process.env.DSH_MOBILE_SCREENSHOTS, `memory-editor-${responsiveBrowserName}-${name}.png`), animations: 'disabled' })
      }
      await kind.selectOption('guidance')
      await keyField.fill(key)
      await summaryField.fill(summary)
      await content.fill('Keep the original requirement intact.\n' + 'Long memory content remains selectable and scrollable. '.repeat(30))
      await save.click()
      const search = panel.getByRole('textbox', { name: 'Search memory', exact: true })
      await search.fill(key)
      const disclosure = panel.getByRole('button', { name: new RegExp(key) })
      await disclosure.waitFor()
      expect(await disclosure.getAttribute('aria-expanded')).toBe('false')
      await disclosure.focus()
      await page.keyboard.press('Enter')
      await expect.poll(() => disclosure.getAttribute('aria-expanded')).toBe('true')
      await panel.getByText('Keep the original requirement intact.', { exact: false }).waitFor()
      const edit = panel.getByRole('button', { name: 'Edit memory', exact: true })
      await expectViewportFit(page, panel, [edit, panel.getByRole('button', { name: 'Delete', exact: true })])
      await expectMemoryContrast(page, [edit, panel.getByRole('button', { name: 'Delete', exact: true })], `${name}-expanded`)
      await edit.click()
      expect(await keyField.isDisabled()).toBe(true)
      await summaryField.fill('Edited durable memory')
      await save.click()
      await panel.getByText('Edited durable memory', { exact: true }).waitFor()
      if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click()
      await disclosure.scrollIntoViewIfNeeded()
      const directory = process.env.DSH_MOBILE_SCREENSHOTS
      if (directory !== undefined) {
        await mkdir(directory, { recursive: true })
        await page.screenshot({ path: join(directory, `memory-${responsiveBrowserName}-${name}.png`), animations: 'disabled' })
      }
      await panel.getByRole('button', { name: 'Delete', exact: true }).click()
      const confirmation = panel.getByText('Delete this memory? This cannot be undone.', { exact: true })
      const cancelDelete = panel.getByRole('button', { name: 'Cancel', exact: true })
      await confirmation.waitFor()
      await expectViewportFit(page, panel, [cancelDelete, panel.getByRole('button', { name: 'Delete', exact: true })])
      expect((await cancelDelete.boundingBox())?.height).toBeGreaterThanOrEqual(44)
      const deleteBox = await panel.getByRole('button', { name: 'Delete', exact: true }).boundingBox()
      const cancelBox = await cancelDelete.boundingBox()
      expect(Math.abs(deleteBox!.y - cancelBox!.y), 'Delete and Cancel stay on the same row').toBeLessThanOrEqual(1)
      expect(cancelBox!.x - deleteBox!.x - deleteBox!.width, 'paired actions retain their gap').toBeGreaterThanOrEqual(8)
      await expectMemoryContrast(page, [confirmation, cancelDelete,
        panel.getByRole('button', { name: 'Delete', exact: true })], `${name}-delete-confirmation`)
      if (width === 390 && height === 844) {
        const golden = fileURLToPath(new URL('./snapshots/memory-responsive/delete-confirmation.expected.md', import.meta.url))
        await compareOrRefreshGolden(golden, await captureStableAria(page, '[data-memory-delete-confirmation]', scaffold.workspaceCwd), webSnapshotMode())
      }
      await cancelDelete.click()
      await expect.poll(() => confirmation.count()).toBe(0)
      expect(await disclosure.evaluate(element => element === document.activeElement)).toBe(true)
      expect((await scaffold.ctx.memory.entries({ kind: 'personal' })).some(entry => String(entry.key) === key)).toBe(true)
      await panel.getByRole('button', { name: 'Delete', exact: true }).click()
      await confirmation.waitFor()
      await disclosure.click()
      await disclosure.click()
      expect(await confirmation.count()).toBe(0)
      await panel.getByRole('button', { name: 'Delete', exact: true }).click()
      await confirmation.waitFor()
      await panel.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect.poll(() => disclosure.count()).toBe(0)
      expect((await scaffold.ctx.memory.entries({ kind: 'personal' })).some(entry => String(entry.key) === key)).toBe(false)
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, `memory-${responsiveBrowserName}-${name}`)
      throw error
    } finally { await page.close() }
  })

  it.each(responsiveViewports)('$name preserves a changed memory and draft after stale or failed deletion', async ({ name, width, height }) => {
    const key = `delete-refusal-${width}-${height}`
    const original = await scaffold.ctx.memory.save({ scope: { kind: 'personal' }, key, kind: 'guidance', summary: 'Refusal fixture', content: 'Original memory' }, { kind: 'member' })
    if (!original.ok) throw new Error(`Memory fixture refused: ${original.code}`)
    const page = await browser.newPage({ viewport: { width, height }, locale: 'en-US', hasTouch: true,
      isMobile: responsiveMobileEmulation && width < 768, reducedMotion: 'reduce' })
    const tripwire = watchConsole(page)
    const deletion = '**/api/memory/delete*'
    try {
      await openMemory(page, scaffold)
      await page.getByRole('textbox', { name: 'Search memory', exact: true }).fill(key)
      const disclosure = page.getByRole('button', { name: new RegExp(key) })
      await disclosure.click()
      await page.getByRole('button', { name: 'Edit memory', exact: true }).click()
      const content = page.getByLabel('Content', { exact: true })
      await content.fill('Unsubmitted draft must survive')
      const concurrent = await scaffold.ctx.memory.save({ scope: { kind: 'personal' }, key, kind: 'guidance', summary: 'Changed elsewhere', content: 'Committed elsewhere', expectedRevision: original.entry.revision }, { kind: 'member' })
      if (!concurrent.ok) throw new Error(`Concurrent fixture refused: ${concurrent.code}`)
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      await page.getByRole('alert').getByText('This entry changed elsewhere — refresh and retry', { exact: true }).waitFor()
      await expectMemoryContrast(page, [page.getByRole('alert')], `${name}-stale-delete`)
      const kind = page.getByLabel('Kind', { exact: true })
      if (width === 390 && height === 844) {
        await kind.evaluate((element) => { element.style.borderColor = 'var(--dsw-alias-border-l2)' })
        try {
          await expect(expectControlBoundaryContrast(page, kind, `${name}-weak-border-witness`)).rejects.toThrow('greater than or equal to 3')
        } finally { await kind.evaluate((element) => { element.style.borderColor = '' }) }
      }
      await expectControlBoundaryContrast(page, kind, `${name}-kind`)
      await expectControlBoundaryContrast(page, content, `${name}-content`)
      expect(await content.inputValue()).toBe('Unsubmitted draft must survive')
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByText('Changed elsewhere', { exact: true }).waitFor()
      if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click()
      await page.route(deletion, route => route.fulfill({ status: 503, body: 'Unavailable' }))
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      const alert = page.getByRole('alert')
      await alert.getByText('Delete failed — refresh to check the entry, then retry', { exact: true }).waitFor()
      await expectMemoryContrast(page, [alert], `${name}-failed-delete`)
      await expectViewportFit(page, page.locator('div[data-sidebar-right-tab]').filter({ has: alert }), [alert, page.getByRole('button', { name: 'Delete', exact: true })])
      expect((await scaffold.ctx.memory.entries({ kind: 'personal' })).find(entry => String(entry.key) === key)?.content).toBe('Committed elsewhere')
      await page.unroute(deletion)
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect.poll(() => disclosure.count()).toBe(0)
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, `memory-delete-${responsiveBrowserName}-${name}`)
      throw error
    } finally { await page.close() }
  })

  it.each(responsiveViewports)('$name reports an actual catalog request failure and reloads the real list on refresh', async ({ width, height }) => {
    const page = await browser.newPage({ viewport: { width, height }, locale: 'en-US', hasTouch: true,
      isMobile: responsiveMobileEmulation, reducedMotion: 'reduce' })
    const pattern = '**/api/memory/scopes*'
    try {
      await page.route(pattern, route => route.fulfill({ status: 503, body: 'Temporarily unavailable' }))
      await openMemory(page, scaffold)
      await page.getByText('Load failed — refresh to retry', { exact: true }).waitFor()
      await expectViewportFit(page, page.locator('div[data-sidebar-right-tab]'), [page.getByRole('button', { name: 'Refresh', exact: true })])
      await page.unroute(pattern)
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByRole('button', { name: 'New', exact: true }).waitFor()
      expect(await page.getByText('Load failed — refresh to retry', { exact: true }).count()).toBe(0)
    } finally { await page.close() }
  })

  it.each(responsiveViewports)('$name keeps every memory kind readable in both themes', async ({ name, width, height }) => {
    const prefix = `kind-${width}-${height}`
    const kinds = ['profile', 'guidance', 'background', 'resource'] as const
    const entries: MemoryEntry[] = []
    for (const kind of kinds) {
      const result = await scaffold.ctx.memory.save({ scope: { kind: 'personal' }, key: `${prefix}-${kind}`, kind,
        summary: `Saved ${kind} entry`, content: `Durable ${kind} details` }, { kind: 'member' })
      if (!result.ok) throw new Error(`Memory kind fixture refused: ${result.code}`)
      entries.push(result.entry)
    }
    const page = await browser.newPage({ viewport: { width, height }, locale: 'en-US', hasTouch: true,
      isMobile: responsiveMobileEmulation, reducedMotion: 'reduce' })
    const tripwire = watchConsole(page)
    try {
      await openMemory(page, scaffold)
      await page.getByRole('textbox', { name: 'Search memory', exact: true }).fill(prefix)
      const targets = []
      for (const kind of kinds) {
        const disclosure = page.getByRole('button', { name: new RegExp(`${prefix}-${kind}`) })
        await auditResponsiveControl(page, disclosure, `memory/${name}/${kind}`)
        await disclosure.tap()
        await page.getByText(`Durable ${kind} details`, { exact: true }).waitFor()
        targets.push({ label: kind, text: disclosure.locator('[class*="kbadge"]') })
      }
      expectTextContrast(await captureTextContrast(page, targets, `memory-${name}-kinds`))
      expect(tripwire.pageErrors).toEqual([])
      for (const entry of entries) {
        const result = await scaffold.ctx.memory.delete({ scope: entry.scope, key: String(entry.key), expectedRevision: entry.revision }, { kind: 'member' })
        if (!result.ok) throw new Error(`Memory kind cleanup refused: ${result.code}`)
      }
    } finally { await page.close() }
  })

  it.skipIf(!workflowMatrixEnabled)('keeps loading, scoped entries, search and disabled views reachable at every touch viewport', async () => {
    const session = await seedSession(scaffold, await readFile(fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url)), 'utf8'), 'memory-scope-history')
    await (await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)).attachSession(session)
    for (const scope of [{ kind: 'personal' }, { kind: 'workspace', directory: scaffold.workspaceCwd }] as const) {
      const result = await scaffold.ctx.memory.save({ scope, key: `scope-${scope.kind}`, kind: 'guidance',
        summary: `Saved ${scope.kind} memory`, content: `Durable ${scope.kind} scope content` }, { kind: 'member' })
      if (!result.ok) throw new Error(`Scope fixture refused: ${result.code}`)
    }
    const page = await newWorkflowPage(browser)
    const tripwire = watchConsole(page)
    const release = Promise.withResolvers<undefined>()
    const catalog = '**/api/memory/scopes*'
    try {
      await page.route(catalog, async (route) => { await release.promise; await route.continue() })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByText('DONE', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
      await page.locator('[data-sidebar-right-guide-entry="memory"]').click()
      const panel = page.locator('div[data-sidebar-right-tab]').filter({ has: page.getByRole('textbox', { name: 'Search memory', exact: true }) })
      await panel.getByText('Loading…', { exact: true }).waitFor()
      await auditWorkflowState(page, 'memory', 'catalog-loading', panel)
      release.resolve(undefined)
      const scope = panel.getByRole('combobox', { name: 'Choose scope', exact: true })
      const search = panel.getByRole('textbox', { name: 'Search memory', exact: true })
      const readableSearch = async (): Promise<void> => {
        await expect.poll(async () => (await search.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(120)
      }
      const initialEntry = (key: string) => async (): Promise<void> => {
        await readableSearch()
        await panel.evaluate((element) => {
          for (const node of [element, ...element.querySelectorAll('*')]) if (node instanceof HTMLElement) node.scrollTop = 0
        })
        await expectFeedbackVisible(panel.getByRole('button', { name: new RegExp(key) }))
        const directory = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
        if (directory !== undefined && page.viewportSize()!.height <= 480) {
          await mkdir(directory, { recursive: true })
          const viewport = page.viewportSize()!
          await page.screenshot({ path: join(directory, `memory-initial-${responsiveBrowserName}-${key}-${viewport.width}-${viewport.height}.png`), animations: 'disabled' })
        }
      }
      await scope.waitFor()
      await expect.poll(() => scope.inputValue()).toBe(`workspace::${scaffold.workspaceCwd}`)
      await panel.getByText('scope-workspace', { exact: true }).waitFor()
      await auditWorkflowState(page, 'memory', 'session-workspace-scope', panel, [scope], initialEntry('scope-workspace'))
      await scope.selectOption('personal')
      await panel.getByText('scope-personal', { exact: true }).waitFor()
      await auditWorkflowState(page, 'memory', 'personal-scope-selection', panel, [scope], initialEntry('scope-personal'))
      await search.fill('No entry contains this search token')
      await panel.getByText('No matching entries', { exact: true }).waitFor()
      await auditWorkflowState(page, 'memory', 'search-no-matches', panel, [search])
      await search.fill('scope-personal')
      await scaffold.ctx.settings.update(settingsNamespace('memory'), { enabled: false })
      await panel.getByRole('button', { name: 'Refresh', exact: true }).tap()
      await panel.getByText('Memory is off. Re-enable it from the Memory card on the Plugins page.', { exact: true }).waitFor()
      expect(await panel.getByRole('button', { name: 'New', exact: true }).count()).toBe(0)
      await panel.getByRole('button', { name: /scope-personal/ }).tap()
      await panel.getByText('Durable personal scope content', { exact: true }).waitFor()
      await auditWorkflowState(page, 'memory', 'disabled-retains-readable-entries', panel,
        [scope, search, panel.getByText('Durable personal scope content', { exact: true })])
      await scaffold.ctx.settings.update(settingsNamespace('memory'), { enabled: true })
      await panel.getByRole('button', { name: 'Refresh', exact: true }).tap()
      await panel.getByRole('button', { name: 'New', exact: true }).waitFor()
      expect(await scope.inputValue()).toBe('personal')
      await auditWorkflowState(page, 'memory', 'reenabled-preserves-scope', panel)
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(page, `memory-scopes-${responsiveBrowserName}`); throw error }
    finally {
      release.resolve(undefined)
      await page.unrouteAll({ behavior: 'wait' })
      await scaffold.ctx.settings.update(settingsNamespace('memory'), { enabled: true })
      await page.close()
    }
  }, 180_000)

  it.skipIf(!workflowMatrixEnabled)('shows loading, search feedback and disabled status before scrolling at every touch viewport', async () => {
    for (const scope of [{ kind: 'personal' }, { kind: 'workspace', directory: scaffold.workspaceCwd }] as const) {
      const result = await scaffold.ctx.memory.save({ scope, key: `feedback-${scope.kind}`, kind: 'guidance',
        summary: 'Initial feedback visibility', content: 'Readable entry remains available while Memory is off.' }, { kind: 'member' })
      if (!result.ok) throw new Error(`Feedback fixture refused: ${result.code}`)
    }
    const directory = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
    if (directory !== undefined) await mkdir(directory, { recursive: true })
    const summary: string[] = []
    for (const viewport of responsiveViewports) {
      const page = await browser.newPage({ viewport, locale: 'en-US', hasTouch: true,
        isMobile: responsiveMobileEmulation, reducedMotion: 'reduce' })
      const tripwire = watchConsole(page)
      const release = Promise.withResolvers<undefined>()
      try {
        await page.addInitScript((key) => { localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: key })) },
          clientSessionKey({ kind: 'personal' }, SESSION))
        await page.route('**/api/memory/scopes*', async (route) => { await release.promise; await route.continue() })
        await openMemory(page, scaffold)
        const search = page.getByRole('textbox', { name: 'Search memory', exact: true })
        const panel = page.locator('div[data-sidebar-right-tab]').filter({ has: search })
        const capture = async (state: string, feedback: Locator): Promise<void> => {
          await expectFeedbackVisible(feedback)
          if (directory !== undefined) await page.screenshot({ path: join(directory,
            `${responsiveBrowserName}-memory-initial-${state}-${viewport.name}.png`), animations: 'disabled' })
        }
        const loading = panel.getByText('Loading…', { exact: true })
        await loading.waitFor()
        await capture('loading', loading)
        release.resolve(undefined)
        const scope = panel.getByRole('combobox', { name: 'Choose scope', exact: true })
        await scope.selectOption('personal')
        await search.fill('No entry contains this initial feedback query')
        await search.blur()
        const empty = panel.getByText('No matching entries', { exact: true })
        await empty.waitFor()
        await capture('empty', empty)
        await search.fill('feedback-personal')
        await search.blur()
        await scaffold.ctx.settings.update(settingsNamespace('memory'), { enabled: false })
        await panel.getByRole('button', { name: 'Refresh', exact: true }).tap()
        const disabled = panel.getByText('Memory is off. Re-enable it from the Memory card on the Plugins page.', { exact: true })
        await disabled.waitFor()
        await capture('disabled', disabled)
        expect(await panel.getByRole('button', { name: 'New', exact: true }).count()).toBe(0)
        expect(tripwire.pageErrors).toEqual([])
        summary.push(`${viewport.name}: loading, no-match feedback and disabled notice fully visible before acceptance scrolling; read-only actions enforced.`)
      } catch (error) { await saveFailureShot(page, `memory-initial-feedback-${responsiveBrowserName}-${viewport.name}`); throw error }
      finally {
        release.resolve(undefined)
        await page.unrouteAll({ behavior: 'wait' })
        await scaffold.ctx.settings.update(settingsNamespace('memory'), { enabled: true })
        await page.close()
      }
    }
    await compareOrRefreshGolden(fileURLToPath(new URL('./snapshots/memory-responsive/feedback.expected.md', import.meta.url)),
      summary.join('\n'), webSnapshotMode())
  }, 180_000)

  it.skipIf(!workflowMatrixEnabled)('retains the Memory plugin setting after a failed write and accepts an explicit retry', async () => {
    const page = await newWorkflowPage(browser)
    const tripwire = watchConsole(page)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let failures = 0
    const endpoint = '**/api/settings.mutate*'
    try {
      const session = await seedSession(scaffold, await readFile(fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url)), 'utf8'), 'memory-plugin-header-history')
      await (await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)).attachSession(session)
      await page.addInitScript((key) => { localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: key })) },
        clientSessionKey({ kind: 'personal' }, session))
      await scaffold.ctx.settings.update(settingsNamespace('memory'), { enabled: true })
      await page.route(endpoint, async (route) => {
        const body = route.request().postDataJSON() as { payload: { ns: string } }
        if (body.payload.ns !== 'memory' || failures > 0) return route.continue()
        failures += 1
        entered.resolve(undefined)
        await release.promise
        await route.fulfill({ status: 503, body: 'Fixture settings writer is unavailable' })
      })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      const composer = page.locator('[data-composer-card] textarea:enabled')
      await composer.waitFor()
      await composer.fill('Draft retained while browsing Memory')
      await composer.blur()
      const header = page.locator('[data-mobile-page-title]')
      const conversationTitle = 'Use the read tool twice'
      await expect.poll(() => header.textContent()).toBe(conversationTitle)
      const rowKey = await page.locator('[data-row-key^="session:"][aria-selected="true"]').getAttribute('data-row-key')
      expect(rowKey).not.toBeNull()
      const navigationSnapshots = [await captureStableAria(page, '[data-mobile-page-title]', scaffold.workspaceCwd)]
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
      await page.getByRole('navigation', { name: 'Panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
      await expect.poll(() => header.textContent()).toBe('Plugins')
      navigationSnapshots.push(await captureStableAria(page, '[data-mobile-page-title]', scaffold.workspaceCwd))
      await page.getByRole('button', { name: 'View Memory', exact: true }).click()
      await expect.poll(() => header.textContent()).toBe('Memory')
      navigationSnapshots.push(await captureStableAria(page, '[data-mobile-page-title]', scaffold.workspaceCwd))
      const card = page.locator('[data-plugin-item-detail="memory"]')
      const toggle = card.getByRole('switch', { name: 'Memory enabled', exact: true })
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
      await Promise.all([entered.promise, toggle.click()])
      expect(await toggle.isDisabled()).toBe(true)
      const saving = card.getByRole('status').filter({ hasText: 'Saving…' })
      await saving.waitFor()
      await auditWorkflowState(page, 'memory-plugin', 'write-pending', card, [toggle, saving], undefined, async () => {
        if (page.viewportSize()!.width < 768) await expect.poll(() => header.textContent()).toBe('Memory')
        await expectSwitchContrast(page, toggle, `memory-write-pending-${page.viewportSize()!.width}`)
      })
      const pendingSnapshot = await captureStableAria(page, '[data-plugin-item-detail="memory"]', scaffold.workspaceCwd)
      release.resolve(undefined)
      const error = card.getByRole('alert').filter({ hasText: 'Write failed — try again' })
      await error.waitFor()
      await saving.waitFor({ state: 'hidden' })
      await expect.poll(() => toggle.isEnabled()).toBe(true)
      expect(await toggle.getAttribute('aria-checked')).toBe('true')
      expect(scaffold.ctx.settings.get(settingsNamespace('memory'))).toMatchObject({ enabled: true })
      await auditWorkflowState(page, 'memory-plugin', 'write-failed-retains-setting', card, [toggle, error], undefined, async () => {
        if (page.viewportSize()!.width < 768) await expect.poll(() => header.textContent()).toBe('Memory')
        await expectMemoryContrast(page, [error], 'plugin-write-failed')
        await expectSwitchContrast(page, toggle, `memory-write-failed-${page.viewportSize()!.width}`)
      })
      const failedSnapshot = await captureStableAria(page, '[data-plugin-item-detail="memory"]', scaffold.workspaceCwd)
      await toggle.click()
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
      await error.waitFor({ state: 'hidden' })
      expect(scaffold.ctx.settings.get(settingsNamespace('memory'))).toMatchObject({ enabled: false })
      expect(failures).toBe(1)
      await auditWorkflowState(page, 'memory-plugin', 'write-retried', card, [toggle], undefined, async () => {
        if (page.viewportSize()!.width < 768) await expect.poll(() => header.textContent()).toBe('Memory')
        await expectSwitchContrast(page, toggle, `memory-write-retried-${page.viewportSize()!.width}`)
      })
      const retriedSnapshot = await captureStableAria(page, '[data-plugin-item-detail="memory"]', scaffold.workspaceCwd)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByRole('button', { name: 'Back to plugins', exact: true }).click()
      await expect.poll(() => header.textContent()).toBe('Plugins')
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
      await page.locator(`[data-row-key=${JSON.stringify(rowKey)}]`).click()
      await expect.poll(() => header.textContent()).toBe(conversationTitle)
      await composer.waitFor()
      expect(await composer.inputValue()).toBe('Draft retained while browsing Memory')
      navigationSnapshots.push(await captureStableAria(page, '[data-mobile-page-title]', scaffold.workspaceCwd))
      await compareOrRefreshGolden(fileURLToPath(new URL('./snapshots/memory-responsive/plugin-write.expected.md', import.meta.url)),
        `## Compact navigation\n${navigationSnapshots.join('\n\n')}\n\n## Pending write\n${pendingSnapshot}\n\n## Refused write\n${failedSnapshot}\n\n## Explicit retry\n${retriedSnapshot}`,
        webSnapshotMode())
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(page, `memory-plugin-write-${responsiveBrowserName}`); throw error }
    finally {
      release.resolve(undefined)
      try { await page.unrouteAll({ behavior: 'wait' }) }
      finally {
        try { await scaffold.ctx.settings.update(settingsNamespace('memory'), { enabled: true }) }
        finally { await page.close() }
      }
    }
  })
})
