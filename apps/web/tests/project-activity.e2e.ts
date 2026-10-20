/** Shared-project activity tab through the shipped Web composition. */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const SESSION_ID = 'project-activity-web-e2e'
const MESSAGE_TEXT = 'Pinned the migration checklist to the top of the plan.'
const ANSWER_TEXT = 'Proceed with the staged rollout'
const QUESTION_TEXT = 'Roll out to production now or stage first?'

let scaffold: WebScaffold
let browser: Browser
let page: Page | undefined
let tripwire: ReturnType<typeof watchConsole> | undefined

/** Account-scoped Gateway fakes for the project scope and one feed page. */
async function mockActivityGateway(target: Page): Promise<void> {
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
    await route.fulfill({
      json: {
        items: [
          {
            kind: 'message', sessionId: SESSION_ID, conversationTitle: 'Release plan',
            actorUserId: 8, actorLabel: 'Zhou', occurredAt: new Date().toISOString(),
            seq: 1, text: MESSAGE_TEXT,
          },
          {
            kind: 'answer', sessionId: SESSION_ID, conversationTitle: 'Release plan',
            actorUserId: 7, actorLabel: 'Lin', occurredAt: new Date(Date.now() - 60_000).toISOString(),
            seq: 2, text: ANSWER_TEXT, questionText: QUESTION_TEXT,
          },
        ],
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
    if (failures.length > 1) throw new AggregateError(failures, 'project activity e2e cleanup failed')
  })

  it('renders member messages and chosen answers, then reveals the conversation row', async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await mockActivityGateway(page)
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-activity'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openBlankSession(page)

    await openActivityTab(page)
    const feed = page.locator('[class*="feed"]')
    await feed.getByText(MESSAGE_TEXT, { exact: true }).waitFor({ timeout: 15_000 })
    await feed.getByText(QUESTION_TEXT, { exact: false }).waitFor()
    await feed.getByText(ANSWER_TEXT, { exact: true }).waitFor()
    await feed.getByText('Zhou', { exact: true }).waitFor()
    await feed.getByText('answered', { exact: true }).waitFor()

    const seeded = page.getByText('DONE', { exact: true })
    await feed.getByText(MESSAGE_TEXT, { exact: true }).click()
    await seeded.waitFor({ timeout: 15_000 })
  }, 90_000)
})
