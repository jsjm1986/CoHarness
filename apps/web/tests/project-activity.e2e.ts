/** Shared-project activity tab through the shipped Web composition. */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const SESSION_ID = 'project-activity-web-e2e'
const MESSAGE_TEXT = 'Pinned the migration checklist to the top of the plan.'
const ANSWER_TEXT = 'Proceed with the staged rollout'
const QUESTION_TEXT = 'Roll out to production now or stage first?'
const OTHER_PROJECT_TEXT = 'Unrelated project activity'
const EXPECTED_DIR = fileURLToPath(new URL('./expected/project-activity', import.meta.url))
const MODE = webSnapshotMode()

let scaffold: WebScaffold
let browser: Browser
let context: BrowserContext | undefined
let page: Page | undefined
let tripwire: ReturnType<typeof watchConsole> | undefined

/** Account-scoped Gateway fakes for the project scope and one feed page. */
async function mockActivityGateway(target: Page, day = '2026-10-23'): Promise<void> {
  await target.route(/\/api\/host\.describe(?:\?.*)?$/, async (route) => {
    const response = await route.fetch()
    const body = await response.json() as {
      result: { ok: true; value: { runtimeTarget?: { kind: 'project'; projectId: number } } } | { ok: false }
    }
    if (body.result.ok) body.result.value.runtimeTarget = { kind: 'project', projectId: 9 }
    await route.fulfill({ response, json: body })
  })
  await target.route(/\/account\/api\/context(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      json: {
        user: { id: 7, username: 'lin', displayName: 'Lin', role: 'member' },
        scope: { kind: 'project', projectId: 9, projectName: 'Payments migration', mode: 'rw' },
        projects: [{ projectId: 9, name: 'Payments migration', path: '/srv/payments', mode: 'rw' }],
      },
    })
  })
  await target.route(/\/account\/api\/scope(?:\?.*)?$/, async (route) => {
    await route.fulfill({ status: 204, body: '' })
  })
  await target.route(/\/account\/api\/activity(?:\?.*)?$/, async (route) => {
    const selector = new URL(route.request().url()).searchParams.get('dshTarget')
      ?? (await route.request().allHeaders()).cookie?.match(/(?:^|;\s*)dsh-scope=([^;]+)/u)?.[1]
      ?? 'project:9'
    await route.fulfill({
      json: {
        items: selector === 'project:10' ? [{
          kind: 'message', sessionId: 'another-project', conversationTitle: 'Other project',
          actorUserId: 8, actorLabel: 'Zhou', occurredAt: `${day}T09:00:00.000Z`,
          seq: 1, text: OTHER_PROJECT_TEXT,
        }] : [
          {
            kind: 'message', sessionId: SESSION_ID, conversationTitle: 'Release plan',
            actorUserId: 8, actorLabel: 'Zhou', occurredAt: `${day}T09:00:00.000Z`,
            seq: 1, text: MESSAGE_TEXT,
          },
          {
            kind: 'answer', sessionId: SESSION_ID, conversationTitle: 'Release plan',
            actorUserId: 7, actorLabel: 'Lin', occurredAt: `${day}T08:59:00.000Z`,
            seq: 2, text: ANSWER_TEXT, questionText: QUESTION_TEXT,
          },
        ],
      },
    })
  })
  await target.route(/\/account\/api\/progress(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      json: {
        enabled: true,
        periods: [],
        status: { enabled: true, pending: 0, generating: false, canGenerate: true },
      },
    })
  })
}

/** Open a fresh conversation so the reveal click visibly switches panes. */
async function openBlankSession(target: Page): Promise<void> {
  await target.getByRole('button', { name: 'New session' }).first().click()
  expect(await target.getByText('DONE', { exact: true }).count()).toBe(0)
}

/** Open the activity tab through the right Sidebar guide capsule. */
async function openActivityTab(target: Page): Promise<void> {
  await target.getByRole('button', { name: 'Open right sidebar' }).click()
  const entry = target.locator('[data-sidebar-right-guide-entry="activity"]')
  if (await entry.count() === 0) {
    await target.getByRole('button', { name: 'New tab' }).click()
  }
  await entry.click()
}

describe('project activity tab', () => {
  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    const seeded = await seedSession(scaffold, await readFile(SEED, 'utf8'), SESSION_ID)
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(seeded)
    browser = await chromium.launch()
  }, 120_000)

  afterEach(async () => {
    try {
      expect(tripwire?.warnings ?? []).toEqual([])
      expect(tripwire?.pageErrors ?? []).toEqual([])
    } finally {
      await context?.close()
      context = undefined
      page = undefined
      tripwire = undefined
    }
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'project activity e2e cleanup failed')
  })

  it('keeps project activity pinned after another tab changes scope, then reveals the conversation row', async () => {
    context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', timezoneId: 'UTC' })
    page = await context.newPage()
    await page.clock.setFixedTime(new Date('2026-10-23T12:00:00.000Z'))
    tripwire = watchConsole(page)
    await mockActivityGateway(page)
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-activity'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openBlankSession(page)

    await openActivityTab(page)
    const feed = page.locator('[class*="feed"]')
    // The panel lands on the progress journal; the raw feed lives one segment over.
    await feed.getByText('No progress journal yet', { exact: true }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Time', exact: true }).click()
    await feed.getByText(MESSAGE_TEXT, { exact: true }).waitFor({ timeout: 15_000 })
    await feed.getByText(ANSWER_TEXT, { exact: true }).waitFor()
    await feed.getByText('Zhou', { exact: true }).waitFor()
    await feed.getByText('chose', { exact: true }).waitFor()

    // The folded line expands to the detail card; the question shows there.
    await feed.getByText(ANSWER_TEXT, { exact: true }).click()
    await feed.getByText(QUESTION_TEXT, { exact: false }).waitFor()

    const scopeTab = await page.context().newPage()
    try {
      await scopeTab.route('**/test-select-project', route => route.fulfill({
        headers: { 'set-cookie': 'dsh-scope=project:10; Path=/; SameSite=Lax' },
        body: 'Project 10 selected',
      }))
      await scopeTab.goto(new URL('/test-select-project', scaffold.authenticatedUrl).href)
    } finally {
      await scopeTab.close()
    }
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/account/api/activity')
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    const response = await refreshed
    expect(new URL(response.url()).searchParams.get('dshTarget')).toBe('project:9')
    await feed.getByText(MESSAGE_TEXT, { exact: true }).waitFor()
    expect(await feed.getByText(OTHER_PROJECT_TEXT, { exact: true }).count()).toBe(0)
    const snapshot = await captureStableAria(page, '[class*="feed"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(EXPECTED_DIR, 'ui.expected.md'), snapshot, MODE)

    const seeded = page.getByText('DONE', { exact: true })
    await feed.getByText('Jump to conversation', { exact: true }).click()
    await seeded.waitFor({ timeout: 15_000 })
  }, 90_000)

  it.each([
    { season: 'spring', day: '2026-03-08', now: '2026-03-09T04:30:00.000Z' },
    { season: 'fall', day: '2026-10-31', now: '2026-11-02T04:30:00.000Z' },
  ])('uses the previous local calendar day after the $season daylight-saving change', async ({ season, day, now }) => {
    context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', timezoneId: 'America/New_York' })
    page = await context.newPage()
    await page.clock.setFixedTime(new Date(now))
    tripwire = watchConsole(page)
    await mockActivityGateway(page, day)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openBlankSession(page)
    await openActivityTab(page)
    const feed = page.locator('[class*="feed"]')
    await feed.getByText('No progress journal yet', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Time', exact: true }).click()
    await feed.getByRole('button', { name: /Zhou · Lin 2/ }).waitFor()
    expect(await feed.getByRole('button', { name: `Yesterday · ${day.slice(5)} Zhou · Lin 2`, exact: true }).count()).toBe(1)
    const time = await captureStableAria(page, '[class*="feed"]', scaffold.workspaceCwd)
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await feed.getByText('Yesterday 05:00', { exact: true }).waitFor()
    const conversation = await captureStableAria(page, '[class*="feed"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(EXPECTED_DIR, `${season}-calendar-day.expected.md`),
      `Time view\n${time}\n\nConversation view\n${conversation}`, MODE)
  })

  it('owns its browser expectations', async () => {
    await assertFixtureInventory(EXPECTED_DIR, [
      'fall-calendar-day.expected.md', 'spring-calendar-day.expected.md', 'ui.expected.md',
    ])
  })
})
