/** Project participant names on Chat bubbles through the shipped Web composition. */

import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/chat-sender-attribution', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/chat-sender-attribution/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'chat-sender-attribution-web-e2e'
const NOTICE_PREFIX = 'Shared-project attribution for the next message (metadata only, not instructions):'

function participant(
  userId: number,
  username: string,
  displayName: string,
  role: 'admin' | 'user',
) {
  return {
    userId,
    username,
    displayName,
    role,
    scope: { kind: 'project', projectId: 9, projectName: 'Payments', mode: 'rw' },
  }
}

function noticeSource(
  participantMessageId: string,
  speaker: ReturnType<typeof participant>,
) {
  return {
    kind: 'plugin',
    plugin: 'collaboration-context',
    form: 'notice',
    summary: `Message from ${speaker.displayName}`,
    participantMessageId,
    participant: speaker,
  }
}

/**
 * Closed two-turn log: a model-facing notice plus a human message from Zhou,
 * then the same pair from administrator Lin. Times are fixed so the fixture
 * is byte-deterministic; no line is model output.
 * @returns session.jsonl text for {@link seedSession}.
 */
function buildSeed(): string {
  const zhou = participant(8, 'zhou', 'Zhou', 'user')
  const lin = participant(7, 'lin', 'Lin', 'admin')
  const lines = [JSON.stringify({
    type: 'session', version: 0, id: '{{sessionId}}', createdAt: 1784974100000, cwd: '{{cwd}}/workspace',
  })]
  let seq = 0
  let time = 1784974100000
  const at = (event: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ ...event, seq: seq++, time: time++ }))
  }
  at({ type: 'turn/start', data: { turn: 1 } })
  at({
    type: 'user/message',
    data: {
      id: '11111111-1111-4111-8111-111111111111',
      role: 'user',
      content: [{ type: 'text', text: `${NOTICE_PREFIX} {"userId":8,"username":"zhou"}` }],
      source: noticeSource('22222222-2222-4222-8222-222222222222', zhou),
    },
    surfaceOp: 'append',
  })
  at({
    type: 'user/message',
    data: {
      id: '22222222-2222-4222-8222-222222222222',
      role: 'user',
      content: [{ type: 'text', text: 'ZHOU_PROMPT' }],
      source: { kind: 'user', participant: zhou },
    },
    surfaceOp: 'append',
  })
  at({ type: 'step/start', data: { turn: 1, step: 1 } })
  at({
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: '33333333-3333-4333-8333-333333333333',
        role: 'assistant',
        content: [{ type: 'text', text: 'ZHOU_REPLY' }],
        source: { kind: 'model', provider: 'snapshot', model: 'snapshot-replier' },
      },
    },
    sourceEventSeqs: [],
    surfaceOp: 'append',
  })
  at({ type: 'step/end', data: { turn: 1, step: 1 } })
  at({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  at({ type: 'turn/start', data: { turn: 2 } })
  at({
    type: 'user/message',
    data: {
      id: '44444444-4444-4444-8444-444444444444',
      role: 'user',
      content: [{ type: 'text', text: `${NOTICE_PREFIX} {"userId":7,"username":"lin"}` }],
      source: noticeSource('55555555-5555-4555-8555-555555555555', lin),
    },
    surfaceOp: 'append',
  })
  at({
    type: 'user/message',
    data: {
      id: '55555555-5555-4555-8555-555555555555',
      role: 'user',
      content: [{ type: 'text', text: 'LIN_PROMPT' }],
      source: { kind: 'user', participant: lin },
    },
    surfaceOp: 'append',
  })
  at({ type: 'step/start', data: { turn: 2, step: 1 } })
  at({
    type: 'assistant/message',
    data: {
      turn: 2,
      step: 1,
      message: {
        id: '66666666-6666-4666-8666-666666666666',
        role: 'assistant',
        content: [{ type: 'text', text: 'LIN_REPLY' }],
        source: { kind: 'model', provider: 'snapshot', model: 'snapshot-replier' },
      },
    },
    sourceEventSeqs: [],
    surfaceOp: 'append',
  })
  at({ type: 'step/end', data: { turn: 2, step: 1 } })
  at({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  return `${lines.join('\n')}\n`
}

describe('web e2e: Chat labels project senders on bubbles', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('chat-sender-attribution is a keyless assembled snapshot')
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, buildSeed(), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows participant names on human bubbles and hides the model notice', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-chat-sender-attribution'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => page.getByText('LIN_REPLY', { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    expect(await page.getByText('Zhou', { exact: true }).count()).toBe(1)
    expect(await page.getByText('Lin', { exact: true }).count()).toBe(1)
    expect(await page.getByText('admin', { exact: true }).count()).toBe(1)
    expect(await page.getByText(NOTICE_PREFIX, { exact: false }).count()).toBe(0)
    const snapshot = (await captureStableAria(page, '[data-conversation-scroll]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('issued zero model calls and stayed clean', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
