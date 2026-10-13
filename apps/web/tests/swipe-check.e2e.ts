import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, seedSession } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const SEED = fileURLToPath(new URL('./snapshots/navigation-panes/seed.jsonl', import.meta.url))

/** Dispatch a synthetic finger drag on the first visible match; moves are spread over real time. */
async function drag(page: Page, pick: string, dx: number, dy: number) {
  return page.evaluate(async ({ pick, dx, dy }) => {
    const el = [...document.querySelectorAll<HTMLElement>(pick)].find(e => e.getClientRects().length > 0)
    if (!el) return 'no-element'
    const box = el.getBoundingClientRect()
    const x0 = box.left + Math.min(40, box.width / 2)
    const y0 = box.top + box.height / 2
    const mk = (type: string, x: number, y: number) => {
      const touch = new Touch({ identifier: 1, target: el, clientX: x, clientY: y })
      el.dispatchEvent(new TouchEvent(type, { touches: [touch], bubbles: true, cancelable: true }))
    }
    mk('touchstart', x0, y0)
    for (let i = 1; i <= 6; i++) {
      mk('touchmove', x0 + (dx * i) / 6, y0 + (dy * i) / 6)
      await new Promise(r => setTimeout(r, 60))
    }
    mk('touchend', x0 + dx, y0 + dy)
    return 'ok'
  }, { pick, dx, dy })
}

const drawerOpen = (page: Page) =>
  page.evaluate(() => !!document.querySelector('[class*="drawer"][data-open]'))

it('compact gestures: edge-swipe opens drawer, swipe closes it, sheets drag-dismiss', async () => {
  const scaffold = await launchWebScaffold()
  const browser = await chromium.launch()
  try {
    await seedSession(scaffold, await readFile(SEED, 'utf8'), 'swipe-gestures')
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
      isMobile: true, hasTouch: true, locale: ZH_BROWSER_LOCALE,
    })
    const page = await context.newPage()
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForTimeout(2500)

    // Left-edge swipe opens the drawer.
    expect(await drag(page, '[class*="edgeZone"]', 200, 0)).toBe('ok')
    await page.waitForTimeout(600)
    expect(await drawerOpen(page)).toBe(true)

    // A leftward drag on the open drawer tracks the finger and closes it.
    expect(await drag(page, '[class*="drawer"][data-open]', -200, 0)).toBe('ok')
    await page.waitForTimeout(600)
    expect(await drawerOpen(page)).toBe(false)

    // Open a session row menu (bottom sheet) through the drawer.
    await page.locator('button[class*="topbarToggle"]').first().click()
    await page.waitForTimeout(600)
    const group = page.locator('[role="treeitem"]').first()
    if (await group.getAttribute('aria-expanded') === 'false') {
      await group.click({ position: { x: 40, y: 22 } })
      await page.waitForTimeout(400)
    }
    const actionsBtn = page.locator('[role="treeitem"]', { hasText: '未命名' }).first().locator('button[class*="iconButton"]').first()
    await actionsBtn.click()
    await page.waitForTimeout(600)
    const sheetCount = () => page.evaluate(() => document.querySelectorAll('[role="menu"]').length)
    expect(await sheetCount()).toBeGreaterThan(0)

    // A short, slow drag snaps the sheet back instead of dismissing it.
    expect(await drag(page, '[role="menu"], [class*="list"][class*="scrollable"]', 0, 60)).toBe('ok')
    await page.waitForTimeout(500)
    expect(await sheetCount()).toBeGreaterThan(0)

    // A long downward drag dismisses the sheet and its scrim.
    expect(await drag(page, '[role="menu"], [class*="list"][class*="scrollable"]', 0, 240)).toBe('ok')
    await page.waitForTimeout(600)
    expect(await sheetCount()).toBe(0)
    expect(await page.evaluate(() => document.querySelectorAll('[aria-hidden][class*="_root_"]').length)).toBe(0)

    // The same drag on a Modal sheet (rename dialog) dismisses it too.
    await actionsBtn.click()
    await page.waitForTimeout(500)
    await page.locator('[role="menuitem"]', { hasText: '重命名' }).first().click()
    await page.waitForTimeout(600)
    expect(await page.evaluate(() => document.querySelectorAll('[role="dialog"]').length)).toBeGreaterThan(0)
    expect(await drag(page, '[role="dialog"]', 0, 260)).toBe('ok')
    await page.waitForTimeout(600)
    expect(await page.evaluate(() => document.querySelectorAll('[role="dialog"]').length)).toBe(0)

    await context.close()
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 120_000)
