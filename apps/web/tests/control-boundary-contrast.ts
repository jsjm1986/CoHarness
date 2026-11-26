/** Actual flat-edge contrast of editable controls in assembled browser pages. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'
import { expect } from 'vitest'
import { centerControlInScrollports, responsiveBrowserName } from './responsive-browser.ts'
import { auditResponsiveControl } from './responsive-controls.ts'
import { pixelContrast, sampleScreenshotPixels } from './screenshot-pixels.ts'

/**
 * Check a control's flat top border against its inner and outer adjacent pixels in both themes.
 * The caller supplies a control with clear space around its edge and no text in the top four pixels.
 * @param page - Actual application page; the original theme is restored after measurement.
 * @param control - Native editor control reached through the real UI.
 * @param state - Unique artifact-safe control and viewport label.
 */
export async function expectControlBoundaryContrast(page: Page, control: Locator, state: string): Promise<void> {
  const original = await page.locator('body').getAttribute('data-ds-dark-theme')
  const directory = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS ?? process.env.DSH_MOBILE_SCREENSHOTS
  const readings = []
  try {
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), theme === 'dark')
      await auditResponsiveControl(page, control, `${state}/${theme}/boundary`)
      await page.evaluate(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { resolve() })))
        const transitions = document.getAnimations().filter(animation => animation instanceof CSSTransition)
        await Promise.all(transitions.filter(animation => animation.pending).map(animation => animation.ready.catch(() => undefined)))
        await Promise.all(transitions.filter(animation => animation.playState === 'running'
          && Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)))
          .map(animation => animation.finished.catch(() => undefined)))
      })
      await centerControlInScrollports(control)
      const geometry = await control.evaluate((element: HTMLSelectElement | HTMLTextAreaElement) => {
        const { x, y, width, height } = element.getBoundingClientRect()
        return { x, y, width, height, disabled: element.disabled, scale: devicePixelRatio,
          viewport: { width: innerWidth, height: innerHeight } }
      })
      const clip = { x: Math.max(0, Math.floor(geometry.x - 4)), y: Math.max(0, Math.floor(geometry.y - 4)),
        width: 0, height: 0 }
      clip.width = Math.min(geometry.viewport.width, Math.ceil(geometry.x + geometry.width + 4)) - clip.x
      clip.height = Math.min(geometry.viewport.height, Math.ceil(geometry.y + geometry.height + 4)) - clip.y
      const png = await page.screenshot({ clip, scale: 'device', animations: 'allow' })
      const center = geometry.x + geometry.width / 2
      const samples = [{ x: center, y: geometry.y - 3 }, { x: center, y: geometry.y + 4 }]
      for (let x = center - 2; x <= center + 2; x += 1 / geometry.scale) {
        for (let y = geometry.y; y < geometry.y + 2; y += 1 / geometry.scale) samples.push({ x, y })
      }
      const values = await sampleScreenshotPixels(page, png, clip, samples)
      const outside = values[0]!, inside = values[1]!
      const adjacentContrast = (color: (typeof values)[number]): number =>
        Math.min(pixelContrast(color, outside), pixelContrast(color, inside))
      const boundary = values.slice(2).reduce((best, value) => adjacentContrast(value) > adjacentContrast(best) ? value : best)
      const reading = { state, theme, ...geometry, outside, inside, boundary, ratio: adjacentContrast(boundary) }
      readings.push(reading)
      if (directory !== undefined) {
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, `boundary-${responsiveBrowserName}-${state}-${theme}.png`), png)
      }
      if (!geometry.disabled) expect(reading.ratio, JSON.stringify(reading)).toBeGreaterThanOrEqual(3)
    }
  } finally {
    try {
      if (directory !== undefined) {
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, `boundary-${responsiveBrowserName}-${state}.json`), JSON.stringify(readings, null, 2) + '\n')
      }
    } finally {
      await page.evaluate((value) => {
        if (value === null) document.body.removeAttribute('data-ds-dark-theme')
        else document.body.setAttribute('data-ds-dark-theme', value)
      }, original)
    }
  }
}
