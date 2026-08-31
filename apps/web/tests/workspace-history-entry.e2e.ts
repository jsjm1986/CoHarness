/**
 * Workspace entry semantics through the shipped Web composition: an existing
 * Workspace opens its latest historical Session, while the explicit New Session
 * control still opens the reusable blank Session. Keyless replay; no model turn.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedBlankSession,
  seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/workspace-history-entry', import.meta.url))
const DESKTOP_EXPECTED = join(SNAPSHOT_DIR, 'desktop.expected.md')
const COMPACT_EXPECTED = join(SNAPSHOT_DIR, 'compact.expected.md')
const MODE = webSnapshotMode()
const HISTORY_ID = 'workspace-history-entry-history'
const BLANK_ID = 'workspace-history-entry-blank'

describe('web e2e: Workspace history-first entry', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let compactContext: BrowserContext | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const seed = await readFile(SEED, 'utf8')
    const history = await seedSession(scaffold, seed, HISTORY_ID)
    const blank = await seedBlankSession(scaffold, BLANK_ID, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(history)
    await workspace.attachSession(blank)
    browser = await chromium.launch()
  }, 120_000)

  afterAll(async () => {
    await compactContext?.close()
    await browser?.close()
    await scaffold?.close()
  })

  async function openPage(viewport: { width: number; height: number }, compact = false): Promise<{
    page: Page
    tripwire: ReturnType<typeof watchConsole>
  }> {
    const page = await browser.newPage({
      viewport,
      locale: 'en-US',
      ...(compact ? { hasTouch: true, isMobile: true } : {}),
    })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 30_000 })
    return { page, tripwire }
  }

  it('desktop opens the existing history and exposes an explicit blank-session action', async () => {
    const opened = await openPage({ width: 1280, height: 800 })
    const { page } = opened
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-history-entry-desktop'))
    expect(await page.getByText('Into the Unknown', { exact: true }).count()).toBe(0)
    const snapshot = await captureStableAria(page, '[data-conversation-scroll]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DESKTOP_EXPECTED, snapshot, MODE)

    // The Workspace row keeps its creation affordance visible even while the
    // historical Session is active; no hover-only discovery is required.
    const workspaceNew = page.getByRole('button', { name: /New session in /i }).first()
    await workspaceNew.waitFor({ timeout: 15_000 })
    await workspaceNew.click()
    await page.getByText('Into the Unknown', { exact: true }).waitFor({ timeout: 15_000 })
    await page.locator('textarea[placeholder="Describe what you want to build"]').waitFor({ timeout: 15_000 })
    expect((await scaffold.ctx.sessionPersistence.list()).filter(session =>
      session.id === SessionId(BLANK_ID) || session.id === SessionId(HISTORY_ID)).length).toBe(2)
    // Repeated explicit New conversation gestures reuse the same blank
    // reservation instead of minting another empty Session.
    await page.getByRole('button', { name: 'New conversation', exact: true }).click()
    await page.waitForTimeout(50)
    expect((await scaffold.ctx.sessionPersistence.list()).filter(session =>
      session.id === SessionId(BLANK_ID) || session.id === SessionId(HISTORY_ID)).length).toBe(2)
    expect(opened.tripwire.pageErrors).toEqual([])
    await page.close()
  }, 60_000)

  it('compact opens the same historical conversation instead of the Hero blank state', async () => {
    compactContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'en-US',
      hasTouch: true,
      isMobile: true,
    })
    const page = await compactContext.newPage()
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-history-entry-compact'))
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 30_000 })
    expect(await page.getByText('Into the Unknown', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Open sidebar' }).count()).toBe(1)
    const snapshot = await captureStableAria(page, '[data-conversation-scroll]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(COMPACT_EXPECTED, snapshot, MODE)
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
    const drawer = page.locator('[class*="drawer"]').first()
    await drawer.getByRole('button', { name: /new session/i }).first().click()
    await page.getByText('Into the Unknown', { exact: true }).waitFor({ timeout: 15_000 })
    expect(tripwire.pageErrors).toEqual([])
    await page.close()
  }, 60_000)

  it('keeps the workspace-entry snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['compact.expected.md', 'desktop.expected.md'])
  })
})
