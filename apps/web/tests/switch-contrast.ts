/** Screenshot-pixel contrast for shared Switch controls in assembled application states. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'
import { expect } from 'vitest'
import { centerControlInScrollports, responsiveBrowserName } from './responsive-browser.ts'
import { auditResponsiveControl } from './responsive-controls.ts'
import { pixelContrast, sampleScreenshotPixels } from './screenshot-pixels.ts'

/**
 * Require enabled switch boundaries and thumb positions to remain distinguishable in both themes.
 * Disabled controls are recorded separately and retain their native disabled state; WCAG 1.4.11 exempts them.
 * @param page - Actual application page whose theme is restored after measurement.
 * @param toggle - Shared Switch reached through the real application workflow.
 * @param state - Unique artifact-safe workflow state, including its viewport when needed.
 */
export async function expectSwitchContrast(page: Page, toggle: Locator, state: string): Promise<void> {
  const original = await page.locator('body').getAttribute('data-ds-dark-theme')
  const directory = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS ?? process.env.DSH_MOBILE_SCREENSHOTS
  const readings = []
  try {
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), theme === 'dark')
      await auditResponsiveControl(page, toggle, `${state}/${theme}/switch`)
      await toggle.evaluate(async (element) => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { resolve() })))
        const animations = element.getAnimations({ subtree: true })
        for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) animations.push(...parent.getAnimations())
        await Promise.all(animations.filter(animation => animation.pending).map(animation => animation.ready.catch(() => undefined)))
        await Promise.all(animations.filter((animation) => {
          const timing = animation.effect?.getComputedTiming()
          return animation.playState === 'running' && timing !== undefined && timing.localTime !== null
            && Number.isFinite(Number(timing.endTime)) && Number(timing.localTime) >= Number(timing.delay)
        }).map(animation => animation.finished.catch(() => undefined)))
      })
      await centerControlInScrollports(toggle)
      const geometry = await toggle.evaluate((element: HTMLButtonElement) => {
        const track = element.querySelector('[data-switch-track]')!
        const rect = track.getBoundingClientRect()
        const thumb = track.firstElementChild!.getBoundingClientRect()
        const box = (value: DOMRect) => ({ x: value.x, y: value.y, width: value.width, height: value.height })
        return { track: box(rect), thumb: box(thumb), checked: element.getAttribute('aria-checked') === 'true',
          disabled: element.disabled, opacity: getComputedStyle(element).opacity, viewport: { width: innerWidth, height: innerHeight } }
      })
      const clip = { x: Math.max(0, Math.floor(geometry.track.x - 4)), y: Math.max(0, Math.floor(geometry.track.y - 4)),
        width: 0, height: 0 }
      clip.width = Math.min(geometry.viewport.width, Math.ceil(geometry.track.x + geometry.track.width + 4)) - clip.x
      clip.height = Math.min(geometry.viewport.height, Math.ceil(geometry.track.y + geometry.track.height + 4)) - clip.y
      const png = await page.screenshot({ clip, scale: 'device', animations: 'allow' })
      const track = geometry.track, thumb = geometry.thumb
      const scale = await page.evaluate(() => devicePixelRatio)
      const samples = [
        { x: track.x + track.width / 2, y: track.y - 3 },
        { x: geometry.checked ? track.x + track.height / 2 : track.x + track.width - track.height / 2, y: track.y + track.height / 2 },
        { x: thumb.x + thumb.width / 2, y: thumb.y + thumb.height / 2 },
      ]
      // The flat top edge avoids the antialiased capsule corners and the moving thumb.
      for (let x = track.x + track.width / 2 - 2; x <= track.x + track.width / 2 + 2; x += 1 / scale) {
        for (let y = track.y; y < track.y + 2; y += 1 / scale) samples.push({ x, y })
      }
      const values = await sampleScreenshotPixels(page, png, clip, samples)
      const outside = values[0]!, trackFill = values[1]!, thumbFill = values[2]!
      const boundary = values.slice(3).reduce((best, value) => pixelContrast(value, outside) > pixelContrast(best, outside) ? value : best)
      const pixels = { outside, trackFill, thumbFill, boundary, boundaryRatio: pixelContrast(boundary, outside),
        thumbRatio: pixelContrast(thumbFill, trackFill) }
      const reading = { state, theme, ...geometry, ...pixels }
      readings.push(reading)
      if (directory !== undefined) {
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, `switch-${responsiveBrowserName}-${state}-${theme}.png`), png)
      }
      if (!geometry.disabled) {
        expect(pixels.boundaryRatio, JSON.stringify(reading)).toBeGreaterThanOrEqual(3)
        expect(pixels.thumbRatio, JSON.stringify(reading)).toBeGreaterThanOrEqual(3)
      }
    }
  } finally {
    try {
      if (directory !== undefined) {
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, `switch-${responsiveBrowserName}-${state}.json`), JSON.stringify(readings, null, 2) + '\n')
      }
    } finally {
      await page.evaluate((value) => {
        if (value === null) document.body.removeAttribute('data-ds-dark-theme')
        else document.body.setAttribute('data-ds-dark-theme', value)
      }, original)
    }
  }
}
