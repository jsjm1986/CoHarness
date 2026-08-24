// Web e2e scenario: a long model label keeps the mobile composer toolbar
// partitioned. The test measures the assembled card because jsdom does not
// perform flex layout and cannot detect the overlap reported by the browser.
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
  modelPresentation: 'trigger' | 'summary'
  modelEffortDisplay: string
  modelLabelOverflow: string
  modelLabelWhiteSpace: string
  modelLabelTextOverflow: string
  modelLabelWidth: number
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
    const modelSummary = card.querySelector<HTMLElement>('[data-session-summary]')
    const model = modelButton ?? modelSummary
    const modelLabel = modelButton?.querySelector<HTMLElement>('[class*="triggerLabel"]')
      ?? card.querySelector<HTMLElement>('[data-model-summary]')
      ?? null
    const modelEffort = modelButton?.querySelector<HTMLElement>('[class*="triggerEffort"]') ?? null
    const send: HTMLButtonElement | null = trailing === null
      ? card.querySelector<HTMLButtonElement>('button[aria-label="发送消息"], button[aria-label="Send message"]')
      : [...trailing.querySelectorAll<HTMLButtonElement>('[class*="primary"]')].at(-1) ?? null
    if (
      row === null || tools === null || trailing === null || model === null
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
      model: rect(model),
      send: rect(send),
      modelTitle: modelButton?.getAttribute('title') ?? modelSummary?.textContent ?? null,
      modelPresentation: modelButton === null ? 'summary' : 'trigger',
      modelEffortDisplay: modelEffort === null ? 'summary' : getComputedStyle(modelEffort).display,
      modelLabelOverflow: getComputedStyle(modelLabel).overflow,
      modelLabelWhiteSpace: getComputedStyle(modelLabel).whiteSpace,
      modelLabelTextOverflow: getComputedStyle(modelLabel).textOverflow,
      modelLabelWidth: modelLabel.getBoundingClientRect().width,
      trailingWrapped: trailing.getBoundingClientRect().top >= tools.getBoundingClientRect().bottom - 1,
      toolControlRight,
    }
  }, MODEL_ID)
}

function renderGeometry(rows: readonly { width: number; metrics: ComposerMetrics }[]): string {
  const lines = [
    '# Mobile composer model seat',
    '',
    '| viewport | tool controls before model | model before Send | trailing layout | row inside card | effort display | label overflow | label white-space | label text overflow | label width |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const { width, metrics } of rows) {
    const toolsBeforeModel = metrics.modelPresentation === 'summary' || metrics.toolControlRight <= metrics.model.left + 1 || metrics.trailingWrapped
    const modelBeforeSend = metrics.modelPresentation === 'summary' || metrics.model.right <= metrics.send.left + 1
    const layout = metrics.modelPresentation === 'summary' ? 'summary' : metrics.trailingWrapped ? 'wrapped' : 'same-line'
    lines.push(`| ${String(width)}px | ${String(toolsBeforeModel)} | ${String(modelBeforeSend)} | ${layout} | ${String(metrics.row.left >= metrics.card.left - 1 && metrics.row.right <= metrics.card.right + 1)} | ${metrics.modelEffortDisplay} | ${metrics.modelLabelOverflow} | ${metrics.modelLabelWhiteSpace} | ${metrics.modelLabelTextOverflow} | ${String(Math.round(metrics.modelLabelWidth))}px |`)
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
      const readOnly = settings.getByRole('menuitemradio', { name: 'Read Only' })
      await readOnly.waitFor({ timeout: 10_000 })
      await readOnly.click()
      await page.waitForFunction(() => [...document.querySelectorAll('[data-session-settings-sheet] [role="menuitemradio"]')]
        .some(item => item.textContent?.includes('Read Only') && item.getAttribute('aria-checked') === 'true'), undefined, { timeout: 10_000 })
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

      expect(metrics.modelTitle?.startsWith(MODEL_NAME)).toBe(true)
      if (metrics.modelPresentation === 'summary') {
        expect(metrics.model.height).toBeGreaterThanOrEqual(56)
        continue
      }
      expect(
        metrics.tools.right <= metrics.trailing.left + tolerance || metrics.trailingWrapped,
      ).toBe(true)
      expect(
        metrics.toolControlRight <= metrics.model.left + tolerance || metrics.trailingWrapped,
      ).toBe(true)
      expect(metrics.model.right).toBeLessThanOrEqual(metrics.send.left + tolerance)
      expect(metrics.row.left).toBeGreaterThanOrEqual(metrics.card.left - tolerance)
      expect(metrics.row.right).toBeLessThanOrEqual(metrics.card.right + tolerance)
      expect(metrics.send.right).toBeLessThanOrEqual(metrics.card.right + tolerance)
      expect(metrics.modelEffortDisplay).toBe('block')
      expect(metrics.modelLabelOverflow).toBe('hidden')
      expect(metrics.modelLabelWhiteSpace).toBe('nowrap')
      expect(metrics.modelLabelTextOverflow).toBe('ellipsis')
      expect(metrics.modelLabelWidth, `viewport ${String(width)}`).toBeGreaterThanOrEqual(width === 320 ? 80 : 32)
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

  it('commits exactly the mobile geometry snapshot inventory', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['geometry.expected.md'])
  })
})
