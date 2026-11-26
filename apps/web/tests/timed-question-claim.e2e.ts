/** Timed question recovery through the shipped Web runtime and real question service. */
import { responsiveBrowser } from './responsive-browser.ts'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'

import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-questions'
import {
  captureStableAria, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'
import { auditWorkflowState, compareWorkflowGolden, newWorkflowPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'
import { captureTextContrast, expectTextContrast } from './text-contrast.ts'

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
  const diagnostics: Promise<string>[] = []
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
    browser = await responsiveBrowser.launch()
    page = await newWorkflowPage(browser)
    tripwire = watchConsole(page)
    page.on('console', (message) => {
      if (message.type() === 'warning' && message.text().startsWith('[ui-user-questions] Question submission was not confirmed.')) {
        // text() renders Error args engine-dependently (Firefox collapses them to the
        // class name), so evaluate each arg for a portable diagnostic string.
        diagnostics.push(Promise.all(message.args().map(arg => arg.evaluate(value => String(value)).catch(() => ''))).then(parts => parts.join(' ')))
      }
    })
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
    // Firefox fill() inserts through the IME composition pipeline; its compositionend
    // clears the composer's composing guard one tick late, so a racing Enter keydown is
    // swallowed as a newline. The Send button resolves the same 'enter' submit mode
    // without going through the keydown IME guard.
    await page.getByRole('button', { name: 'Send message' }).click()
    await claimStarted.promise
    await settled
    await claimFailed.promise
    releaseClaim.resolve(undefined)
    const card = page.locator('[data-question-key]')
    const verifyCardWidth = async (): Promise<void> => {
      const geometry = await card.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const heading = element.querySelector('h2')
        if (heading === null) throw new Error('The answer card has no question heading')
        const range = document.createRange()
        range.selectNodeContents(heading)
        const text = [...range.getClientRects()]
        return { overflow: element.scrollWidth - element.clientWidth, scrollLeft: element.scrollLeft,
          titleOverflow: Math.max(...text.map(rect => Math.max(bounds.left - rect.left, rect.right - bounds.right))) }
      })
      expect(geometry.overflow).toBeLessThanOrEqual(1)
      expect(geometry.scrollLeft).toBe(0)
      expect(geometry.titleOverflow).toBeLessThanOrEqual(1)
    }
    await card.getByText('Work continued — you can still answer', { exact: true }).waitFor({ timeout: 15_000 })
    const pending = await captureStableAria(page, '[data-question-key]', scaffold.workspaceCwd)
    if (MODE === 'refresh') await mkdir(SNAPSHOT_DIR, { recursive: true })
    await compareWorkflowGolden(join(SNAPSHOT_DIR, 'pending.expected.md'), pending, MODE)

    await card.getByRole('radio', { name: 'Staged', exact: true }).click()
    const refusalRequested = Promise.withResolvers<undefined>()
    const releaseRefusal = Promise.withResolvers<undefined>()
    const answerPath = /\/api\/userQuestions\/answer(?:\?.*)?$/
    await page.route(answerPath, async (route) => {
      refusalRequested.resolve(undefined)
      await releaseRefusal.promise
      await route.fulfill({ status: 503, body: 'Question answer transport unavailable' })
    })
    try {
      await card.getByRole('button', { name: 'Submit', exact: true }).click()
      await refusalRequested.promise
      expect(await card.getByRole('button', { name: 'Submitting…', exact: true }).isDisabled()).toBe(true)
      await auditWorkflowState(page, 'questions', 'continued-answer-pending', card, [], undefined, verifyCardWidth)
      releaseRefusal.resolve(undefined)
      await expect.poll(() => card.getByRole('button', { name: 'Submit', exact: true }).isEnabled()).toBe(true)
      expect(await card.getByRole('radio', { name: 'Staged', exact: true }).isChecked()).toBe(true)
      expect(await card.getByRole('status').textContent()).toBe('Could not confirm submission. Your answers are saved; try again.')
      expect(diagnostics).toHaveLength(1)
      await expect(diagnostics[0]).resolves.toContain('HTTP 503')
      expect(events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'user-question-reply')).toHaveLength(0)
      await compareWorkflowGolden(join(SNAPSHOT_DIR, 'answer-refused.expected.md'),
        await captureStableAria(page, '[data-question-key]', scaffold.workspaceCwd), MODE)
      await auditWorkflowState(page, 'questions', 'continued-answer-refused-draft', card, [], undefined, async () => {
        await verifyCardWidth()
        const viewport = page.viewportSize()!
        expectTextContrast(await captureTextContrast(page, [{ label: 'submit-failure', text: card.getByRole('status') }],
          `question-submit-failure-${viewport.width}x${viewport.height}`))
      })
    } finally {
      releaseRefusal.resolve(undefined)
      await page.unrouteAll({ behavior: 'wait' })
    }
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
    await compareWorkflowGolden(join(SNAPSHOT_DIR, 'answered.expected.md'), completed, MODE)
    await auditWorkflowState(page, 'questions', 'continued-answer-retried', page.locator('[class*="centerCol"]'))
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, workflowMatrixEnabled ? 300_000 : 90_000)
})
