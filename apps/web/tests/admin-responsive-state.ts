/** Responsive state sweeps without importing the Host web scaffold into the Gateway compiler. */
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'
import { expect } from 'vitest'
import { expectViewportFit, responsiveBrowserName } from './responsive-browser.ts'
import { auditResponsiveControls, responsiveControlAudit } from './responsive-controls.ts'

/** Phone, landscape, tablet and Admin breakpoint dimensions shared by page and form acceptance. */
const adminResponsiveSizes = [[320, 568], [360, 800], [375, 667], [390, 844], [412, 915], [430, 932], [540, 720],
  [667, 375], [844, 390], [872, 230], [767, 900], [768, 900], [769, 900],
  [839, 900], [840, 900], [841, 900], [1024, 768], [1280, 800]] as const

const selectedWidths = process.env.DSH_ADMIN_VIEWPORTS?.split(',').map(Number)
if (selectedWidths?.some(width => !adminResponsiveSizes.some(([candidate]) => candidate === width))) {
  throw new Error('DSH_ADMIN_VIEWPORTS must contain supported Admin viewport widths')
}
/** Explicitly selected widths for incremental page and form sweeps, or every acceptance dimension. */
export const selectedAdminSizes = selectedWidths === undefined ? adminResponsiveSizes
  : adminResponsiveSizes.filter(([width]) => selectedWidths.includes(width))

/**
 * Verify enabled standalone controls have a 44 by 44 CSS-pixel target on coarse pointers.
 * @param page - current real browser page.
 * @param surface - reached Admin or Gateway state; ordinary prose links are excluded.
 */
export async function auditAdminTouchTargets(page: Page, surface: Locator): Promise<void> {
  if (!await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) return
  const failures = await surface.locator('button, input:not([type="hidden"]), select, textarea, summary, '
    + '[role="button"], [role="menuitem"], [role="tab"], nav a[href], a.iconLink, a.userLink, a.projectLink, a.backLink')
    .evaluateAll(elements => elements.flatMap((element) => {
      if (!(element instanceof HTMLElement) || element.matches(':disabled, [aria-disabled="true"]') || element.closest('[inert]')) return []
      const active = document.activeElement?.closest(':modal')
      if (active !== undefined && active !== null && !active.contains(element)) return []
      const labels = element instanceof HTMLInputElement && /^(checkbox|radio)$/.test(element.type) ? [...element.labels ?? []] : []
      const targets = labels.length > 0 ? labels : [element]
      const boxes = targets.filter(target => getComputedStyle(target).visibility !== 'hidden').map(target => target.getBoundingClientRect())
        .filter(box => box.width > 0 && box.height > 0)
      if (boxes.length === 0 || boxes.some(box => box.width >= 44 && box.height >= 44)) return []
      return [{ control: element.outerHTML.slice(0, 220), targets: boxes.map(box => ({ width: box.width, height: box.height })) }]
    }))
  expect(failures, `enabled standalone touch controls have at least 44×44 CSS pixels: ${JSON.stringify(failures)}`).toEqual([])
}

/**
 * Inspect a reached Admin form state at every supported acceptance dimension.
 * @param page - the real authenticated Gateway page.
 * @param state - distinct operation or form state used in artifact names.
 * @param surface - visible form or dialog, resolved again after each responsive resize.
 * @param prepare - optional navigation to reveal the same state after a breakpoint change.
 */
export async function auditAdminState(
  page: Page, state: string, surface: Locator | (() => Locator), prepare?: () => Promise<void>,
): Promise<void> {
  if (process.env.DSH_FEATURE_MATRIX !== '1') return
  const original = page.viewportSize()
  if (original === null) throw new Error('Admin state acceptance requires an explicit viewport')
  const directory = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
  const receipts = process.env.DSH_FEATURE_COVERAGE_OUTPUT
  if (directory !== undefined) await mkdir(directory, { recursive: true })
  if (receipts !== undefined) await mkdir(receipts, { recursive: true })
  try {
    for (const [width, height] of selectedAdminSizes) {
      let failure: string | undefined
      try {
        await page.setViewportSize({ width, height })
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { resolve() }))))
        await prepare?.()
        const current = typeof surface === 'function' ? surface() : surface
        await expectViewportFit(page, current)
        await auditResponsiveControls(page, current, state)
        await auditAdminTouchTargets(page, current)
        if (directory !== undefined) await page.screenshot({ path: join(directory, `${responsiveBrowserName}-admin-${state}-${width}.png`) })
      } catch (error) {
        failure = String(error)
        if (directory !== undefined) await page.screenshot({ path: join(directory, `${responsiveBrowserName}-admin-${state}-${width}-failed.png`) })
        throw error
      } finally {
        if (receipts !== undefined) await appendFile(join(receipts, `admin-state-${responsiveBrowserName}.jsonl`), JSON.stringify({
          domain: 'admin-forms', state, viewport: { width, height }, status: failure === undefined ? 'passed' : 'failed',
          checker: responsiveControlAudit, checks: [...responsiveControlAudit.checks, 'admin-coarse-target-44'],
          ...(failure === undefined ? {} : { error: failure }),
        }) + '\n')
      }
    }
  } finally {
    await page.setViewportSize(original)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { resolve() }))))
  }
}
