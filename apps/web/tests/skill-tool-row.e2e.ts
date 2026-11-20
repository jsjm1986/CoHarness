// Web e2e scenario: the real skill-load recording, seeded cold through the
// persistence seam, renders through ui-skill's keyed toolview without a model
// call. The disclosure proves replay-stable naming and exact durable output.
import { responsiveBrowser, responsiveBrowserName } from './responsive-browser.ts'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-workspace'

import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, expandTurnProcesses, fixtureUserPrompts,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, saveFailureShot } from './support.ts'
import { auditWorkflowState, compareWorkflowGolden as compareOrRefreshGolden, newWorkflowPage as newEnglishPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'
import { captureTextContrast, expectTextContrast } from './text-contrast.ts'
import { expectSkillTextReadable } from './skill-readable-text.ts'

const FIXTURE = fileURLToPath(new URL('../../../examples/acp-agent/tests/snapshots/skill-load/session.v7.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/skill-tool-row', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/skill-tool-row/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'skill-tool-row-web-e2e'
const PROMPT = 'Load the editing-cordis-compositions skill with the skill tool, then reply DONE.'

describe.skipIf(MODE === 'record')('web e2e: dedicated Skill tool row', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const fixture = await readFile(FIXTURE, 'utf8')
    expect(fixtureUserPrompts(fixture)).toEqual([PROMPT])
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, fixture, SEED_ID)
    browser = await responsiveBrowser.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expandTurnProcesses(page)
    await page.locator('[data-tool="skill"]').waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('expands the loaded skill to its exact recorded instructions', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skill-tool-row'))
    const call = page.locator('[data-tool="skill"]')
    const row = call.getByRole('button', { name: 'Skill editing-cordis-compositions' })
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('false')
    expect(await call.getByText('editing-cordis-compositions', { exact: true }).count()).toBe(1)
    await auditWorkflowState(page, 'skill', 'loaded-tool-collapsed', call)

    await row.click()
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true')
    await call.getByText('Instructions', { exact: true }).waitFor()
    const output = call.locator('pre')
    await output.waitFor()
    expect(await output.textContent()).toContain('<skill_content name="editing-cordis-compositions">')
    expect(await output.textContent()).toContain('a preset is exactly as privileged as the plugins it names')
    expect(await output.evaluate(element => getComputedStyle(element.parentElement!).maxHeight)).toBe('260px')

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .replace(/(?:\b\d{1,2}\/\d{1,2} )?\{\{clock\}\}/g, '{{date}} {{clock}}')
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    const readInstructions = async (): Promise<void> => {
      await expectSkillTextReadable(page, output, '</skill_instructions>\n</skill_content>', 'Recorded skill final lines')
      expect(await output.evaluate(element => element.scrollTop), 'Final lines require internal scrolling').toBeGreaterThan(0)
      const directory = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
      if (directory !== undefined) {
        await mkdir(directory, { recursive: true })
        const viewport = page.viewportSize()!
        await page.screenshot({ path: join(directory,
          `${responsiveBrowserName}-skill-loaded-tool-final-${viewport.width}x${viewport.height}.png`), animations: 'disabled' })
      }
      await expectSkillTextReadable(page, output, 'a preset is exactly as privileged as the plugins it names',
        'Recorded skill instruction body')
      expect(await output.evaluate(element => element.scrollTop), 'Instruction body requires internal scrolling').toBeGreaterThan(0)
    }
    if (!workflowMatrixEnabled) await readInstructions()
    await auditWorkflowState(page, 'skill', 'loaded-tool-expanded', call, [], undefined, readInstructions)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})

const OUTCOMES = [
  { id: 'skill-failed', state: 'error', error: { name: 'SkillError', code: 'missing' },
    text: 'The skill could not be loaded.\nCheck that its resource is available, then try again.', status: 'Skill load failed' },
  { id: 'skill-stopped', state: 'stopped', error: { name: 'InterruptedError', code: 'interrupted' },
    text: 'Skill loading was stopped before instructions were returned.', status: 'Skill load stopped' },
] as const

/** Closed synthetic history exercises the shipped renderer without executing a skill. */
function outcomeFixture(): string {
  const session = Session.create(SessionId('skill-outcome-source'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Read the recorded skill outcomes.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    content: OUTCOMES.map(item => ({ type: 'tool-call', id: ToolCallId(item.id), name: 'skill',
      arguments: JSON.stringify({ name: 'review-complete-workspace-and-linked-documents' }) })),
    source: { provider: 'fixture', model: 'fixture' },
  }) }, { surfaceOp: 'append' })
  for (const item of OUTCOMES) {
    const callId = ToolCallId(item.id)
    const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'skill',
      arguments: JSON.stringify({ name: 'review-complete-workspace-and-linked-documents' }) })
    session.append('tool/result', { turn: 1, step: 1, error: item.error,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: item.text }], isError: true }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  }
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}',
    createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }),
  ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

describe.skipIf(!workflowMatrixEnabled)('web e2e: recorded Skill failure and interruption', () => {
  let scaffold: WebScaffold, browser: Browser, page: Page
  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const session = await seedSession(scaffold, outcomeFixture(), 'skill-outcome-history')
    await (await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)).attachSession(session)
    browser = await responsiveBrowser.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  }, 120_000)
  afterAll(async () => { try { await browser?.close() } finally { await scaffold?.close() } })
  it.each(OUTCOMES)('$state retains its full recorded explanation', async (item) => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-${item.id}`))
    const card = page.locator(`[data-chat-call-id="${item.id}"]`)
    await expandOwningTurnProcess(page, card)
    await card.locator(`[data-tool="skill"][data-state="${item.state}"]`).waitFor()
    expect(await card.getByText(item.status, { exact: true }).count()).toBe(1)
    const row = card.locator('[data-expandable]')
    await auditWorkflowState(page, 'skill', `${item.state}-tool-collapsed`, card)
    if (item.state === 'error') expectTextContrast(await captureTextContrast(page,
      [{ label: 'summary', text: row.getByText(item.text.split('\n')[0]!, { exact: true }) }], 'skill-error-summary'))
    await row.click()
    await card.locator('pre').waitFor()
    expect(await card.locator('pre').textContent()).toBe(item.text)
    await auditWorkflowState(page, 'skill', `${item.state}-tool-expanded`, card)
    expectTextContrast(await captureTextContrast(page,
      [{ label: 'instructions', text: card.locator('pre') }], `skill-${item.state}-instructions`))
    await row.click()
  }, 90_000)
})
