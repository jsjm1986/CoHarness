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
    await page.getByRole('button', { name: 'Select model, current DeepSeek-V4-Flash', exact: true }).waitFor()
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
    expect((await scaffold.ctx.sessionPersistence.listHeaders()).filter(session =>
      session.id === SessionId(BLANK_ID) || session.id === SessionId(HISTORY_ID)).length).toBe(2)
    // Repeated explicit New Session gestures reuse the same blank
    // reservation instead of minting another empty Session.
    await workspaceNew.click()
    await page.waitForTimeout(50)
    expect((await scaffold.ctx.sessionPersistence.listHeaders()).filter(session =>
      session.id === SessionId(BLANK_ID) || session.id === SessionId(HISTORY_ID)).length).toBe(2)
    expect(opened.tripwire.pageErrors).toEqual([])
    await page.close()
  }, 60_000)

  it('a delayed New Session response cannot replace a later history selection or its draft', async () => {
    const { page, tripwire } = await openPage({ width: 1280, height: 800 })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-history-entry-navigation-race'))
    const requestStarted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const responseDelivered = Promise.withResolvers<undefined>()
    await page.route('**/api/session.create', async (route) => {
      requestStarted.resolve(undefined)
      await release.promise
      try {
        const response = await route.fetch()
        await route.fulfill({ response })
        responseDelivered.resolve(undefined)
      } catch (error) { responseDelivered.reject(error) }
    })
    try {
      const input = page.locator('textarea').first()
      await input.fill('Keep this history draft after delayed navigation')
      await page.getByRole('button', { name: /New session in /i }).first().click()
      await requestStarted.promise
      await page.locator('[role="treeitem"][aria-selected="true"]').click()
      const finished = page.waitForEvent('requestfinished', request => request.url().endsWith('/api/session.create'))
      release.resolve(undefined)
      await responseDelivered.promise
      await finished
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
      }))
      expect(await input.inputValue()).toBe('Keep this history draft after delayed navigation')
      expect(await page.getByText('DONE', { exact: true }).count()).toBe(1)
      expect(await page.getByText('Into the Unknown', { exact: true }).count()).toBe(0)
      await input.fill('')
      const snapshot = await captureStableAria(page, '[data-conversation-scroll]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(DESKTOP_EXPECTED, snapshot, 'replay')
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      release.resolve(undefined)
      await page.unrouteAll({ behavior: 'wait' })
      await page.close()
    }
  }, 60_000)

  it('keeps the current draft when history loading fails, then opens successfully on retry', async () => {
    const { page, tripwire } = await openPage({ width: 1280, height: 800 })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-history-entry-loading-failure'))
    try {
      const title = await page.locator('[role="treeitem"][aria-selected="true"] [class*="title"]').first().innerText()
      const history = page.locator('[role="treeitem"][aria-selected]').filter({ hasText: title })
      const create = page.getByRole('button', { name: /New session in /i }).first()
      await create.click()
      await page.getByText('Into the Unknown', { exact: true }).waitFor()
      const draft = page.locator('textarea').first()
      await draft.fill('Draft survives failed history loading')
      await page.route('**/api/session.history', route => route.abort('failed'))
      await history.click()
      await page.getByRole('alert').waitFor()
      expect(await draft.inputValue()).toBe('Draft survives failed history loading')
      expect(await page.getByText('Into the Unknown', { exact: true }).count()).toBe(1)
      expect(await history.getAttribute('aria-selected')).toBe('false')
      await page.unrouteAll({ behavior: 'wait' })
      await history.click()
      await page.getByText('DONE', { exact: true }).waitFor()
      expect(await history.getAttribute('aria-selected')).toBe('true')
      expect(await page.getByRole('alert').count()).toBe(0)
      await create.click()
      await page.getByText('Into the Unknown', { exact: true }).waitFor()
      expect(await draft.inputValue()).toBe('Draft survives failed history loading')
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page.unrouteAll({ behavior: 'wait' })
      await page.close()
    }
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

  it('keeps one auxiliary sidebar across collapse, reload and compact presentation', async () => {
    const { page, tripwire } = await openPage({ width: 1440, height: 900 })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-auxiliary-sidebar'))
    try {
      await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
      const panel = page.locator('[data-sidebar-right-panel]')
      await panel.getByRole('button', { name: 'Browser Browse HTTP(S) pages', exact: true }).click()
      await panel.locator('[data-dockkit-tab]').first().waitFor()
      await expect.poll(() => panel.getByRole('button', { name: 'Disable sandbox restrictions', exact: true }).isEnabled()).toBe(true)
      expect(await panel.count()).toBe(1)
      expect(await panel.getAttribute('data-sidebar-right-open')).not.toBeNull()
      expect(await page.locator('[class*="detailsPanel"]').count()).toBe(0)
      const snapshot = await captureStableAria(page, '[data-sidebar-right-panel]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'auxiliary.expected.md'), snapshot, MODE)
      await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
      await page.getByRole('button', { name: 'Open right sidebar', exact: true }).waitFor()
      expect(await panel.count()).toBe(1)
      await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
      await page.locator('[data-sidebar-right-panel][data-sidebar-right-open]').waitFor()
      await page.reload({ waitUntil: 'load' })
      await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).waitFor()
      expect(await page.locator('[data-sidebar-right-panel]').count()).toBe(1)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.locator('[data-sidebar-right-panel="fullscreen"]').waitFor()
      await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
      await page.getByRole('button', { name: 'Open right sidebar', exact: true }).waitFor()
      expect(await page.getByText('DONE', { exact: true }).count()).toBe(1)
      expect(tripwire.pageErrors).toEqual([])
    } finally { await page.close() }
  }, 60_000)

  it('keeps the workspace-entry snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['auxiliary.expected.md', 'compact.expected.md', 'desktop.expected.md'])
  })
})
