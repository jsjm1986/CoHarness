/** Timed question recovery through the shipped Web runtime and real question service. */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/timed-question-claim', import.meta.url))
const STANDARD_PRESET = fileURLToPath(new URL('../../cli/config/agent-presets/standard', import.meta.url))
const CALL_ID = ToolCallId('timed-question-delayed-claim')
const QUESTION = 'Which rollout should we use?'
const CLAIM_PATH = '/api/_stream/userQuestions/attachWait'

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function replayScript(): ReplayOverrideDoc {
  const args = JSON.stringify({
    questions: [{ id: 'rollout', question: QUESTION, options: [{ label: 'Staged' }] }],
    timeout: 10,
  })
  return [
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: CALL_ID, name: 'ask_user_question', argumentsDelta: args },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: CALL_ID, name: 'ask_user_question', arguments: args } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: textChunks('Work continued while the question stayed open.') },
    { kind: 'chunks', chunks: textChunks('DONE') },
  ]
}

describe.skipIf(MODE === 'record')('web e2e: timed question claim lifetime', () => {
  let replayDir: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const events: SessionEvent[] = []
  const claimStarted = Promise.withResolvers<undefined>()
  const releaseClaim = Promise.withResolvers<undefined>()
  const claimFailed = Promise.withResolvers<undefined>()

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-timed-claim-'))
    const presetRoot = join(replayDir, 'presets')
    const timedPreset = join(presetRoot, 'timed')
    await cp(STANDARD_PRESET, timedPreset, { recursive: true })
    const composition = join(timedPreset, 'agent.cordis.yml')
    const source = await readFile(composition, 'utf8')
    const toolRow = "- id: tool-ask-user\n  name: '@deepseek-ai/dsh-tool-ask-user'"
    if (!source.includes(toolRow)) throw new Error('shipped standard preset has no ask-user row')
    await writeFile(composition, source.replace(toolRow, `${toolRow}\n  config:\n    mode: timed`))
    const override = join(replayDir, 'replay.override.json')
    await writeFile(override, JSON.stringify(replayScript()))
    scaffold = await launchWebScaffold({
      replayFixture: join(replayDir, 'override-only.jsonl'), replayOverride: override,
      agentPresets: { roots: [{ path: presetRoot, trust: 'system' }], default: 'timed' },
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.on('requestfailed', (request) => {
      if (new URL(request.url()).pathname === CLAIM_PATH) claimFailed.resolve(undefined)
    })
    await page.route(`**${CLAIM_PATH}*`, async (route) => {
      claimStarted.resolve(undefined)
      await releaseClaim.promise
      // The wait's AbortSignal owns this request; its cancellation precedes release.
      await route.abort().catch(() => {
        // Chromium can discard the intercepted route when the owning fetch aborts.
      })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    releaseClaim.resolve(undefined)
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (replayDir !== undefined) await rm(replayDir, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    if (failures.length > 0) throw new AggregateError(failures, 'timed question claim cleanup failed')
  })

  it('submits a late answer after the unresolved claim request is cancelled', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-timed-question-claim'))
    const settled = scaffold.whenTurnSettled()
    void settled.catch(() => {})
    const input = page.locator('textarea').first()
    await input.fill('Ask which rollout to use, continue after the timed wait, and accept my later answer.')
    await input.press('Enter')
    await claimStarted.promise
    await settled
    await claimFailed.promise
    releaseClaim.resolve(undefined)
    const card = page.locator('[data-question-key]')
    await card.getByText('Work continued — you can still answer', { exact: true }).waitFor({ timeout: 15_000 })
    const pending = await captureStableAria(page, '[data-question-key]', scaffold.workspaceCwd)
    if (MODE === 'refresh') await mkdir(SNAPSHOT_DIR, { recursive: true })
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'pending.expected.md'), pending, MODE)

    await card.getByRole('radio', { name: 'Staged', exact: true }).click()
    const answerRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/userQuestions/answer')
    const answered = scaffold.whenTurnSettled()
    void answered.catch(() => {})
    await card.getByRole('button', { name: 'Submit', exact: true }).click()
    await answerRequest
    await answered
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
    await card.waitFor({ state: 'detached' })
    expect(events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'user-question-reply')).toHaveLength(1)
    const completed = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'answered.expected.md'), completed, MODE)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
