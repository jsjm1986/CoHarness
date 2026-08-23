/**
 * Compact settings overlay through the shipped Web composition: the panel
 * portals out of the sidebar drawer, fills the 390×844 viewport, and keeps
 * section content scrollable. Keyless: chrome and catalog listing only.
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
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/settings-compact', import.meta.url))
const GENERAL_EXPECTED = join(SNAPSHOT_DIR, 'general.expected.md')
const MODELS_EXPECTED = join(SNAPSHOT_DIR, 'models.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: compact settings overlay', () => {
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
    if (failures.length > 1) throw new AggregateError(failures, 'settings compact e2e cleanup failed')
  })

  it('fills the viewport from the drawer, scrolls models, and switches sections', async () => {
    page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      locale: ZH_BROWSER_LOCALE,
      hasTouch: true,
      isMobile: true,
    })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-compact'))
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: '打开侧边栏' }).click()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })

    const dialogBox = await dialog.boundingBox()
    if (dialogBox === null) throw new Error('settings compact dialog has no box')
    // Escaped the 320px drawer: the overlay is a full-viewport page.
    expect(dialogBox.x).toBeLessThanOrEqual(2)
    expect(dialogBox.width).toBeGreaterThanOrEqual(370)
    expect(dialogBox.height).toBeGreaterThanOrEqual(700)

    const generalTab = dialog.getByRole('button', { name: '通用设置' })
    const modelsTab = dialog.getByRole('button', { name: '模型' })
    const pluginsTab = dialog.getByRole('button', { name: '插件' })
    const presetsTab = dialog.getByRole('button', { name: 'Agent 预设' })
    const generalTabBox = await generalTab.boundingBox()
    if (generalTabBox === null) throw new Error('settings compact general tab has no box')
    expect(generalTabBox.height).toBeGreaterThanOrEqual(44)
    for (const tab of [generalTab, modelsTab, pluginsTab, presetsTab]) {
      const box = await tab.boundingBox()
      if (box === null) throw new Error('settings compact tab has no box')
      expect(box.x).toBeGreaterThanOrEqual(dialogBox.x - 1)
      expect(box.x + box.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 1)
    }

    const cubeBoxes = await Promise.all(
      ['浅色', '深色', '跟随系统'].map(async name => dialog.getByRole('button', { name }).boundingBox()),
    )
    if (cubeBoxes.some(box => box === null)) throw new Error('settings compact theme cubes missing')
    const cubeYs = new Set(cubeBoxes.map(box => Math.round(box!.y)))
    expect(cubeYs.size).toBe(1)

    const enterBox = await dialog.getByRole('button', { name: '排队发送' }).boundingBox()
    if (enterBox === null) throw new Error('settings compact enter selector has no box')
    expect(enterBox.y + enterBox.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height + 1)

    const generalSnapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(GENERAL_EXPECTED, generalSnapshot, MODE)

    await modelsTab.click()
    await expect.poll(() => modelsTab.getAttribute('aria-current'), { timeout: 5_000 }).toBe('true')
    const add = dialog.getByRole('button', { name: '添加提供方' })
    await add.waitFor({ timeout: 10_000 })
    await add.scrollIntoViewIfNeeded()
    const addBox = await add.boundingBox()
    const afterScroll = await dialog.boundingBox()
    if (addBox === null || afterScroll === null) throw new Error('settings compact models geometry missing')
    expect(addBox.y + addBox.height).toBeLessThanOrEqual(afterScroll.y + afterScroll.height + 1)
    expect(addBox.y).toBeGreaterThanOrEqual(afterScroll.y)

    const modelsSnapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MODELS_EXPECTED, modelsSnapshot, MODE)

    const lastOrgVisible = await page.evaluate(() => {
      const dialogEl = document.querySelector('[role="dialog"]')
      if (dialogEl === null) return false
      const options = [...dialogEl.querySelectorAll('*')]
        .filter((el) => {
          const overflowY = getComputedStyle(el).overflowY
          return overflowY === 'auto' || overflowY === 'scroll'
        })
        .reduce<HTMLElement | null>((best, el) => {
          const node = el as HTMLElement
          if (best === null || node.clientHeight > best.clientHeight) return node
          return best
        }, null)
      if (options === null) return false
      const spacer = document.createElement('div')
      spacer.style.height = '1400px'
      const last = document.createElement('div')
      last.id = 'settings-compact-last-org-model'
      last.textContent = 'LAST-ORG-MODEL-CARD'
      last.style.minHeight = '72px'
      options.append(spacer, last)
      last.scrollIntoView({ block: 'end' })
      const lastBox = last.getBoundingClientRect()
      const panel = dialogEl.getBoundingClientRect()
      return lastBox.top >= panel.top && lastBox.bottom <= panel.bottom + 1
    })
    expect(lastOrgVisible).toBe(true)

    await pluginsTab.click()
    await expect.poll(() => pluginsTab.getAttribute('aria-current'), { timeout: 5_000 }).toBe('true')
    await dialog.getByRole('heading', { name: '插件' }).waitFor({ timeout: 10_000 })

    await presetsTab.click()
    await expect.poll(() => presetsTab.getAttribute('aria-current'), { timeout: 5_000 }).toBe('true')
    await dialog.getByRole('heading', { name: 'Agent 预设' }).waitFor({ timeout: 10_000 })

    await generalTab.click()
    await expect.poll(() => generalTab.getAttribute('aria-current'), { timeout: 5_000 }).toBe('true')
  }, 90_000)

  it('commits exactly the compact settings snapshot inventory', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['general.expected.md', 'models.expected.md'])
  })

  it('keeps the selected settings tab reachable on a 320px phone', async () => {
    page = await browser.newPage({
      viewport: { width: 320, height: 568 },
      locale: ZH_BROWSER_LOCALE,
      hasTouch: true,
      isMobile: true,
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: '打开侧边栏' }).click()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    const presets = dialog.getByRole('button', { name: 'Agent 预设' })
    await presets.click()
    await expect.poll(() => presets.getAttribute('aria-current'), { timeout: 5_000 }).toBe('true')
    const dialogBox = await dialog.boundingBox()
    const tabBox = await presets.boundingBox()
    if (dialogBox === null || tabBox === null) throw new Error('320px settings tab geometry missing')
    expect(tabBox.x).toBeGreaterThanOrEqual(dialogBox.x - 1)
    expect(tabBox.x + tabBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 1)
    expect(await dialog.getByRole('heading', { name: 'Agent 预设' }).count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
