/** Complete viewport sweeps for an already reached application state. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'
import { expectViewportFit, responsiveBrowserName, responsiveViewports } from './responsive-browser.ts'
import { saveFailureShot } from './support.ts'
import { auditResponsiveControls } from './responsive-controls.ts'

/**
 * Resize a real state, reach its visible controls, and retain screenshots for visual review.
 * @param page - application page with an explicit viewport.
 * @param surface - visible dialog, panel or menu under review.
 * @param state - stable receipt and artifact name.
 * @param verify - additional visual invariants checked at each viewport.
 * @returns the state and number of completed dimensions.
 */
export async function auditResponsiveState(
  page: Page, surface: Locator, state: string, verify?: () => Promise<void>,
): Promise<{ state: string; dimensions: number }> {
  const original = page.viewportSize()
  if (original === null) throw new Error('Responsive state audit needs an explicit viewport')
  try {
    for (const viewport of responsiveViewports) {
      await page.setViewportSize(viewport)
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
      }))
      try {
        await expectViewportFit(page, surface)
        await auditResponsiveControls(page, surface, state)
        await verify?.()
      }
      catch (error) {
        await saveFailureShot(page, `state-${responsiveBrowserName}-${state}-${viewport.name}`)
        throw new Error(`${state} at ${viewport.name}`, { cause: error })
      }
      const output = process.env.DSH_MOBILE_SCREENSHOTS
      if (output) {
        await mkdir(output, { recursive: true })
        await page.screenshot({ path: join(output, `state-${responsiveBrowserName}-${state}-${viewport.name}-actions.png`), animations: 'disabled' })
        await surface.evaluate((element) => {
          for (const node of [element, ...element.querySelectorAll('*')]) {
            if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight) node.scrollTop = 0
          }
        })
        await page.screenshot({ path: join(output, `state-${responsiveBrowserName}-${state}-${viewport.name}.png`), animations: 'disabled' })
      }
    }
    return { state, dimensions: responsiveViewports.length }
  } finally { await page.setViewportSize(original) }
}
