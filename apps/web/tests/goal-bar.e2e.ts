/** Assembled goal states through the real Host service, plus FixtureApiClient activation convergence. */
import { responsiveBrowser } from './responsive-browser.ts'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session'

import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expectTooltipOnTop, saveFailureShot } from './support.ts'
import { compareWorkflowGolden, auditWorkflowState, newWorkflowPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'
import { captureTextContrast, expectTextContrast } from './text-contrast.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/goal-bar', import.meta.url))
const ACTIVE_EXPECTED = join(SNAPSHOT_DIR, 'active.expected.md')
const INACTIVE_EXPECTED = join(SNAPSHOT_DIR, 'inactive.expected.md')
const OVERLAY = fileURLToPath(new URL('./goal-bar.overlay.yml', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: real Host goal mutation states', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let sessionId: SessionId
  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: [OVERLAY,
      fileURLToPath(new URL('./fixtures/goal-manual-states.patch.yml', import.meta.url))] })
    sessionId = await seedSession(scaffold,
      await readFile(fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url)), 'utf8'), 'goal-manual-states', 'standard')
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(sessionId)
    browser = await responsiveBrowser.launch()
    page = await newWorkflowPage(browser)
    await page.addInitScript(() => { localStorage.setItem('dsh.locale', 'en') })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const openSidebar = page.getByRole('button', { name: 'Open sidebar' })
    if (await openSidebar.isVisible()) await openSidebar.click()
    const workspaceItem = page.locator('[role="treeitem"]').first()
    await workspaceItem.waitFor({ timeout: 15_000 })
    const expansionDeadline = Date.now() + 5_000
    while (await workspaceItem.getAttribute('aria-expanded') !== 'true') {
      if (Date.now() >= expansionDeadline) throw new Error('Goal workspace item did not expand')
      await workspaceItem.click()
      await new Promise<undefined>(resolve => setTimeout(resolve, 50))
    }
    await page.locator(`[data-row-key^="session:"][data-row-key*="${sessionId}"]`).click()
    await page.locator(`[data-conversation-session*="${sessionId}"]`).waitFor({ timeout: 30_000 })
  }, 120_000)
  afterAll(async () => {
    try { await browser?.close() }
    finally { await scaffold?.close() }
  })

  it('keeps drafts and goals through refused mutations and restores the composer after settlement', async () => {
    await expect.poll(() => scaffold.ctx.agents.get(sessionId), { timeout: 15_000 }).toBeDefined()
    const live = () => {
      const agent = scaffold.ctx.agents.get(sessionId)
      if (agent === undefined) throw new Error('Goal Session has no live Agent')
      return agent
    }
    const objective = 'Review the deployment rollout and verify mobile controls\nPreserve the existing project data and the recovery path.'
    scaffold.ctx.goals.create(live(), { objective })
    const bar = page.locator('[data-goal-bar]')
    await bar.waitFor()
    const activationReady = Promise.withResolvers<undefined>()
    let failedMethod: 'edit' | 'pause' | 'resume' | 'clear' | undefined
    let mutationReady = Promise.withResolvers<undefined>()
    let mutationRequested = Promise.withResolvers<undefined>()
    await page.route(/\/api\/goals\/get(?:\?.*)?$/, async (route) => {
      await activationReady.promise
      await route.fallback()
    })
    await page.route(/\/api\/goals\/(?:edit|pause|resume|clear)(?:\?.*)?$/, async (route) => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1)
      if (method !== failedMethod) { await route.fallback(); return }
      mutationRequested.resolve(undefined)
      await mutationReady.promise
      const request = route.request().postDataJSON() as { rpcId: string }
      await route.fulfill({ json: { type: 'server-response', rpcId: request.rpcId,
        result: { ok: false, error: { code: 'qa/goal-refused', message: `Goal ${method} was refused for this acceptance scenario.`, details: {} } } } })
    })
    try {
      await page.reload({ waitUntil: 'load' })
      await bar.getByText('Ongoing goal', { exact: true }).waitFor()
      expect(await bar.getByRole('button', { name: 'Pause goal', exact: true }).isEnabled()).toBe(true)
      await auditWorkflowState(page, 'goal', 'activation-unconfirmed', bar)
      activationReady.resolve(undefined)

      const edit = bar.getByRole('button', { name: 'Edit goal', exact: true })
      const cancel = bar.getByRole('button', { name: 'Cancel edit', exact: true })
      const input = bar.getByRole('textbox', { name: 'Goal objective', exact: true })
      const save = bar.getByRole('button', { name: 'Save goal', exact: true })
      await edit.click()
      expect(await input.inputValue()).toBe(objective)
      await auditWorkflowState(page, 'goal', 'editing-populated-multiline', bar)
      await input.fill('   ')
      expect(await save.isDisabled()).toBe(true)
      await auditWorkflowState(page, 'goal', 'editing-empty', bar)
      await cancel.click()
      expect(scaffold.ctx.goals.get(live())?.objective).toBe(objective)
      await auditWorkflowState(page, 'goal', 'editing-cancelled', bar)
      await edit.click()
      const draft = `${objective}\nCheck the narrow landscape layout before accepting the change.`
      await input.fill(draft)

      const refuse = async (method: NonNullable<typeof failedMethod>, action: () => Promise<void>): Promise<void> => {
        failedMethod = method
        mutationReady = Promise.withResolvers<undefined>()
        mutationRequested = Promise.withResolvers<undefined>()
        await action()
        await mutationRequested.promise
        expect(await bar.getByRole('button').evaluateAll(buttons => buttons.every(button => (button as HTMLButtonElement).disabled))).toBe(true)
        await auditWorkflowState(page, 'goal', `${method}-pending`, bar)
        mutationReady.resolve(undefined)
        await expect.poll(() => bar.getByRole('alert').textContent())
          .toBe(`Goal ${method} was refused for this acceptance scenario. (qa/goal-refused)`)
        await auditWorkflowState(page, 'goal', `${method}-refused`, bar, [], undefined, async () => {
          const viewport = page.viewportSize()!
          expectTextContrast(await captureTextContrast(page, [{ label: 'mutation-failure', text: bar.getByRole('alert') }],
            `goal-${method}-failure-${viewport.width}x${viewport.height}`))
        })
        failedMethod = undefined
      }
      await refuse('edit', () => save.click())
      expect(await input.inputValue()).toBe(draft)
      expect(scaffold.ctx.goals.get(live())?.objective).toBe(objective)
      await cancel.click()
      const pause = bar.getByRole('button', { name: 'Pause goal', exact: true })
      const resume = bar.getByRole('button', { name: 'Resume goal', exact: true })
      await refuse('pause', () => pause.click())
      expect(scaffold.ctx.goals.get(live())?.phase).toBe('active')
      await pause.click()
      await bar.getByText('Paused Goal', { exact: true }).waitFor()
      await auditWorkflowState(page, 'goal', 'paused', bar)
      await refuse('resume', () => resume.click())
      expect(scaffold.ctx.goals.get(live())?.phase).toBe('paused')
      await resume.click()
      await pause.waitFor()
      await refuse('clear', () => bar.getByRole('button', { name: 'Clear goal', exact: true }).click())
      expect(scaffold.ctx.goals.get(live())?.objective).toBe(objective)

      const goal = scaffold.ctx.goals.get(live())
      if (goal === undefined) throw new Error('Refused clear removed the current goal')
      const reason = 'The deployment approval is unavailable. Review workspace permissions and retry after the release owner restores access. '.repeat(3).trim()
      scaffold.ctx.goals.block(live(), goal, { code: 'qa-approval-unavailable', message: reason })
      await bar.getByText('Blocked Goal', { exact: true }).waitFor()
      const reasonToggle = bar.locator('summary').filter({ hasText: 'View blocked reason' })
      const reasonBody = bar.locator('details > div')
      expect(await reasonBody.isVisible()).toBe(false)
      await auditWorkflowState(page, 'goal', 'blocked-reason-collapsed', bar, [reasonToggle])
      if (workflowMatrixEnabled) await reasonToggle.tap(); else await reasonToggle.click()
      await reasonBody.waitFor()
      expect(await reasonBody.textContent()).toBe(reason)
      await compareWorkflowGolden(join(SNAPSHOT_DIR, 'blocked-reason.expected.md'),
        await captureStableAria(page, '[data-goal-bar]', scaffold.workspaceCwd), MODE)
      await auditWorkflowState(page, 'goal', 'blocked-long-reason', bar, [reasonToggle], async () => {
        if (await reasonBody.isVisible()) await reasonToggle.tap()
        await reasonToggle.tap()
        expect(await reasonBody.isVisible()).toBe(true)
        expect(await reasonBody.textContent()).toBe(reason)
      })
      await reasonToggle.focus()
      await reasonToggle.press('Enter')
      expect(await reasonBody.isVisible()).toBe(false)
      await bar.getByRole('button', { name: 'Clear goal', exact: true }).click()
      await bar.waitFor({ state: 'hidden' })
      expect(scaffold.ctx.goals.get(live())).toBeUndefined()
      const composer = page.locator('[class*="centerCol"]')
      expect(await composer.locator('textarea').first().isEnabled()).toBe(true)
      await auditWorkflowState(page, 'goal', 'cleared-composer', composer)
      const complete = scaffold.ctx.goals.create(live(), { objective: 'Confirm the completed goal releases the composer' })
      await bar.waitFor()
      scaffold.ctx.goals.complete(live(), complete)
      await bar.waitFor({ state: 'hidden' })
      expect(await composer.locator('textarea').first().isEnabled()).toBe(true)
      await auditWorkflowState(page, 'goal', 'completed-composer', composer)
    } finally {
      failedMethod = undefined; activationReady.resolve(undefined); mutationReady.resolve(undefined)
      await page.unrouteAll({ behavior: 'wait' })
    }
  }, workflowMatrixEnabled ? 600_000 : 90_000)
})

describe('web e2e: goal bar clear convergence', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    browser = await responsiveBrowser.launch()
    page = await newWorkflowPage(browser)
    tripwire = watchConsole(page)
    // The tokenized entry mints the session cookie and redirects without
    // the query, so the fixture flag needs a second navigation. WebKit reports
    // boot fetches killed by that navigation as unhandled "access control
    // checks" rejections, so let them finish before leaving the first page.
    const warningsBefore = tripwire.warnings.length
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'networkidle' })
    await page.goto(`${scaffold.baseUrl}?fixture`, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // The persistent HMR EventSource, the reconnecting transport, and any
    // straggler reads still die when the first page unloads; WebKit surfaces
    // their cancellations as "access control checks" pageerrors and a
    // connection-loss retry warning — expected navigation fallout.
    acknowledgeReloadConnectionLoss(tripwire, warningsBefore)
    tripwire.pageErrors.splice(0, tripwire.pageErrors.length,
      ...tripwire.pageErrors.filter(text => !/due to access control checks/.test(text)))
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('resumes a disarmed active goal and clears it without exposing a stale error', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-goal-bar-clear'))
    // Startup opens the fixture workspace's most recent history — alpha's
    // running replay with its pending question — so ask for a blank session
    // explicitly, keeping this command independent of that replay.
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const input = page.getByPlaceholder('Describe what you want to build')
    await input.waitFor({ timeout: 10_000 })
    await input.fill('/goal guard rapid clear clicks')
    await input.press('Enter')

    const bar = page.locator('[data-goal-bar]')
    await bar.waitFor({ timeout: 10_000 })
    await bar.getByRole('button', { name: 'Pause goal', exact: true }).waitFor()
    const snapshot = await captureStableAria(page, '[data-goal-bar]', scaffold.workspaceCwd)
    await compareWorkflowGolden(ACTIVE_EXPECTED, snapshot, MODE)
    await auditWorkflowState(page, 'goal', 'active', bar)

    const pause = bar.getByRole('button', { name: 'Pause goal' })
    if (workflowMatrixEnabled) await pause.focus(); else await pause.hover()
    const pauseTooltip = page.getByRole('tooltip', { name: 'Pause goal', exact: true })
    await pauseTooltip.waitFor()
    // The strip rides directly above the input card, which paints later; the
    // bubble must escape the strip's stacking context instead of landing under it.
    await expectTooltipOnTop(pauseTooltip)

    await page.evaluate(() => {
      const timing = (globalThis as Record<string, unknown>).__fxTiming as
        | { disarmOnlyGoal(): void }
        | undefined
      if (timing === undefined) throw new Error('fixture timing controls are unavailable')
      timing.disarmOnlyGoal()
    })
    const resume = bar.getByRole('button', { name: 'Resume goal', exact: true })
    await resume.waitFor()
    const inactive = await captureStableAria(page, '[data-goal-bar]', scaffold.workspaceCwd)
    await compareWorkflowGolden(INACTIVE_EXPECTED, inactive, MODE)
    await auditWorkflowState(page, 'goal', 'disarmed', bar)
    await resume.click()
    await pause.waitFor()
    expect(await resume.count()).toBe(0)

    const clear = bar.getByRole('button', { name: 'Clear goal' })
    await clear.evaluate((button) => {
      const control = button as HTMLButtonElement
      control.click()
      control.click()
    })
    await expect.poll(() => page.locator('[data-goal-bar]').count(), { timeout: 10_000 }).toBe(0)
    expect(await page.getByText(/no current goal/iu).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['active.expected.md', 'inactive.expected.md', 'blocked-reason.expected.md'])
  })
})
