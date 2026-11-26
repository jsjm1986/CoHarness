/** Shared-project progress journal through the shipped Web composition. */

import { responsiveBrowser } from './responsive-browser.ts'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'

import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { captureStableAria, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'
import { compareWorkflowGolden, newWorkflowPage } from './workflow-responsive-state.ts'
import { activateActivityControl, auditActivityState, openActivitySession } from './activity-responsive-state.ts'
import { captureTextContrast, expectTextContrast } from './text-contrast.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const SESSION_ID = 'project-progress-web-e2e'
const OVERVIEW = 'PROGRESSOVERVIEW'
const OTHER_OVERVIEW = 'SECONDOVERVIEW'
const RUNTIME_ID = '10000000-0000-4000-8000-000000000009'
const NODE_ID = '20000000-0000-4000-8000-000000000009'
const DIGESTED_AT = '2026-10-21T10:30:00Z'
const JOURNAL_EXPECTED = fileURLToPath(new URL('./snapshots/project-progress/journal.expected.md', import.meta.url))
const STATUS_EXPECTED = fileURLToPath(new URL('./expected/project-progress/digest-status.expected.md', import.meta.url))
const SOURCE_EXPECTED = fileURLToPath(new URL('./snapshots/project-progress/source.expected.md', import.meta.url))
const GROUPS_EXPECTED = fileURLToPath(new URL('./snapshots/project-progress/groups.expected.md', import.meta.url))
const SUMMARY = 'Login rework is converging: the old API stays one more week.'
const DECIDED_TEXT = 'Keep the legacy endpoint for one week'
const DOING_TEXT = 'Login page cut over to the new API'
const CONV_TITLE = 'Login rework'

let scaffold: WebScaffold
let browser: Browser
let page: Page | undefined
let tripwire: ReturnType<typeof watchConsole> | undefined

function journalEntry(): unknown {
  return {
    id: 'period-1', kind: 'period', periodKey: '2026-W43', activityCount: 12,
    periodStart: '2026-10-19T00:00:00Z', periodEnd: '2026-10-21T00:00:00Z',
    model: 'deepseek/deepseek-chat', generatedAt: DIGESTED_AT,
    content: {
      sections: {
        decided: [{ text: DECIDED_TEXT, actor: 'Lin', sessionId: SESSION_ID, sessionTitle: CONV_TITLE, seq: 4 }],
        done: [],
        doing: [{ text: DOING_TEXT, sessionId: SESSION_ID, sessionTitle: CONV_TITLE }],
        blocked: [],
      },
    },
  }
}

function progressPage(options?: { generating?: boolean; pending?: number; empty?: boolean; lastError?: string }): unknown {
  return {
    enabled: true,
    ...(options?.empty === true ? {} : {
      current: {
        id: 'current-1', kind: 'current', activityCount: 12, model: 'deepseek/deepseek-chat',
        generatedAt: DIGESTED_AT,
        content: { summary: SUMMARY, sections: { decided: [], done: [], doing: [], blocked: [] } },
      },
      periods: [journalEntry()],
    }),
    status: {
      enabled: true, pending: options?.pending ?? 3,
      generating: options?.generating ?? false, canGenerate: true,
      ...(options?.lastError === undefined ? {} : { lastError: options.lastError }),
    },
  }
}

/** Account-scoped Gateway fakes: project scope, an empty feed, and the journal. */
async function mockProgressGateway(target: Page, journal: () => unknown): Promise<string[]> {
  const requests: string[] = []
  target.on('request', (request) => {
    if (/^\/account\/api\/(activity|progress)(?:\/generate)?$/.test(new URL(request.url()).pathname)) requests.push(request.url())
  })
  await target.route(/\/api\/host\.describe(?:\?.*)?$/, async (route) => {
    const response = await route.fetch()
    const body = await response.json() as {
      result: { ok: true; value: { runtimeTarget?: { kind: 'project'; projectId: number; runtimeId: string; nodeId: string } } } | { ok: false }
    }
    if (body.result.ok) body.result.value.runtimeTarget = { kind: 'project', projectId: 9, runtimeId: RUNTIME_ID, nodeId: NODE_ID }
    await route.fulfill({ response, json: body })
  })
  await target.route(/\/account\/api\/context(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      json: {
        user: { id: 7, username: 'lin', displayName: 'Lin', role: 'member' },
        scope: { kind: 'project', projectId: 9, projectName: 'Payments migration', mode: 'rw' },
        projects: [{ projectId: 9, name: 'Payments migration', path: '/srv/payments', mode: 'rw' }],
        environment: { id: RUNTIME_ID, nodeId: NODE_ID },
      },
    })
  })
  await target.route(/\/account\/api\/scope(?:\?.*)?$/, async (route) => {
    await route.fulfill({ status: 204, body: '' })
  })
  await target.route(/\/account\/api\/activity(?:\?.*)?$/, async (route) => {
    await route.fulfill({ json: { items: [] } })
  })
  await target.route(/\/account\/api\/progress(?:\?.*)?$/, async (route) => {
    await route.fulfill({ json: await journal() })
  })
  return requests
}

/** Every journal operation names its allocation even when another tab changes the scope cookie. */
function assertProjectRequests(requests: readonly string[]): void {
  expect(requests.length).toBeGreaterThan(0)
  for (const request of requests) {
    const query = new URL(request).searchParams
    expect(query.get('dshRuntime')).toBe(RUNTIME_ID)
    expect(query.get('dshTarget')).toBe('project:9')
  }
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

describe('project progress journal', () => {
  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    const recording = await readFile(SEED, 'utf8')
    const seeded = await seedSession(scaffold, recording, SESSION_ID)
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(seeded)
    for (const marker of [OVERVIEW, OTHER_OVERVIEW]) {
      await workspace.attachSession(await seedSession(scaffold, recording.replaceAll('DONE', marker), `overview-${marker.toLowerCase()}`))
    }
    browser = await responsiveBrowser.launch()
  }, 120_000)

  afterEach(async () => {
    try {
      expect(tripwire?.warnings ?? []).toEqual([])
      expect(tripwire?.pageErrors ?? []).toEqual([])
    } finally {
      await page?.close()
      page = undefined
      tripwire = undefined
    }
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'project progress e2e cleanup failed')
  })

  it('groups activity by stable conversation and member identities through renames', async () => {
    page = await newWorkflowPage(browser, 1000, 'UTC')
    tripwire = watchConsole(page)
    const requests = await mockProgressGateway(page, () => progressPage())
    await page.route(/\/account\/api\/activity(?:\?.*)?$/, async (route) => {
      await route.fulfill({ json: { items: [
        { kind: 'message', sessionId: 'c', conversationTitle: 'ab', actorUserId: 23, actorLabel: 'Lin1',
          occurredAt: '2026-10-17T11:00:00Z', seq: 3, text: 'Current conversation and member names' },
        { kind: 'message', sessionId: 'bc', conversationTitle: 'a', actorUserId: 3, actorLabel: 'Lin12',
          occurredAt: '2026-10-17T10:00:00Z', seq: 2, text: 'A distinct conversation and member' },
        { kind: 'message', sessionId: 'c', conversationTitle: 'Old', actorUserId: 23, actorLabel: 'Before rename',
          occurredAt: '2026-10-17T09:00:00Z', seq: 1, text: 'Names before the rename' },
      ] } })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openActivitySession(page, OVERVIEW)
    await openActivityTab(page)
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    const feed = page.locator('[class*="feed"]')
    await expect.poll(() => feed.locator('[class*="blockTitle"]').allTextContents()).toEqual(['ab', 'a'])
    await auditActivityState(page, 'activity-conversations', feed)
    const conversations = await captureStableAria(page, '[class*="feed"]', scaffold.workspaceCwd)
    await activateActivityControl(feed.locator('[class*="blockHead"]').first())
    await expect.poll(() => feed.locator('[class*="xRow"]').count()).toBe(2)
    await auditActivityState(page, 'activity-conversation-expanded', feed)
    await activateActivityControl(feed.locator('[class*="blockHead"]').first())
    await expect.poll(() => feed.locator('[class*="xRow"]').count()).toBe(0)
    await auditActivityState(page, 'activity-conversation-collapsed', feed)
    await page.getByRole('button', { name: 'Member', exact: true }).click()
    await feed.getByText('Lin12', { exact: true }).waitFor()
    expect(await feed.locator('[class*="blockHead"]').count()).toBe(2)
    expect(await feed.getByText('Before rename', { exact: true }).count()).toBe(0)
    await auditActivityState(page, 'activity-members', feed)
    const members = await captureStableAria(page, '[class*="feed"]', scaffold.workspaceCwd)
    await activateActivityControl(feed.locator('[class*="blockHead"]').first())
    await expect.poll(() => feed.locator('[class*="xRow"]').count()).toBe(2)
    await auditActivityState(page, 'activity-member-expanded', feed)
    await activateActivityControl(feed.locator('[class*="blockHead"]').first())
    await expect.poll(() => feed.locator('[class*="xRow"]').count()).toBe(0)
    await auditActivityState(page, 'activity-member-collapsed', feed)
    await compareWorkflowGolden(GROUPS_EXPECTED, `Conversations\n${conversations}\n\nMembers\n${members}`, webSnapshotMode())
    assertProjectRequests(requests)
  })

  it('lands on the journal, folds a period open, and reveals the source conversation', async () => {
    page = await newWorkflowPage(browser, 1000, 'UTC')
    tripwire = watchConsole(page)
    const requests = await mockProgressGateway(page, () => progressPage())
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-progress'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openActivitySession(page, OVERVIEW)

    await openActivityTab(page)
    const feed = page.locator('[class*="feed"]')
    await feed.getByText(SUMMARY, { exact: true }).waitFor({ timeout: 15_000 })
    await feed.getByText('Current progress', { exact: true }).waitFor()
    await feed.getByText('AI-generated', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'Progress', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await feed.getByText('3 new events not yet digested', { exact: true }).waitFor()

    // The newest period opens folded first; expanding shows the four sections.
    await feed.getByText('Week 43', { exact: true }).waitFor()
    expect(await feed.getByText(DECIDED_TEXT).count()).toBe(1)
    await feed.getByText('Decided', { exact: true }).waitFor()
    await feed.getByText('In progress', { exact: true }).waitFor()
    await feed.getByText('Generated by an AI digest', { exact: false }).waitFor()

    // Sidebar surfaces belong to their Session; open the journal in the new
    // Session before following its attribution back to the source.
    await openActivitySession(page, OTHER_OVERVIEW)
    await openActivityTab(page)
    await feed.getByText(SUMMARY, { exact: true }).waitFor()
    await compareWorkflowGolden(JOURNAL_EXPECTED,
      await captureStableAria(page, '[class*="feed"]', scaffold.workspaceCwd), webSnapshotMode())
    await auditActivityState(page, 'progress-journal', feed)
    const chip = feed.locator('button[class*="chip"]').first()
    await chip.click()
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
    await compareWorkflowGolden(SOURCE_EXPECTED,
      await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), webSnapshotMode())
    assertProjectRequests(requests)
  }, 90_000)

  it('drives a forced pass and watches the journal land', async () => {
    page = await newWorkflowPage(browser, 1000, 'UTC')
    tripwire = watchConsole(page)
    let busy = false
    let done = false
    let statusRefused = false
    const requests = await mockProgressGateway(page, () => progressPage({ generating: busy, pending: done ? 0 : 3 }))
    await page.route(/\/account\/api\/progress(?:\?.*)?$/, async (route) => {
      if (statusRefused) await route.fulfill({ status: 503, json: { error: 'QA status read unavailable' } })
      else await route.fallback()
    })
    await page.route(/\/account\/api\/progress\/generate(?:\?.*)?$/, async (route) => {
      busy = true
      await route.fulfill({ json: { started: true } })
    })
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-progress-generate'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openActivitySession(page, OVERVIEW)

    await openActivityTab(page)
    const feed = page.locator('[class*="feed"]')
    const button = feed.getByRole('button', { name: 'Digest now', exact: true })
    await button.waitFor({ timeout: 15_000 })
    await button.focus()
    await button.press('Space')
    // The forced pass is asynchronous: the poll marks it busy, then clears.
    await feed.getByText('Digesting…', { exact: true }).waitFor({ timeout: 15_000 })
    expect(await button.isDisabled()).toBe(true)
    expect(await button.evaluate(node => node === node.ownerDocument.activeElement)).toBe(true)
    await auditActivityState(page, 'progress-generating', feed)
    busy = false
    done = true
    await feed.getByText(SUMMARY, { exact: true }).waitFor()
    await feed.getByText('Digesting…', { exact: true }).waitFor({ state: 'hidden', timeout: 30_000 })
    await feed.getByText('3 new events not yet digested', { exact: true }).waitFor({ state: 'hidden', timeout: 15_000 })
    await auditActivityState(page, 'progress-current', feed)
    statusRefused = true
    await activateActivityControl(button)
    const unknown = feed.getByRole('status').getByText('Could not confirm digest status', { exact: true })
    await unknown.waitFor()
    expect(await feed.getByText(SUMMARY, { exact: true }).isVisible()).toBe(true)
    const uncertain = await captureStableAria(page, '[class*="feed"]', scaffold.workspaceCwd)
    busy = false
    statusRefused = false
    await activateActivityControl(feed.getByRole('button', { name: 'Refresh status', exact: true }))
    await button.waitFor()
    expect(await button.isEnabled()).toBe(true)
    await unknown.waitFor({ state: 'hidden' })
    const recovered = await captureStableAria(page, '[class*="feed"]', scaffold.workspaceCwd)
    await compareWorkflowGolden(STATUS_EXPECTED, `Status unavailable\n${uncertain}\n\nStatus refreshed\n${recovered}`, webSnapshotMode())
    assertProjectRequests(requests)
  }, 90_000)

  it.each([0, 3])('shows the unavailable state with %i pending events and no generate affordance', async (pending) => {
    page = await newWorkflowPage(browser, 1000, 'UTC')
    tripwire = watchConsole(page)
    const requests = await mockProgressGateway(page, () => ({
      enabled: false, periods: [],
      status: { enabled: false, pending, generating: false, canGenerate: false },
    }))
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-progress-off'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openActivitySession(page, OVERVIEW)

    await openActivityTab(page)
    const feed = page.locator('[class*="feed"]')
    await feed.getByText('No member activity yet', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'Time', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await activateActivityControl(page.getByRole('button', { name: 'Progress', exact: true }))
    await feed.getByText('Progress digest unavailable', { exact: false }).waitFor({ timeout: 15_000 })
    expect(await feed.getByRole('button', { name: 'Digest now' }).count()).toBe(0)
    if (pending > 0) await feed.getByText('3 new events not yet digested', { exact: true }).waitFor()
    await auditActivityState(page, pending === 0 ? 'progress-unavailable' : 'progress-disabled-pending-activity', feed)
    assertProjectRequests(requests)
  }, 90_000)

  it('keeps progress loading, failed reads, retry and long digest errors reachable', async () => {
    page = await newWorkflowPage(browser, 1000, 'UTC')
    tripwire = watchConsole(page)
    const current = page
    let release!: () => void
    let waiting = true
    let failed = false
    const ready = new Promise<void>((resolve) => { release = resolve })
    const lastError = 'The model provider could not finish the digest. Verify the organization model route and retry. '
      + 'Request: qa-progress-long-reference-1234567890-abcdefghijklmnopqrstuvwxyz'
    await mockProgressGateway(current, async () => {
      if (waiting) await ready
      return progressPage({ lastError })
    })
    await current.route(/\/account\/api\/progress(?:\?.*)?$/, async (route) => {
      if (failed) await route.fulfill({ status: 503, json: { error: 'QA progress reader unavailable' } })
      else await route.fallback()
    })
    try {
      await current.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await current.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await openActivitySession(current, OVERVIEW)
      await openActivityTab(current)
      const feed = current.locator('[class*="feed"]')
      await activateActivityControl(current.getByRole('button', { name: 'Progress', exact: true }))
      await feed.getByText('Loading…', { exact: true }).waitFor()
      await auditActivityState(current, 'progress-loading', feed)
      waiting = false
      release()
      await feed.getByText(SUMMARY, { exact: true }).waitFor()
      const errorLabel = feed.getByText(`Last digest failed: ${lastError}`, { exact: true })
      await errorLabel.waitFor()
      await auditActivityState(current, 'progress-last-error', feed)
      expectTextContrast(await captureTextContrast(current, [
        { label: 'progress-last-error', text: errorLabel },
      ], 'progress-last-error'))
      await activateActivityControl(feed.locator('[class*="blockHead"]').first())
      await feed.getByText(DECIDED_TEXT, { exact: true }).waitFor({ state: 'hidden' })
      await auditActivityState(current, 'progress-period-collapsed', feed)
      failed = true
      await activateActivityControl(current.getByRole('button', { name: 'Refresh', exact: true }))
      await feed.getByText('Progress load failed — refresh to retry', { exact: true }).waitFor()
      expect(await feed.getByText(SUMMARY, { exact: true }).isVisible()).toBe(true)
      await auditActivityState(current, 'progress-read-failed', feed)
      failed = false
      await activateActivityControl(feed.getByRole('button', { name: 'Refresh status', exact: true }))
      await errorLabel.waitFor()
      await auditActivityState(current, 'progress-retry-restored', feed)
    } finally { waiting = false; release() }
  }, process.env.DSH_FEATURE_MATRIX === '1' ? 600_000 : 90_000)
})
