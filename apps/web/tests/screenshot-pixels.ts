/** Pixel sampling and WCAG relative-luminance ratios for real browser screenshots. */
import type { Page } from 'playwright'

/** One opaque screenshot pixel in sRGB byte channels. */
export type PixelRgb = readonly [number, number, number]

/** Screenshot clip in page CSS pixels. */
export interface PixelClip { x: number; y: number; width: number; height: number }

/**
 * Decode an actual screenshot and sample page coordinates at its recorded device scale.
 * @param page - Browser used only to decode PNG bytes in a canvas.
 * @param png - Screenshot bytes.
 * @param clip - The CSS-pixel rectangle passed to page.screenshot.
 * @param samples - Page coordinates, in result order.
 * @returns Opaque RGB pixels; out-of-clip and transparent samples fail.
 */
export async function sampleScreenshotPixels(page: Page, png: Buffer, clip: PixelClip,
  samples: readonly { x: number; y: number }[]): Promise<PixelRgb[]> {
  return page.evaluate(async ({ base64, clip, samples }) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    try {
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width; canvas.height = bitmap.height
      const context = canvas.getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      const image = context.getImageData(0, 0, bitmap.width, bitmap.height)
      return samples.map(({ x, y }): [number, number, number] => {
        const px = Math.floor((x - clip.x) * bitmap.width / clip.width)
        const py = Math.floor((y - clip.y) * bitmap.height / clip.height)
        if (px < 0 || py < 0 || px >= bitmap.width || py >= bitmap.height) throw new Error('Pixel sample outside screenshot')
        const offset = (py * bitmap.width + px) * 4
        if (image.data[offset + 3] !== 255) throw new Error('Pixel sample requires an opaque screenshot')
        return [image.data[offset]!, image.data[offset + 1]!, image.data[offset + 2]!]
      })
    } finally { bitmap.close() }
  }, { base64: png.toString('base64'), clip, samples })
}

/**
 * Compare two opaque screenshot pixels using WCAG relative luminance.
 * @param a - First sRGB pixel.
 * @param b - Adjacent sRGB pixel.
 * @returns Contrast ratio between 1 and 21.
 */
export function pixelContrast(a: PixelRgb, b: PixelRgb): number {
  const luminance = (color: PixelRgb): number => color.reduce((sum, value, index) => {
    const channel = value / 255
    return sum + (channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index]!
  }, 0)
  const first = luminance(a), second = luminance(b)
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05)
}
