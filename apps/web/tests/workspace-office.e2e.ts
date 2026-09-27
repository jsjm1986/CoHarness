/** Real Office conversion and PDF rendering through the shipped authorized Workspace preview. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-office-to-pdf'
import { realOfficeBytes } from './office-fixture.ts'
import { launchWebScaffold, seedSession, watchConsole, captureStableAria, compareOrRefreshGolden, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FORMATS = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'] as const
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./snapshots/workspace-office/pdf.expected.md', import.meta.url))

describe('web e2e: authorized Office preview', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  beforeAll(async () => {
    scaffold = await launchWebScaffold({ workbench: true })
    expect(scaffold.ctx.get('officeToPdf')).toBeDefined()
    for (const extension of FORMATS) await writeFile(join(scaffold.workspaceCwd, `preview.${extension}`), realOfficeBytes(extension))
    await writeFile(join(scaffold.workspaceCwd, 'broken.docx'), 'This is not an Office archive.')
    const links = [...FORMATS.map(extension => `[Preview ${extension}](preview.${extension})`), '[Broken document](broken.docx)'].join('\n\n')
    const source = (await readFile(SEED, 'utf8')).replace('"text":"DONE"', `"text":${JSON.stringify(links)}`)
    const history = await seedSession(scaffold, source, 'workspace-office-history')
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(history)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  }, 120_000)
  afterAll(async () => { try { await browser?.close() } finally { await scaffold?.close() } })

  it.each(FORMATS)('converts %s with the installed engine and displays selectable PDF pages', async (extension) => {
    if (scaffold === undefined) throw new Error('Web scaffold is unavailable')
    onTestFailed(() => saveFailureShot(page, `workspace-office-${extension}`))
    const tripwire = watchConsole(page)
    await page.getByRole('button', { name: `Preview ${extension}`, exact: true }).click()
    const preview = page.getByRole('region', { name: `preview.${extension}`, exact: true })
    await preview.locator('[data-pdf-text]').getByText('Office preview', { exact: false }).first().waitFor({ timeout: 60_000 })
    const canvas = preview.locator('canvas').first()
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.width > 0 && element.height > 0)).toBe(true)
    expect(await canvas.evaluate((element: HTMLCanvasElement) => {
      const bytes = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
      return bytes.some((value, index) => index % 4 !== 3 && value < 200)
    })).toBe(true)
    if (extension === 'docx') {
      const snapshot = await captureStableAria(page, '[data-pdf-preview]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(GOLDEN, snapshot, webSnapshotMode())
    }
    await preview.getByRole('button', { name: 'Close preview', exact: true }).click()
    await expect.poll(() => preview.count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('reports a damaged document without displaying a successful PDF', async () => {
    await page.getByRole('button', { name: 'Broken document', exact: true }).click()
    const preview = page.getByRole('region', { name: 'broken.docx', exact: true })
    await preview.getByRole('alert').waitFor({ timeout: 60_000 })
    expect(await preview.locator('[data-pdf-preview]').count()).toBe(0)
    expect(await preview.getByRole('button', { name: 'Reload', exact: true }).isEnabled()).toBe(true)
  }, 90_000)
})
