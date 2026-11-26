/** Rendered solid-color text measurements for actual application states. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'
import { expect } from 'vitest'
import { responsiveBrowserName } from './responsive-browser.ts'
import { auditResponsiveControl } from './responsive-controls.ts'

/** Computed text colors composited through ancestor backgrounds and opacity groups. */
export interface TextContrastReading {
  state: string
  theme: 'light' | 'dark'
  target: string
  text: string
  fontSize: string
  lineHeight: string
  foreground: readonly number[]
  background: readonly number[]
  ratio: number
  ancestorOpacity: number
  preview: boolean
}

/** Let active theme transitions settle without finishing paused or delayed page animations. */
async function screenshotTheme(page: Page, path: string): Promise<void> {
  await page.evaluate(async () => {
    const transitions = document.getAnimations().filter(animation => animation instanceof CSSTransition)
    await Promise.all(transitions.filter(animation => animation.pending).map(animation => animation.ready.catch(() => undefined)))
    await Promise.all(transitions.filter((animation) => {
      const timing = animation.effect?.getComputedTiming()
      return animation.playState === 'running' && timing !== undefined && timing.localTime !== null
        && Number.isFinite(Number(timing.endTime)) && Number(timing.localTime) >= Number(timing.delay)
        && Number(timing.localTime) < Number(timing.delay) + Number(timing.activeDuration)
    }).map(animation => animation.finished.catch(() => undefined)))
  })
  await page.screenshot({ path, animations: 'allow' })
}

/**
 * Capture readable leaf text in both themes before asserting its contrast.
 * Solid layers must resolve to an opaque backdrop; images, filters and blend modes fail explicitly.
 * The caller can complete the real interaction before asserting the returned measurements.
 * @param page - Application page whose original theme is restored after capture.
 * @param targets - Text leaves and unique artifact labels; an intentional ellipsis preview can name its containing region.
 * @param state - Unique artifact-safe state, including its viewport when running a matrix.
 * @returns Actual color, opacity and typography measurements for both themes.
 */
export async function captureTextContrast(page: Page, targets: readonly { label: string; text: Locator; region?: Locator }[],
  state: string): Promise<TextContrastReading[]> {
  const original = await page.locator('body').getAttribute('data-ds-dark-theme')
  const directory = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS ?? process.env.DSH_MOBILE_SCREENSHOTS
  const readings: TextContrastReading[] = []
  try {
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), theme === 'dark')
      for (const target of targets) {
        await auditResponsiveControl(page, target.region ?? target.text, `${state}/${theme}/${target.label}`)
        const region = target.region === undefined ? null : await target.region.elementHandle()
        if (target.region !== undefined && region === null) throw new Error('Text reading region disappeared before measurement')
        try {
          const measured = await target.text.evaluate(async (node, readingRegion) => {
            if (node.children.length !== 0) throw new Error('Text contrast requires a leaf element')
            const lineage: Element[] = []
            for (let current: Element | null = node; current !== null;) {
              lineage.push(current)
              const root = current.getRootNode()
              current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
            }
            const animations = lineage.flatMap(element => element.getAnimations())
              .filter(animation => Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)))
            await Promise.all(animations.filter(animation => animation.pending)
              .map(animation => animation.ready.catch(() => undefined)))
            await Promise.all(animations.filter((animation) => {
              const timing = animation.effect!.getComputedTiming()
              return animation.playState === 'running' && timing.localTime !== null
                && Number(timing.localTime) >= Number(timing.delay)
                && Number(timing.localTime) < Number(timing.delay) + Number(timing.activeDuration)
            })
              .map(animation => animation.finished.catch(() => undefined)))
            if (readingRegion !== null) {
              if (!readingRegion.contains(node)) throw new Error('Preview text must belong to its reading region')
              const bounds = readingRegion.getBoundingClientRect()
              const text = document.createRange()
              text.selectNodeContents(node)
              if (![...text.getClientRects()].some(rect => Math.min(bounds.right, rect.right) > Math.max(bounds.left, rect.left)
                && Math.min(bounds.bottom, rect.bottom) > Math.max(bounds.top, rect.top))) {
                throw new Error('Preview has no visible text in its reading region')
              }
            }
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 1
            const painter = canvas.getContext('2d')!
            const color = (value: string): number[] => {
              painter.clearRect(0, 0, 1, 1)
              painter.fillStyle = value
              painter.fillRect(0, 0, 1, 1)
              return [...painter.getImageData(0, 0, 1, 1).data].map(channel => channel / 255)
            }
            const over = (front: readonly number[], back: readonly number[]): number[] => {
              const alpha = front[3]! + back[3]! * (1 - front[3]!)
              return alpha === 0 ? [0, 0, 0, 0] : [0, 1, 2].map(index =>
                (front[index]! * front[3]! + back[index]! * back[3]! * (1 - front[3]!)) / alpha).concat(alpha)
            }
            const style = getComputedStyle(node)
            let foreground = color(style.color)
            let background = [0, 0, 0, 0]
            let ancestorOpacity = 1
            for (const element of lineage) {
              const layer = getComputedStyle(element)
              // Group effects transform the text node itself — always fail.
              if (layer.filter !== 'none' || layer.mixBlendMode !== 'normal') {
                throw new Error(`Text contrast needs pixel analysis for ${element.tagName}.${element.className}`)
              }
              // A backdrop layer cannot reach text already covered opaque.
              if (background[3] !== 1 && (layer.backgroundImage !== 'none'
                || (layer.backdropFilter !== '' && layer.backdropFilter !== 'none'))) {
                throw new Error(`Text contrast needs pixel analysis for ${element.tagName}.${element.className}`)
              }
              const backdrop = color(layer.backgroundColor)
              foreground = over(foreground, backdrop)
              background = over(background, backdrop)
              const opacity = Number(layer.opacity)
              ancestorOpacity *= opacity
              foreground[3]! *= opacity
              background[3]! *= opacity
            }
            if (foreground[3] !== 1 || background[3] !== 1) {
              throw new Error('Text contrast requires an opaque background instead of an assumed browser canvas color')
            }
            foreground = foreground.slice(0, 3)
            background = background.slice(0, 3)
            const luminance = (channels: readonly number[]): number => channels.reduce((sum, channel, index) => sum
              + (channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index]!, 0)
            const a = luminance(foreground), b = luminance(background)
            return { text: node.textContent ?? '', fontSize: style.fontSize, lineHeight: style.lineHeight,
              foreground, background, ancestorOpacity, preview: readingRegion !== null,
              ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }
          }, region)
          readings.push({ state, theme, target: target.label, ...measured })
          if (directory !== undefined) {
            await mkdir(directory, { recursive: true })
            await screenshotTheme(page, join(directory, `contrast-${responsiveBrowserName}-${state}-${theme}-${target.label}.png`))
          }
        } finally {
          await region?.dispose()
        }
      }
    }
    return readings
  } catch (error) {
    if (directory !== undefined) {
      await mkdir(directory, { recursive: true })
      await screenshotTheme(page, join(directory, `contrast-${responsiveBrowserName}-${state}-failed.png`))
    }
    throw error
  } finally {
    try {
      if (directory !== undefined) {
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, `contrast-${responsiveBrowserName}-${state}.json`), JSON.stringify(readings, null, 2) + '\n')
      }
    } finally {
      await page.evaluate((value) => {
        if (value === null) document.body.removeAttribute('data-ds-dark-theme')
        else document.body.setAttribute('data-ds-dark-theme', value)
      }, original)
    }
  }
}

/**
 * Require normal-size readable text to meet WCAG AA in every captured theme.
 * @param readings - Measurements retained before exercising the actual operation.
 */
export function expectTextContrast(readings: readonly TextContrastReading[]): void {
  expect(readings.length, 'Rendered text contrast must include actual measurements').toBeGreaterThan(0)
  for (const reading of readings) {
    expect(reading.ratio, `${reading.state}/${reading.theme}/${reading.target}: ${reading.text}`).toBeGreaterThanOrEqual(4.5)
  }
}
