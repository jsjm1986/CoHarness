/**
 * Draft initialization through the shipped Web composition: the public
 * `uiWorkspace.startSession(workspaceId?, options?)` prefill/clear contract
 * over the real composer and the per-session durable draft — a prefill never
 * reaches the Host log.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/plugins/fixture-draft-init', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/draft-initialization', import.meta.url))
const MODE = webSnapshotMode()

interface DraftInitHandle {
  startSession(workspaceId: string | undefined, options: { prompt?: string; clearPreviousDraft?: boolean }): void
}

describe('web e2e: Session draft initialization', () => {
  let scaffold: WebScaffold
  let browser: Browser
  const tripwires: ReturnType<typeof watchConsole>[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraInstallAnchors: [join(FIXTURE, 'package.json')] })
    browser = await chromium.launch()
    await scaffold.ctx.loader.create({ name: '@fixture/draft-init' })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  async function newWorkspace(folder: string): Promise<WorkspaceId> {
    const path = join(scaffold.workspaceCwd, folder)
    await mkdir(path, { recursive: true })
    const workspace = await scaffold.ctx.workspaceRegistry.create(path)
    if (workspace === undefined) throw new Error('seeded workspace was not registered')
    return workspace.id
  }

  async function openPage(): Promise<Page> {
    const page = await newEnglishPage(browser)
    tripwires.push(watchConsole(page))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.waitForFunction(() => (window as typeof window & { __draftInit?: DraftInitHandle }).__draftInit !== undefined)
    return page
  }

  async function startSession(
    page: Page, workspaceId: string | undefined,
    options: { prompt?: string; clearPreviousDraft?: boolean },
  ): Promise<void> {
    await page.evaluate(([wid, opts]) => {
      const handle = (window as typeof window & { __draftInit?: DraftInitHandle }).__draftInit
      if (handle === undefined) throw new Error('The shipped Workspace apply has not been observed')
      handle.startSession(wid, opts)
    }, [workspaceId, options] as const)
  }

  async function selected(page: Page): Promise<string | undefined> {
    return page.evaluate(() => {
      const value = localStorage.getItem('dsh.sessions.current')
      return value === null ? undefined : (JSON.parse(value) as { sessionId?: string }).sessionId
    })
  }

  async function composerText(page: Page): Promise<string> {
    return page.locator('textarea:enabled').first().inputValue()
  }

  async function hostEvents(sessionId: string): Promise<readonly { type: string }[]> {
    return (await scaffold.ctx.sessionPersistence.inspect(SessionId(sessionId))).events
  }

  it('prefills the landed Session composer without sending anything to the Host', async () => {
    const wid = await newWorkspace('prefill')
    const page = await openPage()
    onTestFailed(() => saveFailureShot(page, 'web-e2e-draft-init-prefill'))

    await startSession(page, wid, { prompt: 'prefilled draft text' })
    await expect.poll(() => composerText(page), { timeout: 15_000 }).toBe('prefilled draft text')

    const sessionId = await selected(page)
    expect(sessionId).not.toBeUndefined()
    await expect.poll(async () => (await hostEvents(sessionId!)).length).toBeGreaterThan(0)
    const events = await hostEvents(sessionId!)
    expect(events.some(event => event.type === 'user/message')).toBe(false)
    expect(events.some(event => event.type === 'turn/start')).toBe(false)

    // The prefill survived through the durable draft owner: a reload restores it.
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await expect.poll(() => composerText(page), { timeout: 15_000 }).toBe('prefilled draft text')
  })

  it('preserves an existing draft without clear and replaces it with clear, on Workspace reuse', async () => {
    const wid = await newWorkspace('reuse')
    const page = await openPage()
    onTestFailed(() => saveFailureShot(page, 'web-e2e-draft-init-reuse'))

    await startSession(page, wid, { prompt: 'first draft' })
    await expect.poll(() => composerText(page), { timeout: 15_000 }).toBe('first draft')
    const sessionId = await selected(page)

    // Reconnecting the same Workspace lands on the same blank Session; the
    // draft the user kept is preserved over a prompt with no clear flag.
    await startSession(page, wid, { prompt: 'second draft' })
    await expect.poll(() => selected(page)).toBe(sessionId)
    await expect.poll(() => composerText(page)).toBe('first draft')

    await startSession(page, wid, { prompt: 'replacement draft', clearPreviousDraft: true })
    await expect.poll(() => selected(page)).toBe(sessionId)
    await expect.poll(() => composerText(page)).toBe('replacement draft')

    const events = await hostEvents(sessionId!)
    expect(events.some(event => event.type === 'user/message')).toBe(false)
    expect(events.some(event => event.type === 'turn/start')).toBe(false)
  })

  it('keeps the untouched flow when options are omitted', async () => {
    const wid = await newWorkspace('plain')
    const page = await openPage()
    onTestFailed(() => saveFailureShot(page, 'web-e2e-draft-init-plain'))

    await startSession(page, wid, {})
    await expect.poll(() => selected(page), { timeout: 15_000 }).not.toBeUndefined()
    await expect.poll(() => composerText(page)).toBe('')
  })

  it('restores an editable file reference after browser reload and preserves it on Workspace reuse', async () => {
    const wid = await newWorkspace('structured')
    await writeFile(join(scaffold.workspaceCwd, 'structured', 'reference target.md'), 'draft reference\n')
    const page = await openPage()
    onTestFailed(() => saveFailureShot(page, 'web-e2e-draft-init-reference'))
    const previous = await selected(page)
    await startSession(page, wid, {})
    await expect.poll(() => selected(page), { timeout: 15_000 }).not.toBe(previous)
    const sessionId = await selected(page)
    const input = page.locator('textarea:enabled').first()
    await input.fill('@reference')
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions', exact: true })
    const option = menu.getByRole('option', { name: /reference target\.md/u })
    // A candidate fetch that ran before the workspace file scan settled does
    // not retry on its own, so re-issue the last keystroke until it resolves.
    await expect.poll(async () => {
      if (await option.count() !== 0) return true
      await input.fill('@referenc')
      await input.pressSequentially('e')
      return false
    }, { timeout: 60_000 }).toBe(true)
    await option.click()
    const reference = page.locator('[data-reference-appearance="file"]')
    await expect.poll(() => reference.textContent()).toBe('@reference target.md')
    await expect.poll(() => input.inputValue()).toBe('@reference target.md ')

    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.waitForFunction(() => (window as typeof window & { __draftInit?: DraftInitHandle }).__draftInit !== undefined)
    await expect.poll(() => input.inputValue(), { timeout: 15_000 }).toBe('@reference target.md ')
    await expect.poll(() => reference.textContent()).toBe('@reference target.md')
    expect(await reference.locator('svg').count()).toBe(1)
    await input.focus()
    const snapshot = await captureStableAria(page, '[data-composer-card] textarea', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'reference.expected.md'), snapshot, MODE)

    await startSession(page, wid, { prompt: 'keep the existing reference' })
    await expect.poll(() => selected(page)).toBe(sessionId)
    await expect.poll(() => input.inputValue()).toBe('@reference target.md ')
    await input.press('End')
    await input.press('Backspace')
    await input.press('Backspace')
    await expect.poll(() => input.inputValue()).toBe('')
    expect(await reference.count()).toBe(0)
    const events = await hostEvents(sessionId!)
    expect(events.some(event => event.type === 'user/message' || event.type === 'turn/start')).toBe(false)
    expect(tripwires.at(-1)?.pageErrors).toEqual([])
    expect(tripwires.at(-1)?.warnings).toEqual([])
  })

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['reference.expected.md'])
  })
})
