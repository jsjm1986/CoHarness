/**
 * Compact settings overlay through the shipped Web composition: the panel
 * portals out of the sidebar drawer, fills the 390×844 viewport, and keeps
 * section content scrollable. Keyless: chrome and catalog listing only.
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import type { Browser, Locator, Page } from 'playwright'
import { responsiveBrowser, responsiveBrowserName as engine, responsiveMobileEmulation } from './responsive-browser.ts'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/settings-compact', import.meta.url))
const GENERAL_EXPECTED = join(SNAPSHOT_DIR, 'general.expected.md')
const MODELS_EXPECTED = join(SNAPSHOT_DIR, 'models.expected.md')
const PROVIDER_DRAFT_EXPECTED = join(SNAPSHOT_DIR, 'provider-draft.expected.md')
const MODE = webSnapshotMode()

/** Synthetic text enlargement exercises fixed CSS sizes without claiming browser zoom or a native keyboard. */
async function doubleText(surface: Locator): Promise<void> {
  await surface.evaluate((element) => {
    const sizes = [element, ...element.querySelectorAll('*')]
      .filter((node): node is HTMLElement => node instanceof HTMLElement)
      .map(node => ({ node, font: Number.parseFloat(getComputedStyle(node).fontSize), line: getComputedStyle(node).lineHeight }))
    for (const { node, font, line } of sizes) {
      node.style.setProperty('font-size', `${font * 2}px`, 'important')
      if (line !== 'normal') node.style.setProperty('line-height', `${Number.parseFloat(line) * 2}px`, 'important')
    }
  })
}

async function expectReachable(control: Locator, viewport: { width: number; height: number }): Promise<void> {
  await control.scrollIntoViewIfNeeded()
  const bounds = await control.boundingBox()
  if (bounds === null) throw new Error('mobile control has no rendered box')
  expect(bounds.x).toBeGreaterThanOrEqual(-1)
  expect(bounds.y).toBeGreaterThanOrEqual(-1)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1)
}

async function mobileScreenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.DSH_MOBILE_SCREENSHOTS
  if (directory === undefined) return
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: join(directory, `settings-${engine}-${name}.png`), animations: 'disabled' })
}

describe('web e2e: compact settings overlay', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole> = { warnings: [], pageErrors: [] }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await responsiveBrowser.launch()
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
      isMobile: responsiveMobileEmulation,
    })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-compact'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: '打开侧边栏' }).click()
    const trigger = page.getByRole('button', { name: '设置', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    // The panel enters with a scale/translate animation; geometry read
    // mid-flight would measure the from-frame instead of the settled page.
    await dialog.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined)))
    })

    const dialogBox = await dialog.boundingBox()
    if (dialogBox === null) throw new Error('settings compact dialog has no box')
    // Escaped the 320px drawer: the overlay is a full-viewport page.
    expect(dialogBox.x).toBeLessThanOrEqual(2)
    expect(dialogBox.width).toBeGreaterThanOrEqual(370)
    expect(dialogBox.height).toBeGreaterThanOrEqual(700)

    const generalTab = dialog.getByRole('button', { name: '通用设置' })
    const modelsTab = dialog.getByRole('button', { name: '模型' })
    const presetsTab = dialog.getByRole('button', { name: 'Agent 预设' })
    const generalTabBox = await generalTab.boundingBox()
    if (generalTabBox === null) throw new Error('settings compact general tab has no box')
    expect(generalTabBox.height).toBeGreaterThanOrEqual(44)
    for (const tab of [generalTab, modelsTab, presetsTab]) {
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

    const enterButton = dialog.getByRole('button', { name: '排队发送' })
    for (const name of ['减小字号', '增大字号']) {
      const step = dialog.getByRole('button', { name, exact: true })
      await step.scrollIntoViewIfNeeded()
      const box = await step.boundingBox()
      if (box === null) throw new Error(`missing font control: ${name}`)
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(await step.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    }
    // The General section grew past the 844px viewport; .options owns the
    // scroll, so reach the row through it before checking geometry.
    await enterButton.scrollIntoViewIfNeeded()
    const enterBox = await enterButton.boundingBox()
    if (enterBox === null) throw new Error('settings compact enter selector has no box')
    expect(enterBox.y + enterBox.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height + 1)

    await dialog.getByText(/^当前版本：/).waitFor()
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

    // The sidebar Plugins panel holds the plugins surface; the dialog offers no such tab.
    expect(await dialog.getByRole('button', { name: '插件', exact: true }).count()).toBe(0)

    await presetsTab.click()
    await expect.poll(() => presetsTab.getAttribute('aria-current'), { timeout: 5_000 }).toBe('true')
    await dialog.getByRole('heading', { name: 'Agent 预设' }).waitFor({ timeout: 10_000 })

    await generalTab.click()
    await expect.poll(() => generalTab.getAttribute('aria-current'), { timeout: 5_000 }).toBe('true')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect.poll(() => trigger.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await page.locator('#root').getAttribute('inert')).toBeNull()
  }, 90_000)

  it('commits exactly the compact settings snapshot inventory', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['general.expected.md', 'models.expected.md', 'provider-draft.expected.md'])
  })

  it('preserves an open provider draft and input focus through rotation and doubled text', async () => {
    const portrait = { width: 390, height: 844 }
    const landscape = { width: 844, height: 390 }
    page = await browser.newPage({ viewport: portrait, locale: ZH_BROWSER_LOCALE, hasTouch: true, isMobile: responsiveMobileEmulation, reducedMotion: 'reduce' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, `web-e2e-settings-draft-${engine}`))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '打开侧边栏', exact: true }).tap()
    await page.getByRole('button', { name: '设置', exact: true }).tap()
    const dialog = page.getByRole('dialog', { name: '设置', exact: true })
    await dialog.getByRole('button', { name: '模型', exact: true }).tap()
    await dialog.getByRole('button', { name: '添加提供方', exact: true }).tap()
    await dialog.getByRole('tab', { name: '自定义', exact: true }).tap()
    const form = dialog.locator('#models-add-custom-panel')
    await form.getByLabel('Provider ID', { exact: true }).fill('mobile-draft')
    await form.getByLabel('API 地址', { exact: true }).fill('https://example.invalid/v1')
    const name = form.getByLabel('显示名称', { exact: true })
    const protocol = form.getByRole('combobox', { name: 'API 协议', exact: true })
    for (const control of [name, protocol]) {
      const size = await control.evaluate(element => ({
        height: element.getBoundingClientRect().height,
        font: Number.parseFloat(getComputedStyle(element).fontSize),
      }))
      expect(size.height).toBeGreaterThanOrEqual(44)
      expect(size.font).toBeGreaterThanOrEqual(16)
    }
    const draft = '手机旋转保留草稿 Mobile provider draft'
    await name.tap()
    await name.fill(draft)
    for (const viewport of [landscape, portrait]) {
      await page.setViewportSize(viewport)
      await expect.poll(() => page.locator('[data-viewport]').first().getAttribute('data-viewport'))
        .toBe(viewport.width < 768 ? 'compact' : 'medium')
      await expect.poll(() => name.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await name.inputValue()).toBe(draft)
      await expectReachable(name, viewport)
      await mobileScreenshot(page, `draft-${viewport.width}`)
    }
    await compareOrRefreshGolden(PROVIDER_DRAFT_EXPECTED,
      await captureStableAria(page, '#models-add-custom-panel', scaffold.workspaceCwd), MODE)
    const originalFont = await name.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))
    await doubleText(dialog)
    expect(await name.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBe(originalFont * 2)
    expect(await name.inputValue()).toBe(draft)
    expect(await name.evaluate(element => element === document.activeElement)).toBe(true)
    for (const control of [name, protocol]) {
      const size = await control.evaluate(element => ({
        height: element.clientHeight,
        line: Number.parseFloat(getComputedStyle(element).lineHeight),
      }))
      expect(size.height).toBeGreaterThanOrEqual(size.line)
    }
    await expectReachable(name, portrait)
    await mobileScreenshot(page, 'provider-text-200')
    const cancel = form.getByRole('button', { name: '取消', exact: true })
    await expectReachable(cancel, portrait)
    await cancel.tap()
    await form.waitFor({ state: 'hidden' })
    await expectReachable(dialog.getByRole('button', { name: '关闭', exact: true }), portrait)
    await dialog.getByRole('button', { name: '关闭', exact: true }).tap()
  })

  it.each([320, 390])('edits, saves and resets the real terminal plugin on a %ipx touch screen', async (width) => {
    const viewport = { width, height: 844 }
    page = await browser.newPage({ viewport, locale: ZH_BROWSER_LOCALE, hasTouch: true, isMobile: responsiveMobileEmulation, reducedMotion: 'reduce' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, `web-e2e-plugin-touch-${engine}-${width}`))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '打开侧边栏', exact: true }).tap()
    await page.getByRole('navigation', { name: '面板' }).getByRole('button', { name: '插件', exact: true }).tap()
    const panel = page.locator('[data-plugin-panel]')
    const details = panel.getByRole('button', { name: '查看 终端', exact: true })
    await expectReachable(details, viewport)
    await details.tap()
    const timeout = panel.getByLabel('命令超时（毫秒）', { exact: true })
    await timeout.waitFor()
    const original = await timeout.inputValue()
    await expectReachable(timeout, viewport)
    const fieldSize = await timeout.evaluate(element => ({
      height: element.getBoundingClientRect().height,
      width: element.getBoundingClientRect().width,
      parentWidth: element.parentElement!.getBoundingClientRect().width,
      font: Number.parseFloat(getComputedStyle(element).fontSize),
    }))
    expect(fieldSize.height).toBeGreaterThanOrEqual(44)
    expect(fieldSize.font).toBeGreaterThanOrEqual(16)
    expect(fieldSize.width).toBeLessThanOrEqual(fieldSize.parentWidth + 1)
    await timeout.tap()
    await timeout.fill('12000')
    const save = panel.getByRole('button', { name: '保存', exact: true })
    for (const action of [save, panel.getByRole('button', { name: '放弃修改', exact: true })]) {
      const bounds = await action.boundingBox()
      expect(bounds!.width).toBeGreaterThanOrEqual(44)
      expect(bounds!.height).toBeGreaterThanOrEqual(44)
    }
    await expectReachable(save, viewport)
    await mobileScreenshot(page, `plugin-draft-${width}`)
    await save.tap()
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).toContain('timeoutMs: 12000')
    await panel.getByText('已覆盖', { exact: true }).waitFor()
    const reset = panel.getByRole('button', { name: '恢复默认', exact: true })
    await expectReachable(reset, viewport)
    const resetBounds = await reset.boundingBox()
    expect(resetBounds!.width).toBeGreaterThanOrEqual(44)
    expect(resetBounds!.height).toBeGreaterThanOrEqual(44)
    await reset.tap()
    await expect.poll(() => timeout.inputValue()).toBe(original)
    await expectReachable(save, viewport)
    await save.tap()
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).not.toContain('timeoutMs: 12000')
    await mobileScreenshot(page, `plugin-reset-${width}`)
  })

  it('keeps the selected settings tab reachable on a 320px phone', async () => {
    page = await browser.newPage({
      viewport: { width: 320, height: 568 },
      locale: ZH_BROWSER_LOCALE,
      hasTouch: true,
      isMobile: responsiveMobileEmulation,
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
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
