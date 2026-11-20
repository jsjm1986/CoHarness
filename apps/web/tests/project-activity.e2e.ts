/** Shared-project activity tab through the shipped Web composition. */

import { responsiveBrowser } from './responsive-browser.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from 'playwright'

import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, launchWebScaffold, seedSession,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'
import { auditWorkflowState, compareWorkflowGolden, workflowTouchOptions } from './workflow-responsive-state.ts'
import { activateActivityControl, auditActivityState, openActivitySession } from './activity-responsive-state.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const SESSION_ID = 'project-activity-web-e2e'
const OVERVIEW = 'ACTIVITYOVERVIEW'
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

/** Open the activity tab through the right Sidebar guide capsule. */
async function openActivityTab(target: Page): Promise<void> {
  const entry = target.locator('[data-sidebar-right-guide-entry="activity"]')
  const expand = target.getByRole('button', { name: 'Open right sidebar', exact: true })
  const add = target.getByRole('button', { name: 'New tab', exact: true })
  await entry.or(expand).or(add).first().waitFor()
  if (await expand.isVisible()) await expand.click()
  if (!await entry.isVisible()) await add.click()
  await entry.click()
}

describe('project activity tab', () => {
  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    const recording = await readFile(SEED, 'utf8')
    const seeded = await seedSession(scaffold, recording, SESSION_ID)
    const overview = await seedSession(scaffold, recording.replaceAll('DONE', OVERVIEW), 'project-activity-overview')
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(seeded)
    await workspace.attachSession(overview)
    browser = await responsiveBrowser.launch()
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
    context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', ...workflowTouchOptions, timezoneId: 'UTC' })
    page = await context.newPage()
    await page.clock.setFixedTime(new Date('2026-10-23T12:00:00.000Z'))
    tripwire = watchConsole(page)
    await mockActivityGateway(page)
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-activity'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openActivitySession(page, OVERVIEW)

    await openActivityTab(page)
    const feed = page.locator('[class*="feed"]')
    await feed.getByText(MESSAGE_TEXT, { exact: true }).waitFor({ timeout: 15_000 })
    expect(await page.getByRole('button', { name: 'Time', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await page.getByRole('button', { name: 'Progress', exact: true }).click()
    await feed.getByText('No progress journal yet', { exact: true }).waitFor({ timeout: 15_000 })
    await auditActivityState(page, 'progress-empty', feed)
    await page.getByRole('button', { name: 'Time', exact: true }).click()
    await feed.getByText(MESSAGE_TEXT, { exact: true }).waitFor({ timeout: 15_000 })
    await feed.getByText(ANSWER_TEXT, { exact: true }).waitFor()
    await feed.getByText('Zhou', { exact: true }).waitFor()
    await feed.getByText('chose', { exact: true }).waitFor()
    await feed.getByRole('button', { name: 'Today Zhou · Lin 2', exact: true }).waitFor()
    const dayHeading = feed.getByRole('button', { name: 'Today Zhou · Lin 2', exact: true })
    await activateActivityControl(dayHeading)
    await feed.getByText(MESSAGE_TEXT, { exact: true }).waitFor({ state: 'hidden' })
    await auditActivityState(page, 'activity-time-collapsed', feed)
    await activateActivityControl(dayHeading)
    await feed.getByText(MESSAGE_TEXT, { exact: true }).waitFor()
    await auditActivityState(page, 'activity-time-expanded', feed)

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
    await auditActivityState(page, 'activity-expanded-answer', feed)
    const snapshot = await captureStableAria(page, '[class*="feed"]', scaffold.workspaceCwd)
    await compareWorkflowGolden(join(EXPECTED_DIR, 'ui.expected.md'), snapshot, MODE)

    const seeded = page.getByText('DONE', { exact: true })
    await feed.getByText('Jump to conversation', { exact: true }).click()
    await seeded.waitFor({ timeout: 15_000 })
  }, 90_000)

  it.each([
    { season: 'spring', day: '2026-03-08', now: '2026-03-09T04:30:00.000Z' },
    { season: 'fall', day: '2026-10-31', now: '2026-11-02T04:30:00.000Z' },
  ])('uses the previous local calendar day after the $season daylight-saving change', async ({ season, day, now }) => {
    context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', ...workflowTouchOptions, timezoneId: 'America/New_York' })
    page = await context.newPage()
    await page.clock.setFixedTime(new Date(now))
    tripwire = watchConsole(page)
    await mockActivityGateway(page, day)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openActivitySession(page, OVERVIEW)
    await openActivityTab(page)
    const feed = page.locator('[class*="feed"]')
    await feed.getByRole('button', { name: /Zhou · Lin 2/ }).waitFor()
    expect(await feed.getByRole('button', { name: `Yesterday · ${day.slice(5)} Zhou · Lin 2`, exact: true }).count()).toBe(1)
    const time = await captureStableAria(page, '[class*="feed"]', scaffold.workspaceCwd)
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await feed.getByText('Yesterday 05:00', { exact: true }).waitFor()
    const conversation = await captureStableAria(page, '[class*="feed"]', scaffold.workspaceCwd)
    await compareWorkflowGolden(join(EXPECTED_DIR, `${season}-calendar-day.expected.md`),
      `Time view\n${time}\n\nConversation view\n${conversation}`, MODE)
  })

  it('owns its browser expectations', async () => {
    await assertFixtureInventory(EXPECTED_DIR, [
      'fall-calendar-day.expected.md', 'member-filter.expected.md', 'spring-calendar-day.expected.md', 'ui.expected.md',
    ])
  })

  it.each([true, false])('opens the nested conversation target of a long answer when available=%s', async (available) => {
    context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', ...workflowTouchOptions, timezoneId: 'UTC' })
    page = await context.newPage()
    const current = page
    await current.clock.setFixedTime(new Date('2026-10-23T12:00:00.000Z'))
    await mockActivityGateway(current)
    const title = 'Deployment approval — verify the release window, workspace access and recovery instructions'
    const answer = 'Proceed only after checking the workspace permissions and preserving the current deployment data. '.repeat(12)
    await current.route(/\/account\/api\/activity(?:\?.*)?$/, async (route) => {
      await route.fulfill({ json: { items: [{ kind: 'answer', sessionId: available ? SESSION_ID : 'unavailable-activity-session',
        conversationTitle: title, actorUserId: 7, actorLabel: 'Lin', occurredAt: '2026-10-23T09:00:00.000Z',
        seq: 2, text: answer, questionText: 'Which release window and recovery plan should the team use?' }] } })
    })
    await current.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await current.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openActivitySession(current, OVERVIEW)
    await openActivityTab(current)
    const feed = current.locator('[class*="feed"]')
    const entry = feed.locator('[class*="tLine"]')
    await entry.focus()
    await entry.press('Enter')
    await feed.locator('[class*="detailAns"]').waitFor()
    if (available) await auditActivityState(current, 'activity-long-answer-nested-target', feed)
    await activateActivityControl(feed.getByRole('button', { name: title, exact: true }))
    if (available) {
      await current.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
    } else {
      await current.getByText('This conversation is not loaded. Start and open its workspace, then try again.', { exact: true }).waitFor()
      await auditWorkflowState(current, 'collaboration', 'activity-source-unavailable', current.locator('[class*="centerCol"]'))
    }
  }, process.env.DSH_FEATURE_MATRIX === '1' ? 300_000 : 60_000)

  it('keeps activity loading, empty, failed, filtered and paged states reachable', async () => {
    context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', ...workflowTouchOptions, timezoneId: 'UTC' })
    page = await context.newPage()
    const current = page
    await current.clock.setFixedTime(new Date('2026-10-23T12:00:00.000Z'))
    tripwire = watchConsole(current)
    await mockActivityGateway(current)
    let release!: () => void
    let phase: 'loading' | 'empty' | 'failed' | 'paged' = 'loading'
    let earlierRefused = false
    const ready = new Promise<void>((resolve) => { release = resolve })
    const entry = { kind: 'message', sessionId: SESSION_ID, conversationTitle: 'QA activity source',
      actorUserId: 7, actorLabel: 'Lin', occurredAt: '2026-10-23T09:00:00Z', seq: 1, text: 'The first activity page' }
    const roster = [{ userId: 7, label: 'Lin' }, { userId: 8, label: 'Zhou' }, { userId: 9, label: 'Ada' }]
    const zhou = { ...entry, actorUserId: 8, actorLabel: 'Zhou', seq: 0, text: 'The earlier activity page' }
    const filteredRequests: (string | null)[] = []
    await current.route(/\/account\/api\/activity(?:\?.*)?$/, async (route) => {
      if (phase === 'loading') await ready
      if (phase === 'failed') { await route.fulfill({ status: 503, json: { error: 'QA feed reader unavailable' } }); return }
      const query = new URL(route.request().url()).searchParams
      const before = query.get('before')
      if (phase === 'empty' || query.get('member') === '9') { await route.fulfill({ json: { items: [], members: roster } }); return }
      if (query.get('member') === '8') {
        filteredRequests.push(before)
        const json = before === null ? { items: [zhou], members: roster, nextBefore: 'qa-zhou-older' }
          : { items: [{ ...zhou, sessionId: 'older-zhou', text: 'Zhou’s earlier update' }] }
        await route.fulfill({ json })
        return
      }
      if (before !== null && earlierRefused) {
        await route.fulfill({ status: 503, json: { error: 'QA earlier activity reader unavailable' } })
        return
      }
      await route.fulfill({ json: before === null
        ? { items: [entry], members: roster, nextBefore: 'qa-page-2' }
        : { items: [zhou] } })
    })
    try {
      await current.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await current.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await openActivitySession(current, OVERVIEW)
      await openActivityTab(current)
      const feed = current.locator('[class*="feed"]')
      await activateActivityControl(current.getByRole('button', { name: 'Time', exact: true }))
      await feed.getByText('Loading…', { exact: true }).waitFor()
      await auditActivityState(current, 'activity-loading', feed)
      phase = 'empty'
      release()
      await feed.getByText('No member activity yet', { exact: true }).waitFor()
      await auditActivityState(current, 'activity-empty', feed)
      phase = 'failed'
      await activateActivityControl(current.getByRole('button', { name: 'Refresh', exact: true }))
      await feed.getByText('Load failed — refresh to retry', { exact: true }).waitFor()
      await auditActivityState(current, 'activity-read-failed', feed)
      phase = 'paged'
      await activateActivityControl(current.getByRole('button', { name: 'Refresh', exact: true }))
      await feed.getByText(entry.text, { exact: true }).waitFor()
      await auditActivityState(current, 'activity-earlier-available', feed)
      const memberFilter = current.getByRole('combobox', { name: 'Filter by member', exact: true })
      await memberFilter.selectOption('8')
      await feed.getByText(zhou.text, { exact: true }).waitFor()
      expect(await feed.getByText(entry.text, { exact: true }).count()).toBe(0)
      await activateActivityControl(feed.getByRole('button', { name: 'Load earlier', exact: true }))
      await feed.getByText('Zhou’s earlier update', { exact: true }).waitFor()
      expect(filteredRequests).toEqual([null, 'qa-zhou-older'])
      await auditActivityState(current, 'activity-member-filtered', feed)
      const filtered = await captureStableAria(current, '[class*="feed"]', scaffold.workspaceCwd)
      await memberFilter.selectOption('9')
      await feed.getByText('No visible activity from this member', { exact: true }).waitFor()
      await activateActivityControl(current.getByRole('button', { name: 'Refresh', exact: true }))
      await feed.getByText('No visible activity from this member', { exact: true }).waitFor()
      expect(await memberFilter.inputValue()).toBe('9')
      await auditActivityState(current, 'activity-member-filter-empty-after-refresh', feed)
      const memberEmpty = await captureStableAria(current, '[class*="feed"]', scaffold.workspaceCwd)
      await compareWorkflowGolden(join(EXPECTED_DIR, 'member-filter.expected.md'), `Filtered history\n${filtered}\n\nQuiet member\n${memberEmpty}`, MODE)
      await memberFilter.selectOption('')
      await feed.getByText(entry.text, { exact: true }).waitFor()
      earlierRefused = true
      await activateActivityControl(feed.getByRole('button', { name: 'Load earlier', exact: true }))
      await feed.getByText('Load failed — refresh to retry', { exact: true }).waitFor()
      expect(await feed.getByText(entry.text, { exact: true }).isVisible()).toBe(true)
      await auditActivityState(current, 'activity-earlier-refused-retained', feed)
      earlierRefused = false
      await activateActivityControl(feed.getByRole('button', { name: 'Load earlier', exact: true }))
      await feed.getByText('The earlier activity page', { exact: true }).waitFor()
      await auditActivityState(current, 'activity-earlier-loaded', feed)
    } finally { phase = 'empty'; release() }
  }, process.env.DSH_FEATURE_MATRIX === '1' ? 600_000 : 90_000)
})
