/** Task-manager environment and timing states through real Web Hosts. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { launchPersonalComputersFixture, personalTargets } from './personal-computers-fixture.ts'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, webSnapshotMode } from './scaffold.ts'
import { responsiveBrowser } from './responsive-browser.ts'
import { auditWorkflowState, newWorkflowPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'
import { connectFreshWorkspace, expandOwningTurnProcess, saveFailureDom, saveFailureShot } from './support.ts'

const BUNDLE = fileURLToPath(new URL('../../../packages/experimental/schedule-bundle/cordis.patch.yml', import.meta.url))

async function openManager(page: Page): Promise<void> {
  const sidebar = page.getByRole('button', { name: 'Open sidebar', exact: true })
  if (await sidebar.isVisible()) await sidebar.click()
  await page.getByRole('button', { name: 'Automation tasks', exact: true }).click()
  await page.getByTestId('task-manager-page').waitFor({ timeout: 60_000 })
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: Schedule environment and timing states', () => {
  it('keeps the selected computer through creation refusal and directory availability changes', async () => {
    const fixture = await launchPersonalComputersFixture({ extraOverlayPath: BUNDLE })
    let browser: Browser | undefined
    let routedPage: Page | undefined
    const requested = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const creationTargets: (string | null)[] = []
    let refuseCreation = true
    try {
      browser = await responsiveBrowser.launch()
      const page = routedPage = await newWorkflowPage(browser)
      await page.addInitScript(() => { localStorage.setItem('dsh.locale', 'en') })
      await page.goto(fixture.url, { waitUntil: 'networkidle' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await openManager(page)
      await page.route(/\/api\/prepare\/v1\/session\.create(?:\?.*)?$/, async (route) => {
        creationTargets.push(new URL(route.request().url()).searchParams.get('dshRuntime'))
        if (!refuseCreation) { await route.fallback(); return }
        requested.resolve(undefined)
        await release.promise
        await route.fulfill({ status: 503, body: 'Conversation creation is temporarily unavailable' })
      })
      const manager = page.getByTestId('task-manager-page')
      const choose = manager.getByRole('button', { name: 'Choose task environment', exact: true })
      await choose.click()
      const menu = page.getByRole('menu')
      await menu.getByRole('menuitem', { name: 'Compute computer', exact: true }).waitFor()
      await auditWorkflowState(page, 'schedule', 'environment-chooser', menu)
      await menu.getByRole('searchbox').fill('No computer or Runtime has this name')
      expect(await menu.getByRole('menuitem', { name: 'No matching environments', exact: true }).isDisabled()).toBe(true)
      await auditWorkflowState(page, 'schedule', 'environment-search-empty', menu)
      await menu.getByRole('searchbox').fill('Compute')
      await menu.getByRole('menuitem', { name: 'Compute computer', exact: true }).click()
      await expect.poll(() => choose.textContent()).toContain('Compute computer')
      fixture.setRuntimeAvailable(1, false)
      await choose.click()
      await menu.getByRole('menuitem', { name: 'Refresh environments', exact: true }).click()
      const unavailable = manager.getByRole('status').filter({ hasText: 'This environment is currently unavailable.' })
      await unavailable.waitFor()
      expect(await manager.getByRole('button', { name: 'New', exact: true }).isDisabled()).toBe(true)
      // The refresh footer keeps the chooser open by design; the audited state is
      // the unavailable notice behind it, so dismiss the menu before measuring.
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden' })
      await auditWorkflowState(page, 'schedule', 'environment-unavailable', manager)
      fixture.setRuntimeAvailable(1, true)
      await unavailable.getByRole('button', { name: 'Retry', exact: true }).click()
      await unavailable.waitFor({ state: 'hidden' })
      expect(await choose.textContent()).toContain('Compute computer')
      await auditWorkflowState(page, 'schedule', 'environment-recovered', manager, [], undefined, async () => {
        if (page.viewportSize()!.width < 768) {
          await expect.poll(() => page.locator('[data-mobile-page-title]').textContent()).toBe('Automation tasks')
        }
      })
      await manager.getByRole('button', { name: 'New', exact: true }).click()
      await requested.promise
      await manager.waitFor({ state: 'hidden' })
      const intent = page.locator('[data-conversation-intent]')
      await intent.locator('[data-intent-phase="preparing"]').waitFor()
      expect(await intent.getAttribute('data-intent-runtime')).toBe(personalTargets[1]!.runtimeId)
      await intent.getByRole('textbox').fill('Keep this task draft on Compute')
      await intent.getByRole('textbox').blur()
      await auditWorkflowState(page, 'schedule', 'new-task-pending', intent)
      const pending = await captureStableAria(page, '[data-conversation-intent]', fixture.worlds[1]!.workspaceCwd)
      release.resolve(undefined)
      await intent.locator('[data-intent-phase="unavailable"]').waitFor()
      expect(await intent.getByRole('textbox').inputValue()).toBe('Keep this task draft on Compute')
      await auditWorkflowState(page, 'schedule', 'new-task-refused', intent)
      const refused = await captureStableAria(page, '[data-conversation-intent]', fixture.worlds[1]!.workspaceCwd)
      refuseCreation = false
      await intent.getByRole('button', { name: 'Retry', exact: true }).click()
      await intent.waitFor({ state: 'hidden' })
      const composer = page.locator('[data-composer-card] textarea:enabled')
      await composer.waitFor()
      expect(await composer.inputValue()).toBe('Keep this task draft on Compute')
      expect(creationTargets).toEqual([personalTargets[1]!.runtimeId, personalTargets[1]!.runtimeId])
      await compareOrRefreshGolden(fileURLToPath(new URL('./snapshots/schedule-management/environment-creation.expected.md', import.meta.url)),
        `## Preparing on Compute\n${pending}\n\n## Refused creation\n${refused}\n\nRetry prepares the same Compute Runtime and preserves the draft.`, webSnapshotMode())
    } catch (error) {
      if (routedPage !== undefined) {
        await saveFailureShot(routedPage, 'schedule-management-environment')
        await saveFailureDom(routedPage, 'schedule-management-environment')
      }
      throw error
    } finally {
      release.resolve(undefined)
      try { await routedPage?.unrouteAll({ behavior: 'wait' }); await browser?.close() }
      finally { await fixture.close() }
    }
  }, workflowMatrixEnabled ? 360_000 : 120_000)

  it('stages every timing mode and keeps invalid changes out of the Host', async () => {
    const world = await launchWebScaffold({ extraOverlayPath: BUNDLE })
    let browser: Browser | undefined
    try {
      browser = await responsiveBrowser.launch()
      const page = await newWorkflowPage(browser)
      const session = await seedSession(world, await readFile(fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url)), 'utf8'), 'schedule-timing-modes')
      const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
      await workspace.attachSession(session)
      const task = await world.ctx.schedule.create(session, { title: 'Review all timing choices', prompt: 'Review the release window', at: '2099-08-25T12:08:00.000Z' })
      await page.addInitScript(() => { localStorage.setItem('dsh.locale', 'en') })
      await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      // The seeded Session is restored once the Workspace list resolves; an
      // earlier-opened Task manager unmounts under that navigation.
      await page.locator('textarea:enabled').first().waitFor()
      await openManager(page)
      const manager = page.getByTestId('task-manager-page')
      await manager.getByRole('button', { name: task.title, exact: true }).click()
      const detail = manager.getByRole('complementary', { name: 'Task details' })
      const runTime = detail.getByRole('region', { name: 'Run time', exact: true })
      const repeat = runTime.getByRole('button', { name: /^Repeat / })
      const save = detail.getByRole('button', { name: 'Save changes', exact: true })
      const original = (await world.ctx.schedule.catalog()).find(item => item.id === task.id)
      await auditWorkflowState(page, 'schedule', 'timing-once', detail)
      await repeat.click()
      await auditWorkflowState(page, 'schedule', 'repeat-menu', page.getByRole('menu'))
      await page.keyboard.press('Escape')
      for (const [label, state] of [
        ['Every N seconds', 'interval-seconds'], ['Every N minutes', 'interval-minutes'],
        ['Every N hours', 'interval-hours'], ['Every day', 'daily'],
        ['Monday to Friday', 'weekdays'], ['Weekly', 'weekly'], ['Custom', 'custom'],
      ] as const) {
        await repeat.click()
        await page.getByRole('menuitem', { name: label, exact: true }).click()
        await auditWorkflowState(page, 'schedule', `timing-${state}`, detail)
        expect((await world.ctx.schedule.catalog()).find(item => item.id === task.id)).toEqual(original)
      }
      const frequency = runTime.getByRole('button', { name: /^Frequency / })
      for (const label of ['Monthly', 'Weekly', 'Every day', 'Every N hours', 'Every N minutes', 'Cron expression']) {
        await frequency.click()
        await page.getByRole('menuitem', { name: label, exact: true }).click()
        await auditWorkflowState(page, 'schedule', `cron-${label.toLowerCase().replaceAll(' ', '-')}`, detail)
      }
      const expression = runTime.getByRole('textbox', { name: 'Cron expression', exact: true })
      await expression.fill('invalid cron')
      // The draft is refused locally on Save: the field's hint turns into the
      // alert and nothing reaches the Host (same contract as the unit spec).
      await save.click()
      await detail.getByRole('alert').filter({ hasText: 'five-field cron expression' }).waitFor()
      expect((await world.ctx.schedule.catalog()).find(item => item.id === task.id)).toEqual(original)
      await auditWorkflowState(page, 'schedule', 'cron-invalid', detail)
      await repeat.click()
      await page.getByRole('menuitem', { name: 'Every N seconds', exact: true }).click()
      const interval = runTime.getByRole('spinbutton', { name: 'Repeat every', exact: true })
      await interval.fill('0')
      await save.click()
      await detail.getByRole('alert').filter({ hasText: 'at least 60 seconds' }).waitFor()
      expect((await world.ctx.schedule.catalog()).find(item => item.id === task.id)).toEqual(original)
      await auditWorkflowState(page, 'schedule', 'interval-invalid', detail)
      await interval.fill('60')
      await runTime.getByRole('button', { name: 'Increase interval', exact: true }).click()
      expect(await interval.inputValue()).toBe('61')
      await save.click()
      await expect.poll(async () => (await world.ctx.schedule.catalog()).find(item => item.id === task.id)).toMatchObject({ kind: 'every', everySeconds: 61 })
      await auditWorkflowState(page, 'schedule', 'interval-saved', detail)
    } finally {
      try { await browser?.close() }
      finally { await world.close() }
    }
  }, workflowMatrixEnabled ? 600_000 : 120_000)

  it.each(['loading', 'unavailable'] as const)('keeps the task readable while the original Session is %s', async (state) => {
    const world = await launchWebScaffold({ extraOverlayPath: BUNDLE })
    let browser: Browser | undefined
    let routedPage: Page | undefined
    const release = Promise.withResolvers<undefined>()
    let recovered = false
    try {
      browser = await responsiveBrowser.launch()
      const page = routedPage = await newWorkflowPage(browser)
      const session = await seedSession(world, await readFile(fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url)), 'utf8'), `schedule-linked-session-${state}`)
      const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
      await workspace.attachSession(session)
      const task = await world.ctx.schedule.create(session, { title: 'Retain this task while the Session list is unavailable', prompt: 'Check the saved task independently of Session navigation', at: '2099-08-25T12:08:00.000Z' })
      await page.route(/\/api\/workspace\.list(?:\?.*)?$/, async (route) => {
        if (!recovered && state === 'loading') await release.promise
        if (recovered) await route.fallback()
        else await route.fulfill({ status: 503, body: 'Workspace information is temporarily unavailable' })
      })
      await page.addInitScript(() => { localStorage.setItem('dsh.locale', 'en') })
      await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await openManager(page)
      const manager = page.getByTestId('task-manager-page')
      await manager.getByRole('button', { name: task.title, exact: true }).click()
      const detail = manager.getByRole('complementary', { name: 'Task details' })
      const linked = detail.getByRole('button', { name: /^Linked session/ })
      await detail.getByText(state === 'loading' ? 'Loading original session information.' : 'The original session is unavailable.', { exact: true }).waitFor()
      expect(await linked.isDisabled()).toBe(true)
      expect(await detail.getByRole('textbox', { name: 'Automation task instruction', exact: true }).inputValue()).toBe(task.prompt)
      await auditWorkflowState(page, 'schedule', `linked-session-${state}`, detail)
      recovered = true; release.resolve(undefined)
      if (state === 'unavailable') await page.reload({ waitUntil: 'load' })
      // The resolved Workspace list completes the deferred boot restore: the
      // app selects the seeded Session and the Task manager unmounts. Wait for
      // the session view before re-opening the manager.
      await page.locator('textarea:enabled').first().waitFor()
      await openManager(page)
      await manager.getByRole('button', { name: task.title, exact: true }).click()
      await expect.poll(() => linked.isEnabled()).toBe(true)
      expect((await world.ctx.schedule.catalog()).find(item => item.id === task.id)?.prompt).toBe(task.prompt)
      await auditWorkflowState(page, 'schedule', `linked-session-${state}-recovered`, detail)
    } catch (error) {
      if (routedPage !== undefined) {
        await saveFailureShot(routedPage, `schedule-management-linked-${state}`)
        await saveFailureDom(routedPage, `schedule-management-linked-${state}`)
      }
      throw error
    } finally {
      recovered = true; release.resolve(undefined)
      try { await routedPage?.unrouteAll({ behavior: 'wait' }); await browser?.close() }
      finally { await world.close() }
    }
  }, workflowMatrixEnabled ? 300_000 : 120_000)

  it('exposes a real pending schedule call, its result and a refused tool call', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-schedule-tool-states-'))
    const callId = ToolCallId('schedule-tool-visible-pending')
    const badId = ToolCallId('schedule-tool-visible-error')
    const calls = [
      { type: 'tool-call' as const, id: callId, name: 'schedule_create', arguments: JSON.stringify({ title: 'Read the long release checklist', prompt: 'Confirm release readiness and recovery instructions. '.repeat(16), every_seconds: 3600 }) },
      { type: 'tool-call' as const, id: badId, name: 'schedule_create', arguments: JSON.stringify({ title: 'Invalid reminder', prompt: 'This rejected reminder must not create a task', every_seconds: -1 }) },
    ]
    const chunks: StreamChunk[] = calls.flatMap((call, index): StreamChunk[] => [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments },
      { type: 'block-end', index, block: call },
    ])
    chunks.push({ type: 'finish', reason: { kind: 'tool-calls' } })
    const script: ReplayOverrideDoc = [
      { kind: 'chunks', chunks },
      { kind: 'chunks', chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'Schedule inspection complete.' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'Schedule inspection complete.' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ] },
    ]
    const override = join(temporary, 'replay.override.json')
    await writeFile(override, JSON.stringify(script))
    const world = await launchWebScaffold({ extraOverlayPath: BUNDLE,
      replayFixture: join(temporary, 'override-only.jsonl'), replayOverride: override })
    let browser: Browser | undefined
    const release = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const stop = world.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.callId !== callId) return next()
      entered.resolve(undefined)
      const cancelled = Promise.withResolvers<undefined>()
      const abort = () => { cancelled.reject(exec.signal.reason) }
      exec.signal.addEventListener('abort', abort, { once: true })
      try {
        exec.signal.throwIfAborted()
        await Promise.race([release.promise, cancelled.promise])
        exec.signal.throwIfAborted()
        return await next()
      } finally { exec.signal.removeEventListener('abort', abort) }
    })
    try {
      browser = await responsiveBrowser.launch()
      const page = await newWorkflowPage(browser)
      await page.addInitScript(() => { localStorage.setItem('dsh.locale', 'en') })
      await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspace(page, world.workspaceCwd)
      const settled = world.whenTurnSettled()
      void settled.catch(() => {})
      await page.locator('textarea').first().fill('Create the valid reminder and report the invalid interval.')
      // Firefox fill() inserts through the IME composition pipeline; its compositionend
      // clears the composer's composing guard one tick late, so a racing Enter keydown is
      // swallowed as a newline. The Send button resolves the same 'enter' submit mode
      // without going through the keydown IME guard.
      await page.getByRole('button', { name: 'Send message' }).click()
      await entered.promise
      const pending = page.locator(`[data-chat-call-id="${callId}"]`)
      await expandOwningTurnProcess(page, pending)
      await pending.locator('[data-tool="schedule_create"][data-state="running"]').waitFor()
      await auditWorkflowState(page, 'schedule', 'tool-call-pending', pending)
      release.resolve(undefined)
      await settled
      for (const [id, state] of [[callId, 'result'], [badId, 'error']] as const) {
        const card = page.locator(`[data-chat-call-id="${id}"]`)
        await expandOwningTurnProcess(page, card)
        const disclosure = card.locator('[data-disclosure-row][role="button"]').first()
        if (await disclosure.getAttribute('aria-expanded') === 'true') await disclosure.click()
        await auditWorkflowState(page, 'schedule', `tool-${state}-collapsed`, card)
        if (workflowMatrixEnabled) await disclosure.tap(); else await disclosure.click()
        expect(await disclosure.getAttribute('aria-expanded')).toBe('true')
        // The refused call returns its error as a normal result payload, so
        // the row state stays 'ok' and the refusal reads from the expanded
        // body's raw output.
        if (state === 'error') await card.getByText(/frequency_too_high/).waitFor()
        await auditWorkflowState(page, 'schedule', `tool-${state}-expanded`, card)
        await disclosure.focus()
        await disclosure.press('Enter')
        expect(await disclosure.getAttribute('aria-expanded')).toBe('false')
      }
      expect(await world.ctx.schedule.catalog()).toHaveLength(1)
      await page.getByRole('button', { name: 'Open task details: Read the long release checklist', exact: true }).click()
      await auditWorkflowState(page, 'schedule', 'tool-created-task-detail', page.getByRole('complementary', { name: 'Task details' }))
    } finally {
      release.resolve(undefined); stop()
      try { await browser?.close() }
      finally { try { await world.close() } finally { await rm(temporary, { recursive: true, force: true }) } }
    }
  }, workflowMatrixEnabled ? 420_000 : 120_000)
})
