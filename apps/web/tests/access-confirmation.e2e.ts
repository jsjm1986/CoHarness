// Web e2e scenario: every visible permission picker gates Full access behind
// the same locale-aware, in-page risk confirmation. Zero model calls: the
// scenario boots the shipped Web composition and exercises the real
// permission projection, client command path, HTTP RPC, and pushed update.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium, webkit } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/access-confirmation', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: Full access confirmation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // CI uses Playwright's pinned browser. A developer may point this one
    // scenario at an installed Chromium when the matching browser download
    // is temporarily unavailable.
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    const engine = process.env.DSH_RESPONSIVE_BROWSER === 'webkit' ? webkit : chromium
    browser = await engine.launch(engine === chromium && executablePath !== undefined ? { executablePath } : {})
    // Keep the Chinese surface via {@link ZH_BROWSER_LOCALE}: the golden pins
    // the actual registered dictionary rather than a test-local translation
    // callback.
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE, hasTouch: true })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps the phone confirmation actions inside the viewport when the keyboard reduces its height', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-full-access-phone-viewport'))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    try {
      await page.locator('[data-viewport="compact"]').waitFor({ timeout: 5_000 })
      const access = page.locator('button[aria-label^="访问模式"]').first()
      await access.tap()
      const settings = page.locator('[data-session-settings-sheet]')
      const fullAccess = settings.getByRole('menuitemradio', { name: '完全权限' })
      await fullAccess.tap()
      const dialog = page.getByRole('dialog', { name: '确认启用完全权限？' })
      await dialog.waitFor()
      // Chromium's mobile emulation has no software keyboard. Drive the same
      // visualViewport resize event used by the shipped layout plugin.
      await page.evaluate(() => {
        const viewport = window.visualViewport!
        Object.defineProperty(viewport, 'height', { configurable: true, value: 420 })
        viewport.dispatchEvent(new Event('resize'))
      })
      const enable = dialog.getByRole('button', { name: '启用完全权限' })
      await expect.poll(() => enable.evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(420)
      const box = await dialog.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(390)
      const acknowledgement = dialog.getByRole('checkbox', { name: '我已了解风险，并愿意继续' })
      await acknowledgement.tap()
      expect(await acknowledgement.isChecked()).toBe(true)
      expect(await enable.isEnabled()).toBe(true)
      await dialog.getByRole('button', { name: '取消', exact: true }).tap()
      await dialog.waitFor({ state: 'detached' })
      expect(await fullAccess.evaluate(element => element === document.activeElement)).toBe(true)
      await page.keyboard.press('Escape')
      await settings.waitFor({ state: 'detached' })
      expect(await access.evaluate(element => element === document.activeElement)).toBe(true)
    } finally {
      if (await page.getByRole('dialog', { name: '确认启用完全权限？' }).isVisible()) await page.keyboard.press('Escape')
      if (await page.locator('[data-session-settings-sheet]').isVisible()) await page.keyboard.press('Escape')
      await page.evaluate(() => {
        const viewport = window.visualViewport!
        Reflect.deleteProperty(viewport, 'height')
        viewport.dispatchEvent(new Event('resize'))
      })
      await page.setViewportSize({ width: 1680, height: 1000 })
      await page.emulateMedia({ reducedMotion: 'no-preference' })
    }
  })

  it('requires acknowledgement before the composer picker can enable Full access', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-full-access-confirmation'))
    const access = page.locator('button[aria-label^="访问模式"]').first()
    await access.waitFor({ timeout: 10_000 })

    expect(await access.getAttribute('aria-label')).toBe('访问模式，当前：工作区内修改')

    await access.click()
    await page.getByRole('menuitem', { name: '完全权限' }).click()
    const dialog = page.getByRole('dialog', { name: '确认启用完全权限？' })
    await dialog.waitFor({ timeout: 10_000 })
    const enable = dialog.getByRole('button', { name: '启用完全权限' })
    expect(await enable.isDisabled()).toBe(true)

    // The modal is in this page's body (not a native/new window) and escapes
    // the sticky composer's stacking context.
    expect(await dialog.evaluate(node => node.parentElement?.parentElement === document.body)).toBe(true)
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

    await dialog.getByRole('checkbox', { name: '我已了解风险，并愿意继续' }).check()
    expect(await enable.isEnabled()).toBe(true)
    await enable.click()
    await expect.poll(() => access.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('访问模式，当前：完全权限')
    expect(await dialog.count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
