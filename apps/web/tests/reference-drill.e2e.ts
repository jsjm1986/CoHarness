// Keyless assembled-browser coverage for the @ directory drill path. The
// scenario exercises the real file source, shared menu controller, breadcrumb
// header, and Tab arbitration without issuing a model request.
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/reference-drill', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: @ directory drill and breadcrumb', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await mkdir(join(scaffold.workspaceCwd, 'workspace', 'src'), { recursive: true })
    await writeFile(join(scaffold.workspaceCwd, 'workspace', 'src', 'nested.txt'), 'nested\n')
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('drills a directory with Tab and exposes a reversible breadcrumb', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-drill'))
    const input = page.locator('textarea').first()
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    await input.fill('@')
    const folder = menu.getByRole('option', { name: /Folder · src\// })
    await folder.waitFor({ timeout: 15_000 })
    await folder.hover()
    await input.press('Tab')
    await expect.poll(() => input.inputValue(), { timeout: 10_000 }).toBe('@src/')

    const navigation = page.getByRole('navigation', { name: 'Folder navigation' })
    await navigation.waitFor({ timeout: 10_000 })
    await menu.getByRole('option', { name: /nested\.txt/ }).waitFor({ timeout: 15_000 })
    const snapshot = await captureStableAria(page, '[data-trigger-menu]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(snapshot).toContain('Workspace')
    expect(snapshot).toContain('src')
    expect(snapshot).toContain('nested.txt')
    expect(await navigation.getByRole('button', { name: 'src' }).isDisabled()).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('keeps the snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
