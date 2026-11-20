/** Browser selection and geometry checks for real responsive feature flows. */
import { chromium, firefox, webkit, type Browser, type LaunchOptions, type Locator, type Page } from 'playwright'
import { expect } from 'vitest'
import { auditResponsiveControl } from './responsive-controls.ts'

const requestedBrowser = process.env.DSH_RESPONSIVE_BROWSER ?? 'chromium'
if (requestedBrowser !== 'chromium' && requestedBrowser !== 'webkit' && requestedBrowser !== 'firefox') {
  throw new Error('DSH_RESPONSIVE_BROWSER must be chromium, webkit or firefox')
}

/** Selected browser engine; Chromium remains the default for existing local runs. */
export const responsiveBrowserName = requestedBrowser
const selectedBrowser = { chromium, webkit, firefox }[requestedBrowser]
/** Disposable browser launcher for real local HTTP fixtures. */
export const responsiveBrowser = {
  /**
   * Launch the selected engine without routing Firefox's loopback fixtures through a system proxy.
   * @param options - caller launch options and Firefox preferences, which override the local-fixture default.
   * @returns the caller-owned browser; host proxy settings remain unchanged.
   */
  launch(options?: LaunchOptions): Promise<Browser> {
    return selectedBrowser.launch(requestedBrowser === 'firefox'
      ? { ...options, firefoxUserPrefs: { 'network.proxy.type': 0, ...options?.firefoxUserPrefs } }
      : options)
  },
}
/** Firefox supports touch input but does not implement Playwright mobile viewport emulation. */
export const responsiveMobileEmulation = requestedBrowser !== 'firefox'

/** Phone, foldable, tablet, landscape and shared layout breakpoint dimensions in CSS pixels. */
const allResponsiveViewports = [
  { name: 'phone-320', width: 320, height: 568 },
  { name: 'phone-360', width: 360, height: 800 },
  { name: 'phone-390', width: 390, height: 844 },
  { name: 'phone-430', width: 430, height: 932 },
  { name: 'foldable-540', width: 540, height: 720 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'tablet-1024', width: 1024, height: 768 },
  { name: 'landscape-568', width: 568, height: 320 },
  { name: 'landscape-800', width: 800, height: 360 },
  { name: 'landscape-844', width: 844, height: 390 },
  { name: 'landscape-932', width: 932, height: 430 },
  { name: 'landscape-720', width: 720, height: 540 },
  { name: 'browser-chrome-landscape', width: 872, height: 230 },
  { name: 'below-compact-breakpoint', width: 767, height: 844 },
  { name: 'above-compact-breakpoint', width: 769, height: 844 },
  { name: 'below-expanded-breakpoint', width: 1023, height: 800 },
  { name: 'above-expanded-breakpoint', width: 1025, height: 800 },
] as const

const requestedViewports = process.env.DSH_RESPONSIVE_VIEWPORTS?.split(',')
if (requestedViewports?.some(name => !allResponsiveViewports.some(viewport => viewport.name === name))) {
  throw new Error('DSH_RESPONSIVE_VIEWPORTS must name declared responsive viewports, separated by commas')
}
/** Declared matrix, or an explicit named subset for incremental acceptance. */
export const responsiveViewports = requestedViewports === undefined ? allResponsiveViewports
  : allResponsiveViewports.filter(viewport => requestedViewports.includes(viewport.name))

/**
 * Center a control for whole-box or pixel sampling through its user-scrollable ancestors.
 * @param control - The control whose rendered box the test will sample.
 */
export async function centerControlInScrollports(control: Locator): Promise<void> {
  await control.evaluate((element) => {
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      if (!/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY) || parent.scrollHeight <= parent.clientHeight) continue
      const box = element.getBoundingClientRect()
      const top = parent.getBoundingClientRect().top + parent.clientTop
      parent.scrollTop += box.top - top - Math.max(0, (parent.clientHeight - box.height) / 2)
    }
  })
}

/**
 * Check a visible feature surface and scroll each supplied action into reach.
 * Pass the enclosing scrollport for intentionally two-dimensional content.
 * @param page - loaded application page.
 * @param surface - visible feature surface, rather than only the clipped app root.
 * @param controls - critical actions that must be fully reachable after scrolling.
 */
export async function expectViewportFit(page: Page, surface: Locator, controls: readonly Locator[] = []): Promise<void> {
  const viewport = page.viewportSize()
  if (viewport === null) throw new Error('responsive verification requires an explicit viewport')
  await surface.waitFor({ state: 'visible' })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(viewport.width)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1)
  await expect.poll(async () => (await surface.boundingBox())?.width ?? 0).toBeGreaterThan(0)
  await expect.poll(async () => {
    const box = await surface.boundingBox()
    return box === null ? Infinity : Math.max(-box.x, box.x + box.width - viewport.width)
  }).toBeLessThanOrEqual(1)
  for (const control of controls) {
    await auditResponsiveControl(page, control, 'Responsive required control')
  }
}
