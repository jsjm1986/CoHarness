/** Pure HTML witnesses for text contrast measurement and theme restoration. */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Browser, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { responsiveBrowser } from './responsive-browser.ts'
import { captureTextContrast, expectTextContrast, type TextContrastReading } from './text-contrast.ts'

let browser: Browser
let page: Page
beforeAll(async () => { browser = await responsiveBrowser.launch() })
afterAll(async () => { await browser?.close() })
beforeEach(async () => { page = await browser.newPage({ viewport: { width: 320, height: 240 } }) })
afterEach(async () => { await page?.close() })

async function content(css = '', html = '<span id="text">Readable text</span>'): Promise<void> {
  await page.setContent(`<style>
    html { background:#fff; }
    body { margin:16px; background:#fff; color:#000; font:14px/20px Arial,sans-serif; }
    #text { display:inline-block; }
    ${css}
  </style>${html}`)
}

async function measure(state: string): Promise<TextContrastReading[]> {
  return captureTextContrast(page, [{ label: 'text', text: page.locator('#text') }], `witness-${state}`)
}

function colors(readings: readonly TextContrastReading[], foreground: readonly number[], background: readonly number[]): void {
  expect(readings.map(reading => reading.theme)).toEqual(['light', 'dark'])
  for (const reading of readings) {
    foreground.forEach((channel, index) => { expect(reading.foreground[index]).toBeCloseTo(channel, 5) })
    background.forEach((channel, index) => { expect(reading.background[index]).toBeCloseTo(channel, 5) })
  }
}

it('measures opaque text in both actual theme styles and restores the absent theme attribute', async () => {
  await content('body[data-ds-dark-theme] { background:#000; color:#fff; }')
  const readings = await measure('opaque-themes')
  expect(readings.map(reading => reading.theme)).toEqual(['light', 'dark'])
  expect(readings[0]?.foreground).toEqual([0, 0, 0])
  expect(readings[0]?.background).toEqual([1, 1, 1])
  expect(readings[1]?.foreground).toEqual([1, 1, 1])
  expect(readings[1]?.background).toEqual([0, 0, 0])
  for (const reading of readings) {
    expect(reading.ratio).toBe(21)
    expect(reading.fontSize).toBe('14px')
    expect(reading.lineHeight).toBe('20px')
    expect(reading.preview).toBe(false)
  }
  expectTextContrast(readings)
  expect(await page.locator('body').getAttribute('data-ds-dark-theme')).toBeNull()
})

it.each([{ color: '#767676', passes: true }, { color: '#777777', passes: false }])(
  'keeps the normal-text threshold at 4.5 for $color', async ({ color, passes }) => {
    await content(`#text { color:${color}; }`)
    const readings = await measure(`threshold-${color.slice(1)}`)
    if (passes) expectTextContrast(readings)
    else expect(() => { expectTextContrast(readings) }).toThrow()
  },
)

it('composites text alpha before measuring against an opaque backdrop', async () => {
  await content('#text { color:#00000080; }')
  const readings = await measure('text-alpha')
  colors(readings, [127 / 255, 127 / 255, 127 / 255], [1, 1, 1])
  expect(() => { expectTextContrast(readings) }).toThrow()
})

it('composites a translucent background separately from opaque text', async () => {
  await content('#text { background:#00000080; }')
  const readings = await measure('background-alpha')
  colors(readings, [0, 0, 0], [127 / 255, 127 / 255, 127 / 255])
  expectTextContrast(readings)
})

it('applies group opacity to both text and its local background', async () => {
  await content('body { background:#f00; } section { background:#fff; opacity:.5; }',
    '<section><span id="text">Group opacity</span></section>')
  const readings = await measure('group-opacity')
  colors(readings, [.5, 0, 0], [1, .5, .5])
  for (const reading of readings) expect(reading.ancestorOpacity).toBe(.5)
})

it('composites nested opacity groups in their actual paint order', async () => {
  await content('section { background:#000; opacity:.5; } article { background:#fff; opacity:.5; }',
    '<section><article><span id="text">Nested opacity</span></article></section>')
  const readings = await measure('nested-opacity')
  colors(readings, [.5, .5, .5], [.75, .75, .75])
  for (const reading of readings) expect(reading.ancestorOpacity).toBe(.25)
  expect(() => { expectTextContrast(readings) }).toThrow()
})

it('samples a paused finite animation without waiting for it to finish', async () => {
  await content()
  await page.locator('#text').evaluate(async (node) => {
    const animation = node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1000, fill: 'both' })
    animation.pause()
    await animation.ready
    animation.currentTime = 500
  })
  const readings = await measure('paused-animation')
  colors(readings, [.5, .5, .5], [1, 1, 1])
  expect(await page.locator('#text').evaluate(node => node.getAnimations()[0]?.playState)).toBe('paused')
})

it('measures a toast before its delayed exit without finishing or dismissing it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-text-contrast-'))
  const original = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
  try {
    process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS = directory
    await content(`@keyframes toast-out { to { opacity:0; } }
      #toast { animation:toast-out 100ms linear 60s forwards; }`,
    '<section id="toast"><span id="text">Saved. Undo remains available.</span></section>')
    await page.locator('#toast').evaluate((node) => { node.addEventListener('animationend', () => { node.remove() }) })
    const readings = await measure('delayed-toast-exit')
    colors(readings, [0, 0, 0], [1, 1, 1])
    expectTextContrast(readings)
    expect((await readdir(directory)).filter(name => name.endsWith('.png'))).toHaveLength(2)
    expect(await page.locator('#toast').isVisible()).toBe(true)
    expect(await page.locator('#toast').evaluate((node) => {
      const timing = node.getAnimations()[0]!.effect!.getComputedTiming()
      return Number(timing.localTime) < Number(timing.delay)
    })).toBe(true)
  } finally {
    if (original === undefined) delete process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
    else process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS = original
    await rm(directory, { recursive: true, force: true })
  }
})

it('waits for an active finite entrance before measuring its final text opacity', async () => {
  await content()
  await page.locator('#text').evaluate(async (node) => {
    const animation = node.animate([{ opacity: .2 }, { opacity: 1 }], { duration: 1000, fill: 'both' })
    await animation.ready
    animation.currentTime = 1
  })
  const readings = await measure('active-entrance')
  colors(readings, [0, 0, 0], [1, 1, 1])
  expect(await page.locator('#text').evaluate(node => node.getAnimations()[0]?.playState)).toBe('finished')
  expectTextContrast(readings)
})

it('captures sibling controls after their theme transition settles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-text-contrast-theme-'))
  const original = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
  const screenshot = page.screenshot.bind(page)
  const painted: { dark: boolean; color: string; background: string }[] = []
  const capture = vi.spyOn(page, 'screenshot').mockImplementation(async (options) => {
    painted.push(await page.locator('#sibling').evaluate((node) => {
      const style = getComputedStyle(node)
      return { dark: document.body.hasAttribute('data-ds-dark-theme'), color: style.color, background: style.backgroundColor }
    }))
    return screenshot(options)
  })
  try {
    process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS = directory
    await content('#sibling { color:#000; background:#fff; transition:color .2s, background-color .2s; } '
      + 'body[data-ds-dark-theme] #sibling { color:#fff; background:#000; }',
    '<span id="text">Measured text</span><button id="sibling">Sibling control</button>')
    await measure('sibling-theme-transition')
    expect(painted).toEqual([
      { dark: false, color: 'rgb(0, 0, 0)', background: 'rgb(255, 255, 255)' },
      { dark: true, color: 'rgb(255, 255, 255)', background: 'rgb(0, 0, 0)' },
    ])
  } finally {
    capture.mockRestore()
    if (original === undefined) delete process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
    else process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS = original
    await rm(directory, { recursive: true, force: true })
  }
})

it.each([
  { name: 'gradient', css: 'background-image:linear-gradient(#fff,#000);' },
  { name: 'filter', css: 'filter:opacity(.5);' },
  { name: 'blend', css: 'mix-blend-mode:multiply;' },
])('rejects unsupported $name effects instead of reporting a solid-color ratio', async ({ name, css }) => {
  await content(`#text { ${css} }`)
  await expect(measure(name)).rejects.toThrow('needs pixel analysis')
})

it('rejects an unknown transparent canvas backdrop', async () => {
  await content('html,body { background:transparent; }')
  await expect(measure('transparent-canvas')).rejects.toThrow('requires an opaque background')
})

it.each([null, 'initial-value'])('restores the original theme %s after a dark-state measurement fails', async (original) => {
  await content('body[data-ds-dark-theme] #text { background-image:linear-gradient(#fff,#000); }')
  if (original !== null) await page.locator('body').evaluate((node, value) => { node.setAttribute('data-ds-dark-theme', value) }, original)
  await expect(measure(`restore-${original ?? 'absent'}`)).rejects.toThrow('needs pixel analysis')
  expect(await page.locator('body').getAttribute('data-ds-dark-theme')).toBe(original)
})

it('measures a visible ellipsis preview without claiming its clipped text is fully displayed', async () => {
  await content('#region { width:80px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }',
    '<div id="region"><span id="text">A long preview that opens complete details when selected.</span></div>')
  const readings = await captureTextContrast(page, [
    { label: 'preview', text: page.locator('#text'), region: page.locator('#region') },
  ], 'witness-ellipsis-preview')
  colors(readings, [0, 0, 0], [1, 1, 1])
  for (const reading of readings) expect(reading.preview).toBe(true)
  expectTextContrast(readings)
})

it('rejects a preview whose text lies completely outside its named region', async () => {
  await content('#region { width:80px; height:20px; overflow:hidden; } #text { margin-left:120px; white-space:nowrap; }',
    '<div id="region"><span id="text">Invisible preview</span></div>')
  await expect(captureTextContrast(page, [
    { label: 'preview', text: page.locator('#text'), region: page.locator('#region') },
  ], 'witness-hidden-preview')).rejects.toThrow('no visible text')
})

it('rejects text sampled from outside the declared preview region', async () => {
  await content('#region { width:80px; height:20px; }', '<div id="region"></div><span id="text">Unrelated text</span>')
  await expect(captureTextContrast(page, [
    { label: 'preview', text: page.locator('#text'), region: page.locator('#region') },
  ], 'witness-unrelated-preview')).rejects.toThrow('must belong to its reading region')
})

it('rejects mixed-style descendants instead of assigning their parent color to all text', async () => {
  await content('', '<span id="text">First <strong>second</strong></span>')
  await expect(measure('mixed-descendants')).rejects.toThrow('requires a leaf element')
})

it('rejects empty measurements', () => {
  expect(() => { expectTextContrast([]) }).toThrow('must include actual measurements')
})
