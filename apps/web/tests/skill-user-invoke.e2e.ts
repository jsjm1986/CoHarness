// The real Host accepts a user-only skill through ordinary prompt text,
// records its injected instructions, and serves a read-only source preview.
import { responsiveBrowser, responsiveBrowserName } from './responsive-browser.ts'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page, Route } from 'playwright'

import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import {
  assertFixtureInventory,
  captureStableAria,
  collapseTurnProcesses,
  expandTurnProcesses,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'
import { expectSkillTextReadable } from './skill-readable-text.ts'
import { auditWorkflowState, compareWorkflowGolden as compareOrRefreshGolden, newWorkflowPage as newEnglishPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/skill-user-invoke', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const PREVIEW_EXPECTED = join(SNAPSHOT_DIR, 'preview.expected.md')
const MODE = webSnapshotMode()

const SKILL_NAME = 'user-invoke-demo'
const ARGS_TEXT = 'and confirm the fixture wiring'
const REPLY = 'USER_INVOKE_REPLY acknowledged; following the injected skill.'

async function seedUserOnlySkill(workspaceCwd: string): Promise<void> {
  const directory = join(workspaceCwd, 'workspace', '.agents', 'skills', SKILL_NAME)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---',
    `name: ${SKILL_NAME}`,
    'description: Prove user-explicit invocation of a model-hidden skill',
    'disable-model-invocation: true',
    '---',
    '',
    'Reply with the fixture acknowledgement line.',
    '',
  ].join('\n'))
}

const REPLAY: ReplayOverrideDoc = [{
  kind: 'chunks',
  chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: REPLY },
    { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } },
    { type: 'usage', usage: { inputTokens: 256, outputTokens: 16 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ],
}]

describe.skipIf(MODE === 'record')('web e2e: user-explicit skill invocation through the composer', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let replayDir: string
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-skill-user-invoke-replay-'))
    const replayOverride = join(replayDir, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(REPLAY))
    scaffold = await launchWebScaffold({
      replayFixture: join(replayDir, 'override-only.jsonl'),
      replayOverride,
      // Paced replay keeps the timing-derived chrome (TTFT / tok/s) present
      // deterministically; instant playback races it in and out of the golden.
      paceMs: 10,
    })
    await seedUserOnlySkill(scaffold.workspaceCwd)
    browser = await responsiveBrowser.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (replayDir !== undefined) {
      await rm(replayDir, { recursive: true, force: true })
        .catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'skill-user-invoke e2e cleanup failed')
  })

  it('claims /name args into a gesture bubble, an injection row, and a replayed answer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skill-user-invoke'))
    const composer = page.locator('textarea:enabled').last()
    await composer.waitFor({ timeout: 15_000 })

    // The menu lists the user-only skill (its only entry point) before submission.
    await composer.fill(`/${SKILL_NAME}`)
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    await expect.poll(
      () => menu.getByRole('option', { name: new RegExp(SKILL_NAME) }).count(),
      { timeout: 10_000 },
    ).toBe(1)
    await auditWorkflowState(page, 'skill', 'explicit-invocation-menu', page.locator('[data-trigger-menu]'))

    const settled = scaffold.whenTurnSettled()
    await composer.fill(`/${SKILL_NAME} ${ARGS_TEXT}`)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()

    // The gesture stays an ordinary user bubble (decorated /name token plus
    // the trailing text), ahead of the injected context.
    const bubble = page.locator('[data-ref-chip="skill"]').first()
    await bubble.waitFor({ timeout: 15_000 })
    expect(await bubble.textContent()).toBe(`/${SKILL_NAME}`)

    // The injection started a turn; the replay adapter answers it, and the
    // settled turn folds its process rows behind one disclosure.
    await page.getByText('USER_INVOKE_REPLY', { exact: false }).first().waitFor({ timeout: 20_000 })
    await settled
    await expandTurnProcesses(page)

    // The rendered body arrives as a context-injection row named after the
    // skill; expanding it reveals the canonical <skill_content> block, and
    // the user's text is NOT folded into it.
    const injectionRow = page.getByRole('button', { name: `Context injection ${SKILL_NAME}` })
    await injectionRow.waitFor({ timeout: 15_000 })
    await injectionRow.click()
    const injectionBody = page
      .locator('[data-context-injection-body]')
      .filter({ hasText: `<skill_content name="${SKILL_NAME}">` })
    await injectionBody.waitFor({ timeout: 10_000 })
    const injected = await injectionBody.textContent()
    expect(injected).toContain('Reply with the fixture acknowledgement line.')
    expect(injected).not.toContain(ARGS_TEXT)
    await auditWorkflowState(page, 'skill', 'expanded-instructions-injection', injectionBody.locator('..'), [], undefined,
      async () => {
        await expectSkillTextReadable(page, injectionBody, 'Reply with the fixture acknowledgement line.',
          'Expanded skill instructions remain readable')
      })
    await injectionRow.click()
    // The golden is the default settled view, with the turn's process folded.
    await collapseTurnProcesses(page)

    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    await auditWorkflowState(page, 'skill', 'settled-user-invocation', page.locator('[class*="centerCol"]'))
    await bubble.click()
    const preview = page.getByRole('dialog', { name: `/${SKILL_NAME}`, exact: true })
    await preview.locator('code').waitFor({ timeout: 10_000 })
    expect(await preview.locator('code').textContent()).toBe('Reply with the fixture acknowledgement line.')
    expect(await preview.textContent()).not.toContain('<skill_content')
    const previewSnapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(PREVIEW_EXPECTED, previewSnapshot, MODE)
    const readSource = async (): Promise<void> => {
      await expectSkillTextReadable(page, preview.locator('[data-modal-content]'),
        'Reply with the fixture acknowledgement line.', 'Skill source instruction remains readable')
    }
    if (!workflowMatrixEnabled) await readSource()
    await auditWorkflowState(page, 'skill', 'source-preview', preview, [], undefined, readSource)
    await preview.getByRole('button', { name: 'Close', exact: true }).click()
    await preview.waitFor({ state: 'detached', timeout: 10_000 })
    if (workflowMatrixEnabled) {
      const original = page.viewportSize()!
      try {
        await page.setViewportSize({ width: 320, height: 568 })
        await page.bringToFront()
        if (responsiveBrowserName === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
        await page.getByRole('button', { name: 'Copy', exact: true }).last().tap()
        await page.getByRole('button', { name: 'Copied', exact: true }).waitFor()
        if (responsiveBrowserName === 'chromium') {
          expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('USER_INVOKE_REPLY')
        }
      } finally { await page.setViewportSize(original) }
      await auditSourceVariants()
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 180_000)

  async function auditSourceVariants(): Promise<void> {
    const bubble = page.locator('[data-ref-chip="skill"]').first()
    const preview = page.getByRole('dialog', { name: `/${SKILL_NAME}`, exact: true })
    const skillPath = join(scaffold.workspaceCwd, 'workspace', '.agents', 'skills', SKILL_NAME, 'SKILL.md')
    const source = await readFile(skillPath, 'utf8')
    await writeFile(skillPath, source + Array.from({ length: 40 }, (_, index) =>
      `\nInstruction ${index + 1}: preserve the complete context and check the resulting document before continuing.\n`).join(''))
    const sourceRoute = /\/api\/skill\.get(?:\?.*)?$/
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let handled: Promise<void> | undefined
    const holdSource = (route: Route): Promise<void> => {
      handled = (async () => {
        const response = await route.fetch()
        await gate
        await route.fulfill({ response })
      })()
      return handled
    }
    await page.route(sourceRoute, holdSource)
    try {
      await bubble.click()
      await preview.getByRole('status').waitFor()
      expect(handled).toBeDefined()
      await auditWorkflowState(page, 'skill', 'source-preview-loading', preview, [], undefined,
        async () => { expect(await preview.getByRole('status').isVisible()).toBe(true) })
      release()
      await preview.locator('code').waitFor()
      expect(await preview.locator('code').textContent()).toContain('Instruction 40:')
      await auditWorkflowState(page, 'skill', 'source-preview-long', preview, [], undefined, async () => {
        const content = preview.locator('[data-modal-content]')
        await expectSkillTextReadable(page, content,
          'Instruction 40: preserve the complete context and check the resulting document before continuing.',
          'Final skill source instruction remains readable')
        expect(await content.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
        const header = await preview.locator('[data-modal-header]').boundingBox()
        expect(header).not.toBeNull()
        expect(header!.y).toBeGreaterThanOrEqual(0)
        expect(header!.y + header!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
        const close = preview.getByRole('button', { name: 'Close', exact: true })
        expect(await close.evaluate((element) => {
          const box = element.getBoundingClientRect()
          const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
          return target !== null && element.contains(target)
        })).toBe(true)
      })
      await preview.getByRole('button', { name: 'Close', exact: true }).tap()
      await preview.waitFor({ state: 'detached' })
    } finally {
      release()
      await handled
      await page.unroute(sourceRoute, holdSource)
    }

    const failSource = async (route: Route): Promise<void> => {
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Skill source temporarily unavailable' })
    }
    await page.route(sourceRoute, failSource)
    try {
      await bubble.click()
      await preview.getByRole('alert').waitFor()
      await auditWorkflowState(page, 'skill', 'source-preview-failed', preview)
      await preview.getByRole('button', { name: 'Close', exact: true }).click()
      await preview.waitFor({ state: 'detached' })
    } finally {
      await page.unroute(sourceRoute, failSource)
    }
    await rm(skillPath)
    await bubble.click()
    await preview.getByText('This skill is unavailable in this session.', { exact: true }).waitFor()
    await auditWorkflowState(page, 'skill', 'source-preview-unavailable', preview)
    await preview.getByRole('button', { name: 'Close', exact: true }).click()
    await preview.waitFor({ state: 'detached' })
    expect(tripwire.pageErrors).toEqual([])
  }

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md', 'preview.expected.md'])
  })
})
