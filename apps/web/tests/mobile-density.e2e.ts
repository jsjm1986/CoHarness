// Compact-viewport density contract, exercised against the real web assembly
// at a phone size: the compact viewport flag is active, the transcript scrolls
// without horizontal overflow, and a session row's always-visible trailing
// strip is only the menu trigger — slot quick actions stay inside it.
// Run:
//   pnpm vitest run --config vitest.web.config.ts apps/web/tests/mobile-density.e2e.ts
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { launchWebScaffold, seedSession } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const SEED = fileURLToPath(new URL('./snapshots/navigation-panes/seed.jsonl', import.meta.url))

describe('mobile density', () => {
  it('compact frame keeps rows single-action and scroll unclipped', async () => {
    const scaffold = await launchWebScaffold()
    const browser = await chromium.launch()
    try {
      await seedSession(scaffold, await readFile(SEED, 'utf8'), 'mobile-density-seed')
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        locale: ZH_BROWSER_LOCALE,
      })
      const page = await context.newPage()
      // Real phones report hover:none, but the Playwright mobile context still
      // answers hover:hover and emulateMedia has no hover lane — stub
      // matchMedia so the Tooltip's hover gate takes the touch path.
      await page.addInitScript(() => {
        const real = window.matchMedia.bind(window)
        const hoverless = (query: string): MediaQueryList => ({
          matches: false, media: query, onchange: null,
          // oxlint-disable-next-line typescript/no-deprecated -- the MediaQueryList interface still requires the legacy listener members.
          addListener() {}, removeListener() {},
          addEventListener() {}, removeEventListener() {},
          dispatchEvent: () => false,
        })
        window.matchMedia = (query: string) => query.includes('hover')
          ? hoverless(query)
          : real(query)
      })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForTimeout(2_500)

      expect(await page.locator('[data-viewport="compact"]').count()).toBeGreaterThan(0)

      // Open the drawer and expand the seeded group to reach the session row.
      await page.locator('button[class*="topbarToggle"]').first().click()
      await page.waitForTimeout(800)
      const groupRow = page.locator('[role="treeitem"]').first()
      if (await groupRow.getAttribute('aria-expanded') === 'false') {
        await groupRow.click()
        await page.waitForTimeout(500)
      }
      const sessionRow = page.locator('[role="treeitem"]', { hasText: '未命名' }).first()
      await sessionRow.waitFor({ state: 'visible' })
      // On touch the trailing strip shows only the ellipsis menu trigger; the
      // slot-contributed pin/archive quick buttons stay inside the menu.
      const visibleRowButtons = await sessionRow
        .locator('[class*="rowActions"] button:visible')
        .count()
      expect(visibleRowButtons).toBe(1)

      // Enter the session and verify the transcript never overflows sideways.
      await sessionRow.click()
      await page.waitForTimeout(1_500)
      const scrollport = page.locator('[data-conversation-scroll]').first()
      const metrics = await scrollport.evaluate(el => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }))
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)

      // Hoverless pointers arm no hover tooltip: synthesize the touch-sequence
      // mouseenter on a chrome control and confirm nothing surfaces past the
      // hover delay.
      await page.locator('button[class*="topbarToggle"]').first().hover()
      await page.waitForTimeout(900)
      expect(await page.locator('[role="tooltip"]').count()).toBe(0)

      await context.close()
    } finally {
      await browser.close()
      await scaffold.close()
    }
  }, 120_000)
})
