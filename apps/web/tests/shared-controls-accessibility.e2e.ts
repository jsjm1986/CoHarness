/** Keyboard, single-pointer and responsive Dock interactions in the assembled application. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { expectViewportFit, responsiveBrowser } from './responsive-browser.ts'
import { saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/shared-controls/dock-actions.expected.md', import.meta.url))

describe('web e2e: shared controls accessibility', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let sessionId: Awaited<ReturnType<typeof seedSession>>
  let source: string
  let attachSession: (id: typeof sessionId) => Promise<void>
  let sequence = 0

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ workbench: true })
    await writeFile(join(scaffold.workspaceCwd, 'alpha.txt'), 'Alpha preview\n')
    await writeFile(join(scaffold.workspaceCwd, 'beta.txt'), 'Beta preview\n')
    source = (await readFile(SEED, 'utf8')).replace('"text":"DONE"', `"text":${JSON.stringify('[Open alpha](alpha.txt)\n\n[Open beta](beta.txt)')}`)
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    attachSession = async (id) => { await workspace.attachSession(id) }
    browser = await responsiveBrowser.launch()
  }, 120_000)

  beforeEach(async ({ task }) => {
    if (browser === undefined || scaffold === undefined) throw new Error('Scaffold is unavailable')
    sessionId = await seedSession(scaffold, source, `shared-controls-accessibility-${String(++sequence)}`)
    await attachSession(sessionId)
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', hasTouch: task.name.includes('touch') })
    page.setDefaultTimeout(10_000)
    onTestFailed(() => saveFailureShot(page, task.name.includes('touch') ? 'shared-controls-responsive' : 'shared-controls-keyboard'))
    await page.addInitScript((id) => {
      if (window === window.top) localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
    }, sessionId)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Open alpha', exact: true }).click()
    await page.getByRole('button', { name: 'Open beta', exact: true }).click()
    try {
      await page.locator('[data-sidebar-right-panel]').getByRole('button', { name: 'Fullscreen', exact: true }).click()
    } catch (error) {
      await saveFailureShot(page, 'shared-controls-setup')
      console.log(await page.locator('body').ariaSnapshot())
      throw error
    }
  }, 120_000)

  afterEach(async () => { await page?.close() })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('moves, splits, resizes and floats tabs without dragging, preserving keyboard focus', async () => {
    if (scaffold === undefined) throw new Error('Scaffold is unavailable')
    onTestFailed(() => saveFailureShot(page, 'shared-controls-keyboard'))
    const console = watchConsole(page)
    const panel = page.locator('[data-sidebar-right-panel]')
    const beta = panel.getByRole('tab', { name: /beta\.txt/u })
    await beta.focus()
    await beta.press('Shift+F10')
    await page.getByRole('menuitem', { name: 'Move tab earlier', exact: true }).waitFor()
    await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[data-dockkit-tab-menu]', scaffold.workspaceCwd), webSnapshotMode())
    await page.getByRole('menuitem', { name: 'Move tab earlier', exact: true }).click()
    await expect.poll(() => beta.evaluate(node => node === document.activeElement)).toBe(true)
    await panel.locator('[data-dockkit-split-button]').first().click()
    const divider = page.getByRole('separator', { name: /Resize panes with arrow keys/u })
    await divider.focus()
    await divider.press('ArrowRight')
    await expect.poll(() => divider.getAttribute('aria-valuenow')).toBe('52')
    await divider.press('Home')
    await expect.poll(() => divider.getAttribute('aria-valuenow')).toBe('20')
    await divider.press('Enter')
    await page.getByRole('menuitem', { name: 'Equalize adjacent panes' }).click()
    await expect.poll(() => divider.getAttribute('aria-valuenow')).toBe('50')
    await page.keyboard.press('Escape')
    await expect.poll(() => divider.evaluate(node => node === document.activeElement)).toBe(true)
    await beta.focus()
    await beta.press('Shift+F10')
    await page.getByRole('menuitem', { name: 'Move to pane 2' }).click()
    await expect.poll(() => beta.evaluate(node => node === document.activeElement)).toBe(true)
    await beta.press('Shift+F10')
    await page.getByRole('menuitem', { name: 'Float tab', exact: true }).click()
    const float = page.locator('[data-dockkit-float]')
    const move = float.getByRole('button', { name: /Move panel with arrow keys/u })
    await expect.poll(() => move.evaluate(node => node === document.activeElement)).toBe(true)
    const before = await float.boundingBox()
    if (before === null) throw new Error('Floating panel was not rendered')
    await move.press('ArrowRight')
    await expect.poll(async () => (await float.boundingBox())?.x).toBe(before.x + 10)
    const resize = float.getByRole('button', { name: /Resize panel with arrow keys/u })
    await resize.focus()
    await resize.press('ArrowRight')
    await expect.poll(async () => (await float.boundingBox())?.width).toBe(before.width + 10)
    await resize.click()
    await page.getByRole('menuitem', { name: 'Increase height' }).click()
    await expect.poll(async () => (await float.boundingBox())?.height).toBe(before.height + 40)
    await page.keyboard.press('Escape')
    await float.getByRole('button', { name: 'Send back to the sidebar' }).click()
    await expect.poll(() => float.count()).toBe(0)
    await expect.poll(() => beta.evaluate(node => node === document.activeElement)).toBe(true)
    expect(console.pageErrors).toEqual([])
  }, 60_000)

  it('keeps touch actions and floated panels reachable across phone widths, landscape and forced colors', async () => {
    onTestFailed(() => saveFailureShot(page, 'shared-controls-responsive'))
    const panel = page.locator('[data-sidebar-right-panel]')
    const beta = panel.getByRole('tab', { name: /beta\.txt/u })
    await page.setViewportSize({ width: 390, height: 844 })
    const alpha = panel.getByRole('tab', { name: /alpha\.txt/u })
    for (const tab of [alpha, beta]) {
      await tab.scrollIntoViewIfNeeded()
      await tab.tap()
      expect(await panel.getByRole('tab').count()).toBe(2)
      await expect.poll(() => tab.getAttribute('aria-selected')).toBe('true')
      expect((await tab.locator('[data-dockkit-tab-title]').boundingBox())?.width).toBeGreaterThanOrEqual(72)
    }
    await beta.press('Shift+F10')
    await page.getByRole('menuitem', { name: 'Float tab', exact: true }).click()
    const float = page.locator('[data-dockkit-float]')
    const move = float.getByRole('button', { name: /Move panel with arrow keys/u })
    const resize = float.getByRole('button', { name: /Resize panel with arrow keys/u })
    for (const viewport of [
      { width: 320, height: 568 }, { width: 390, height: 844 }, { width: 767, height: 844 }, { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport)
      await expectViewportFit(page, float, [move, resize, float.getByRole('button', { name: 'Send back to the sidebar' })])
      for (const handle of [move, resize]) expect((await handle.boundingBox())?.height).toBeGreaterThanOrEqual(44)
      await resize.tap()
      await expectViewportFit(page, page.getByRole('menu'), [page.getByRole('menuitem', { name: 'Decrease width' })])
      await page.getByRole('menuitem', { name: 'Decrease width' }).tap()
      await page.keyboard.press('Escape')
      await expect.poll(() => resize.evaluate(node => node === document.activeElement)).toBe(true)
    }
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' })
    expect(await float.evaluate(node => getComputedStyle(node).borderTopStyle)).toBe('solid')
    await resize.focus()
    await page.keyboard.press('ArrowLeft')
    expect(await resize.evaluate(node => getComputedStyle(node, '::after').opacity)).toBe('1')
    await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' })
  }, 60_000)
})
