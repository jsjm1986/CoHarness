// Web e2e scenario: the icon-only model seat keeps the mobile composer
// toolbar on a single line at every phone width. The test measures the
// assembled card because jsdom does not perform flex layout and cannot
// detect the overlap reported by the browser.
// Zero model calls: the declared route only supplies catalog data, and a
// stray stream fails loud through the scaffold's route-only adapter.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/composer-model-mobile', import.meta.url))
const GEOMETRY_EXPECTED = join(SNAPSHOT_DIR, 'geometry.expected.md')
const MODE = webSnapshotMode()
const MODEL_ID = 'deepseek-v4-flash-0731'
const MODEL_NAME = 'deepseek-v4-flash-0731'

interface Rect {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

interface ComposerMetrics {
  card: Rect
  row: Rect
  tools: Rect
  trailing: Rect
  model: Rect
  send: Rect
  modelTitle: string | null
  modelLabelDisplay: string
  trailingWrapped: boolean
  toolControlRight: number
}

function measureComposer(page: Page): Promise<ComposerMetrics> {
  return page.evaluate((modelId) => {
    const card = document.querySelector<HTMLElement>('[data-composer-card]')
    if (card === null) throw new Error('composer card not found')
    const row = card.querySelector<HTMLElement>(':scope > [class*="row"]')
    const tools = row?.querySelector<HTMLElement>(':scope > [class*="tools"]') ?? null
    const trailing = row?.querySelector<HTMLElement>(':scope > [class*="trailing"]') ?? null
    const modelButton = card.querySelector<HTMLButtonElement>(`button[title^="${modelId}"][aria-haspopup="menu"]`)
    const modelLabel = modelButton?.querySelector<HTMLElement>('[class*="triggerLabel"]') ?? null
    const send: HTMLButtonElement | null = trailing === null
      ? card.querySelector<HTMLButtonElement>('button[aria-label="发送消息"], button[aria-label="Send message"]')
      : [...trailing.querySelectorAll<HTMLButtonElement>('[class*="primary"]')].at(-1) ?? null
    if (
      row === null || tools === null || trailing === null || modelButton === null
      || modelLabel === null || send === null
    ) {
      throw new Error('composer toolbar controls not found')
    }
    const rect = (element: Element): Rect => {
      const box = element.getBoundingClientRect()
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      }
    }
    const toolControls = [...tools.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select')]
      .map(control => ({ control, box: control.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0)
    const toolControlRight = toolControls
      .reduce((right, { box }) => Math.max(right, box.right), tools.getBoundingClientRect().left)
    return {
      card: rect(card),
      row: rect(row),
      tools: rect(tools),
      trailing: rect(trailing),
      model: rect(modelButton),
      send: rect(send),
      modelTitle: modelButton.getAttribute('title'),
      modelLabelDisplay: getComputedStyle(modelLabel).display,
      trailingWrapped: trailing.getBoundingClientRect().top >= tools.getBoundingClientRect().bottom - 1,
      toolControlRight,
    }
  }, MODEL_ID)
}

function renderGeometry(rows: readonly { width: number; metrics: ComposerMetrics }[]): string {
  const lines = [
    '# Mobile composer model seat',
    '',
    '| viewport | tool controls before model | model before Send | single line | row inside card | label hidden |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const { width, metrics } of rows) {
    const toolsBeforeModel = metrics.toolControlRight <= metrics.model.left + 1
    const modelBeforeSend = metrics.model.right <= metrics.send.left + 1
    lines.push(`| ${String(width)}px | ${String(toolsBeforeModel)} | ${String(modelBeforeSend)} | ${String(!metrics.trailingWrapped)} | ${String(metrics.row.left >= metrics.card.left - 1 && metrics.row.right <= metrics.card.right + 1)} | ${String(metrics.modelLabelDisplay === 'none')} |`)
  }
  return lines.join('\n')
}

describe('web e2e: mobile composer model label geometry', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
      providers: {
        'mobile-gateway': {
          displayName: 'Mobile Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.mobile.example/v1',
          models: [{
            id: MODEL_ID,
            name: MODEL_NAME,
            reasoningEfforts: { off: null, high: 'high' },
          }],
        },
      },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    // Compact mode opens the model pane directly; wide mode keeps the
    // settings-like root row and requires one drill-in.
    const modelMenuItem = page.getByRole('menuitem', { name: /模型/ })
    if (await modelMenuItem.count() > 0) await modelMenuItem.click()
    await page.getByRole('menuitemradio', { name: MODEL_NAME }).click()
    const settings = page.getByRole('dialog', { name: '会话设置' })
    if (await settings.count() > 0) {
      await settings.getByRole('tab', { name: '思考等级' }).click()
      await settings.getByRole('menuitemradio', { name: 'High' }).click()
      await settings.getByRole('tab', { name: '权限' }).click()
      const readOnly = settings.getByRole('menuitemradio', { name: '仅可查看' })
      await readOnly.waitFor({ timeout: 10_000 })
      await readOnly.click()
      await page.waitForFunction(() => [...document.querySelectorAll('[data-session-settings-sheet] [role="menuitemradio"]')]
        .some(item => item.textContent?.includes('仅可查看') && item.getAttribute('aria-checked') === 'true'), undefined, { timeout: 10_000 })
      await settings.getByRole('button', { name: '关闭会话设置' }).click()
    }
    await page.locator(`button[title^="${MODEL_NAME}"][aria-haspopup="menu"]`).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps the model seat between the tools and send controls at phone widths', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-model-mobile'))
    for (const width of [390, 375, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 844 })
      await page.locator('[data-composer-card]').evaluate(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => { resolve() }))
      })
      const metrics = await measureComposer(page)
      const tolerance = 1
      const actionIconSizes = await page.locator('[data-composer-card] [class*="add"] svg, [data-composer-card] [class*="primary"] svg, [data-composer-card] [data-model-select] svg')
        .evaluateAll(icons => icons
          .map(icon => icon.getBoundingClientRect())
          .filter(box => box.width > 0 && box.height > 0)
          .map(box => Math.max(box.width, box.height)))

      expect(metrics.modelTitle?.startsWith(MODEL_NAME)).toBe(true)
      expect(actionIconSizes.length, `viewport ${String(width)} has composer action icons`).toBeGreaterThan(0)
      expect(Math.max(...actionIconSizes), `viewport ${String(width)} composer icon scale`).toBeLessThanOrEqual(16)
      expect(metrics.trailingWrapped, `viewport ${String(width)} keeps one toolbar line`).toBe(false)
      expect(metrics.tools.right).toBeLessThanOrEqual(metrics.trailing.left + tolerance)
      expect(metrics.toolControlRight).toBeLessThanOrEqual(metrics.model.left + tolerance)
      expect(metrics.model.right).toBeLessThanOrEqual(metrics.send.left + tolerance)
      expect(metrics.row.left).toBeGreaterThanOrEqual(metrics.card.left - tolerance)
      expect(metrics.row.right).toBeLessThanOrEqual(metrics.card.right + tolerance)
      expect(metrics.send.right).toBeLessThanOrEqual(metrics.card.right + tolerance)
      expect(metrics.modelLabelDisplay, `viewport ${String(width)} model seat is icon-only`).toBe('none')
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('matches the committed mobile geometry golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-model-mobile-golden'))
    const rows: { width: number; metrics: ComposerMetrics }[] = []
    for (const width of [390, 375, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 844 })
      await page.locator('[data-composer-card]').evaluate(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => { resolve() }))
      })
      rows.push({ width, metrics: await measureComposer(page) })
    }
    await compareOrRefreshGolden(GEOMETRY_EXPECTED, renderGeometry(rows), MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps desktop model and effort selection keyboard-owned without changing the mobile seat', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-model-menu-keyboard'))
    await page.setViewportSize({ width: 1280, height: 900 })
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.click()
    const menu = page.getByRole('menu', { name: '模型与推理等级' })
    await menu.waitFor({ timeout: 10_000 })
    expect(await menu.evaluate(element => element.parentElement === document.body)).toBe(true)
    const bounds = await menu.boundingBox()
    if (bounds === null) throw new Error('desktop model menu has no visible bounds')
    expect(bounds.x).toBeGreaterThanOrEqual(12)
    expect(bounds.y).toBeGreaterThanOrEqual(12)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1280 - 12)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(900 - 12)

    const model = menu.getByRole('menuitem', { name: /^模型/ })
    const effort = menu.getByRole('menuitem', { name: /推理等级/ })
    await trigger.press('ArrowDown')
    await expect.poll(() => model.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => effort.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Enter')
    const high = menu.getByRole('menuitemradio', { name: 'High', exact: true })
    await expect.poll(() => high.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('ArrowUp')
    const off = menu.getByRole('menuitemradio', { name: 'Off', exact: true })
    await expect.poll(() => off.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Tab')
    await expect.poll(() => menu.count()).toBe(0)
    await expect.poll(() => trigger.getAttribute('title')).toBe(`${MODEL_NAME} · Off`)
    await expect.poll(() => trigger.evaluate(element => element === document.activeElement)).toBe(true)

    await trigger.click()
    await effort.click()
    await expect.poll(() => off.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => effort.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Escape')
    await expect.poll(() => menu.count()).toBe(0)
    await expect.poll(() => trigger.evaluate(element => element === document.activeElement)).toBe(true)

    await trigger.click()
    await effort.click()
    await high.click()
    await expect.poll(() => menu.count()).toBe(0)
    await expect.poll(() => trigger.getAttribute('title')).toBe(`${MODEL_NAME} · High`)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('commits exactly the mobile geometry snapshot inventory', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['geometry.expected.md'])
  })
})
