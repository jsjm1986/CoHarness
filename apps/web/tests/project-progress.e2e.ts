/** Shared-project progress journal through the shipped Web composition. */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const SESSION_ID = 'project-progress-web-e2e'
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
    periodStart: '2026-10-14T00:00:00Z', periodEnd: '2026-10-21T00:00:00Z',
    model: 'deepseek/deepseek-chat', generatedAt: new Date().toISOString(),
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

function progressPage(options?: { generating?: boolean; pending?: number; empty?: boolean }): unknown {
  return {
    enabled: true,
    ...(options?.empty === true ? {} : {
      current: {
        id: 'current-1', kind: 'current', activityCount: 12, model: 'deepseek/deepseek-chat',
        generatedAt: new Date().toISOString(),
        content: { summary: SUMMARY, sections: { decided: [], done: [], doing: [], blocked: [] } },
      },
      periods: [journalEntry()],
    }),
    status: {
      enabled: true, pending: options?.pending ?? 3,
      generating: options?.generating ?? false, canGenerate: true,
    },
  }
}

/** Account-scoped Gateway fakes: project scope, an empty feed, and the journal. */
async function mockProgressGateway(target: Page, journal: () => unknown): Promise<void> {
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
    await route.fulfill({ json: { items: [] } })
  })
  await target.route(/\/account\/api\/progress(?:\?.*)?$/, async (route) => {
    await route.fulfill({ json: journal() })
  })
}

/** Open a fresh conversation so the workbench shell and sidebar rail are live. */
async function openBlankSession(target: Page): Promise<void> {
  await target.getByRole('button', { name: 'New session' }).first().click()
  expect(await target.getByText('DONE', { exact: true }).count()).toBe(0)
}

/** Open the activity tab through the right Sidebar guide capsule. */
async function openActivityTab(target: Page): Promise<void> {
  const entry = target.locator('[data-sidebar-right-guide-entry="activity"]')
  if (await entry.count() === 0) {
    // The chrome button renders only after the session header materializes;
    // click() auto-waits for it.
    await target.getByRole('button', { name: 'Open right sidebar', exact: true }).click({ timeout: 20_000 })
    // An expanded sidebar showing a non-guide tab offers "New tab" instead.
    await entry.waitFor({ timeout: 15_000 }).catch(async () => {
      await target.getByRole('button', { name: 'New tab' }).click()
    })
  }
  await entry.click()
}

describe('project progress journal', () => {
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

  it('lands on the journal, folds a period open, and reveals the source conversation', async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await mockProgressGateway(page, () => progressPage())
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-progress'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openBlankSession(page)

    await openActivityTab(page)
    const feed = page.locator('[class*="feed"]')
    await feed.getByText(SUMMARY, { exact: true }).waitFor({ timeout: 15_000 })
    await feed.getByText('Current progress', { exact: true }).waitFor()
    await feed.getByText('3 new events not yet digested', { exact: true }).waitFor()

    // The newest period opens folded first; expanding shows the four sections.
    await feed.getByText('Week 43', { exact: true }).waitFor()
    expect(await feed.getByText(DECIDED_TEXT).count()).toBe(1)
    await feed.getByText('Decided', { exact: true }).waitFor()
    await feed.getByText('In progress', { exact: true }).waitFor()
    await feed.getByText('Generated by an AI digest', { exact: false }).waitFor()

    // The attribution chip opens the source conversation; the pane stays open
    // beside a fresh main-pane session.
    await page.getByRole('button', { name: 'New session' }).first().click()
    const chip = feed.locator('button[class*="chip"]').first()
    await chip.click()
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
  }, 90_000)

  it('drives a forced pass and watches the journal land', async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    let busy = false
    let done = false
    await mockProgressGateway(page, () => {
      if (busy) { busy = false; done = true; return progressPage({ generating: true, pending: 3 }) }
      return progressPage({ generating: false, pending: done ? 0 : 3 })
    })
    await page.route(/\/account\/api\/progress\/generate(?:\?.*)?$/, async (route) => {
      busy = true
      await route.fulfill({ json: { started: true } })
    })
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-progress-generate'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openBlankSession(page)

    await openActivityTab(page)
    const feed = page.locator('[class*="feed"]')
    const button = feed.getByRole('button', { name: 'Digest now', exact: true })
    await button.waitFor({ timeout: 15_000 })
    await button.click()
    // The forced pass is asynchronous: the poll marks it busy, then clears.
    await feed.getByText('Digesting…', { exact: true }).waitFor({ timeout: 15_000 })
    expect(await button.isDisabled()).toBe(true)
    await feed.getByText(SUMMARY, { exact: true }).waitFor()
    await feed.getByText('Digesting…', { exact: true }).waitFor({ state: 'hidden', timeout: 30_000 })
    await feed.getByText('3 new events not yet digested', { exact: true }).waitFor({ state: 'hidden', timeout: 15_000 })
  }, 90_000)

  it('shows the unavailable state without a generate affordance', async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await mockProgressGateway(page, () => ({
      enabled: false, periods: [],
      status: { enabled: false, pending: 0, generating: false, canGenerate: false },
    }))
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-progress-off'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openBlankSession(page)

    await openActivityTab(page)
    const feed = page.locator('[class*="feed"]')
    await feed.getByText('Progress digest unavailable', { exact: false }).waitFor({ timeout: 15_000 })
    expect(await feed.getByRole('button', { name: 'Digest now' }).count()).toBe(0)
  }, 90_000)
})
