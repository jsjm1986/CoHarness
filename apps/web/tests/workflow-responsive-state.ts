/** Responsive acceptance checkpoints inside the assembled workflow and collaboration fixtures. */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { expect } from 'vitest'
import { expectViewportFit, responsiveBrowserName, responsiveMobileEmulation, responsiveViewports } from './responsive-browser.ts'
import { newEnglishPage } from './support.ts'
import { compareOrRefreshGolden, type WebSnapshotMode } from './expected.ts'
import { auditResponsiveControls, responsiveControlAudit } from './responsive-controls.ts'

/** Explicit full-state acceptance lane; ordinary snapshot replay keeps its declared viewport. */
export const workflowMatrixEnabled = process.env.DSH_FEATURE_MATRIX === '1'

/** Touch context options for fixtures that own their initial viewport or clock. */
export const workflowTouchOptions = workflowMatrixEnabled ? { hasTouch: true, isMobile: responsiveMobileEmulation } : {}

/**
 * Compare the ordinary pointer-mode golden; touch matrices retain their own ARIA artifacts.
 * @param path - committed mouse-mode snapshot.
 * @param actual - normalized current snapshot.
 * @param mode - ordinary snapshot comparison or refresh mode.
 */
export async function compareWorkflowGolden(path: string, actual: string, mode: WebSnapshotMode): Promise<void> {
  if (!workflowMatrixEnabled) await compareOrRefreshGolden(path, actual, mode)
}

/**
 * Create the fixture's English page with real touch emulation in the responsive lane.
 * @param browser - selected browser engine.
 * @param height - baseline viewport height restored after each checkpoint.
 * @param timezoneId - optional fixture-owned timezone.
 * @returns the owned page.
 */
export async function newWorkflowPage(browser: Browser, height = 1000, timezoneId?: string): Promise<Page> {
  if (!workflowMatrixEnabled) return newEnglishPage(browser, height, timezoneId)
  return browser.newPage({ viewport: { width: 1680, height }, locale: 'en-US', hasTouch: true,
    isMobile: responsiveMobileEmulation, ...(timezoneId === undefined ? {} : { timezoneId }) })
}

/**
 * Inspect one actual visible state at every declared viewport without changing its business data.
 * Capture retains the reached action position and content start, then restores vertical scroll positions.
 * @param page - assembled application page holding the state.
 * @param domain - owning feature domain.
 * @param state - concrete visible state reached through the fixture's real flow.
 * @param surface - content or its deliberate two-dimensional scrollport.
 * @param controls - actions that must remain fully reachable.
 * @param prepare - optional responsive navigation needed to reveal the same state after resizing.
 * @param afterInspect - optional assertions after scrolling controls into reach.
 */
export async function auditWorkflowState(page: Page, domain: string, state: string, surface: Locator,
  controls: readonly Locator[] = [], prepare?: () => Promise<void>, afterInspect?: () => Promise<void>): Promise<void> {
  if (!workflowMatrixEnabled) return
  const original = page.viewportSize()
  if (original === null) throw new Error('Workflow acceptance requires a declared emulated viewport')
  const directory = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
  const receipts = process.env.DSH_FEATURE_COVERAGE_OUTPUT
  if (directory !== undefined) await mkdir(directory, { recursive: true })
  if (receipts !== undefined) await mkdir(receipts, { recursive: true })
  try {
    for (const viewport of responsiveViewports) {
      let status: 'passed' | 'failed' = 'passed'
      let failure: string | undefined
      try {
        await page.setViewportSize(viewport)
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })))
        await prepare?.()
        await expectViewportFit(page, surface, controls)
        await auditResponsiveControls(page, surface, `${domain}/${state}`)
        await afterInspect?.()
        expect(await page.evaluate(() => innerWidth), `${domain}/${state}: layout viewport`).toBe(viewport.width)
        if (directory !== undefined) {
          await page.screenshot({ path: join(directory, `${responsiveBrowserName}-${domain}-${state}-${viewport.name}.png`), animations: 'disabled' })
          await writeFile(join(directory, `${responsiveBrowserName}-${domain}-${state}-${viewport.name}.aria.md`), await surface.ariaSnapshot() + '\n')
          const scrollPositions = await surface.evaluateHandle(element =>
            [element, ...element.querySelectorAll('*')]
              .filter((node): node is HTMLElement => node instanceof HTMLElement && node.scrollTop > 0)
              .map(node => ({ node, top: node.scrollTop })))
          try {
            if (await scrollPositions.evaluate(positions => positions.length > 0)) {
              await scrollPositions.evaluate((positions) => { for (const { node } of positions) node.scrollTop = 0 })
              await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => {
                requestAnimationFrame(() => { resolve() })
              })))
              await page.screenshot({
                path: join(directory, `${responsiveBrowserName}-${domain}-${state}-${viewport.name}-start.png`), animations: 'disabled',
              })
            }
          } finally {
            try { await scrollPositions.evaluate((positions) => { for (const { node, top } of positions) node.scrollTop = top }) }
            finally { await scrollPositions.dispose() }
          }
        }
      } catch (error) {
        status = 'failed'; failure = String(error)
        if (directory !== undefined) await page.screenshot({ path: join(directory, `${responsiveBrowserName}-${domain}-${state}-${viewport.name}-failed.png`), animations: 'disabled' })
        throw error
      } finally {
        if (receipts !== undefined) await appendFile(join(receipts, `${responsiveBrowserName}.jsonl`), JSON.stringify({
          domain, state, viewport, status, checker: responsiveControlAudit, ...(failure === undefined ? {} : { error: failure }),
          touch: await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
        }) + '\n')
      }
    }
  } finally {
    await page.setViewportSize(original)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })))
  }
}
