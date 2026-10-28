/** Shared toolbar geometry and emphasis through the runnable Web application. */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'

const MODE = webSnapshotMode()
const EXPECTED = fileURLToPath(new URL('./expected/toolbar-buttons.expected.md', import.meta.url))
let scaffold: WebScaffold | undefined
let browser: Browser | undefined
afterEach(async () => {
  await browser?.close()
  await scaffold?.close()
})

/** Read visible control geometry and contrast without font-rasterization differences. */
async function metrics(button: Locator) {
  return button.evaluate((element) => {
    const style = getComputedStyle(element)
    const svg = element.querySelector('svg')
    const luminance = (color: string): number => {
      const values = color.match(/[\d.]+/g)
      if (values === null) throw new Error('Expected computed RGB color')
      const channels = values.slice(0, 3).map(Number).map((value) => {
        const channel = value / 255
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
      })
      const [red, green, blue] = channels
      if (red === undefined || green === undefined || blue === undefined) throw new Error('Expected three RGB channels')
      return red * .2126 + green * .7152 + blue * .0722
    }
    const text = luminance(style.color)
    const background = luminance(style.backgroundColor)
    return {
      height: element.getBoundingClientRect().height,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      radius: style.borderTopLeftRadius,
      icon: svg?.getBoundingClientRect().width,
      fill: style.backgroundColor,
      contrast: Number(((Math.max(text, background) + .05) / (Math.min(text, background) + .05)).toFixed(2)),
    }
  })
}

it.skipIf(MODE === 'record')('aligns routine toolbar entries across themes while preserving their actions', async () => {
  scaffold = await launchWebScaffold({ workbench: true, openInApp: false })
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1566, height: 900 }, locale: 'en-US' })
  const tripwire = watchConsole(page)
  let documentReads = 0
  await page.route(/\/api\/documents(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return }
    documentReads += 1
    await route.fulfill({ json: {
      limits: {
        maxFileBytes: null, maxFilesPerMessage: 20, maxMessageBytes: 100, maxInlineTextBytes: 256,
        upload: { protocol: 'resumable-v1', chunkBytes: 8 * 1024 * 1024, sessionTtlMs: 86400000, resumable: true },
      },
      directoryId: '', directories: [],
      documents: [{ docId: 'brief.txt', name: 'brief.txt', bytes: 21, mediaType: 'text/plain', modifiedAt: 1 }],
    } })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const toolbar = page.locator('[data-workbench-toolbar]')
  await toolbar.waitFor({ timeout: 30_000 })
  const add = toolbar.getByRole('button', { name: 'Add conversation', exact: true })
  const results: unknown[] = []
  const enterWorkbench = async () => {
    await toolbar.getByRole('button', { name: 'Select workbench' }).click()
    await page.getByRole('menuitem', { name: /My workbench/ }).click()
  }
  const exitWorkbench = async () => {
    await toolbar.getByRole('button', { name: 'Select workbench' }).click()
    await page.getByRole('menuitem', { name: 'Exit workbench', exact: true }).click()
  }
  for (const theme of ['light', 'dark'] as const) {
    await enterWorkbench()
    await page.emulateMedia({ colorScheme: theme })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(theme === 'dark')
    await expect.poll(async () => (await metrics(add)).fill)
      .toBe(theme === 'light' ? 'rgb(235, 238, 242)' : 'rgb(53, 54, 56)')
    const addMetrics = await metrics(add)
    await add.click()
    const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
    await picker.waitFor()
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'hidden' })
    await exitWorkbench()
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    const documents = page.getByRole('dialog', { name: 'Document Manager', exact: true })
    await documents.getByText('brief.txt', { exact: true }).waitFor()
    const upload = documents.getByRole('button', { name: 'Upload Document', exact: true })
    const folder = documents.getByRole('button', { name: 'New Folder', exact: true })
    await expect.poll(() => upload.evaluate(element => element.getBoundingClientRect().height)).toBe(32)
    const uploadMetrics = await metrics(upload)
    const folderMetrics = await metrics(folder)
    expect(uploadMetrics).toEqual(addMetrics)
    expect(uploadMetrics).toMatchObject({ height: 32, fontSize: '13px', lineHeight: '20px', radius: '8px', icon: 16 })
    expect(folderMetrics.height).toBe(uploadMetrics.height)
    const search = documents.getByPlaceholder('Search document name')
    const type = documents.getByRole('combobox', { name: 'Type', exact: true })
    const more = documents.getByRole('button', { name: 'More actions', exact: true })
    const controls = await Promise.all([search.locator('..'), type, more].map(control => control.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { height: rect.height, radius: getComputedStyle(element).borderTopLeftRadius }
    })))
    expect(controls).toEqual(Array.from({ length: 3 }, () => ({ height: 32, radius: '8px' })))
    expect(await more.evaluate(element => element.getBoundingClientRect().width)).toBe(32)
    const readsBeforeRefresh = documentReads
    await more.click()
    await page.getByRole('menuitem', { name: 'Refresh', exact: true }).click()
    await expect.poll(() => documentReads).toBe(readsBeforeRefresh + 1)
    expect(await documents.isVisible()).toBe(true)

    expect(uploadMetrics.contrast).toBeGreaterThanOrEqual(4.5)
    const chooser = page.waitForEvent('filechooser')
    await upload.click()
    await (await chooser).setFiles([])
    expect(await documents.isVisible()).toBe(true)
    results.push({
      theme, geometry: uploadMetrics, adjacentHeight: folderMetrics.height, controls, pickerOpened: true, fileChooserOpened: true,
    })
    await page.keyboard.press('Escape')
    await documents.waitFor({ state: 'hidden' })
  }
  await enterWorkbench()
  await page.setViewportSize({ width: 390, height: 844 })
  expect((await metrics(add)).height).toBeGreaterThanOrEqual(44)
  await exitWorkbench()
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
  await page.getByRole('button', { name: 'Documents', exact: true }).click()
  const documents = page.getByRole('dialog', { name: 'Document Manager', exact: true })
  const upload = documents.getByRole('button', { name: 'Upload Document', exact: true })
  await upload.waitFor()
  await expect.poll(() => upload.evaluate(element => element.getBoundingClientRect().height)).toBe(44)
  const mobile = await metrics(upload)
  expect(mobile.height).toBeGreaterThanOrEqual(44)
  results.push({ mobileTargetAtLeast44: mobile.height >= 44, mobileFont: mobile.fontSize })
  expect(tripwire.pageErrors).toEqual([])
  if (MODE === 'refresh') await mkdir(fileURLToPath(new URL('./expected/', import.meta.url)), { recursive: true })
  await compareOrRefreshGolden(EXPECTED, '```json\n' + JSON.stringify(results, null, 2) + '\n```', MODE)
}, 120_000)
