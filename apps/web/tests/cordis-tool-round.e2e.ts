/** Historical Cordis cards render without recreating dynamic Plugin execution. */
import { responsiveBrowser, responsiveBrowserName } from './responsive-browser.ts'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'

import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  assertFixtureInventory, captureStableAria, collapseTurnProcesses,
  expandTurnProcesses, launchWebScaffold, realizeSeedFixture, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { completionBarrier, saveFailureShot } from './support.ts'
import { auditWorkflowState, compareWorkflowGolden, newWorkflowPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/cordis-tool-round/', import.meta.url))
// The raw released v3 recording comes from upstream alpha.2; the Session format catalog migrates it.
const FIXTURE = fileURLToPath(new URL('./snapshots/cordis-tool-round/session.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/cordis-tool-round/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'cordis-history-web-e2e'

function toolRecords(events: readonly SessionEvent[]) {
  return events.filter(event => event.type === 'tool/call' || event.type === 'tool/result')
    .map(event => ({ type: event.type, data: event.data }))
}

describe.skipIf(MODE === 'record')('web e2e: historical Cordis cards remain readable', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let expectedEvents: SessionEvent[]

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ cordisTools: true })
    const source = await readFile(FIXTURE, 'utf8')
    expectedEvents = parseSessionLog(realizeSeedFixture(scaffold, source, SEED_ID))
    await seedSession(scaffold, source, SEED_ID, 'standard')
    browser = await responsiveBrowser.launch()
    // The seeded fixture renders dated stamps in the viewer's zone; pin the
    // zone the golden was recorded under so the literal "9/1 13:31" holds.
    page = await newWorkflowPage(browser, 1000, 'Asia/Shanghai')
    if (responsiveBrowserName === 'chromium') {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(scaffold.baseUrl).origin })
    }
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const group = page.getByRole('treeitem').first()
    await group.waitFor({ timeout: 15_000 })
    await group.click()
    const session = page.getByRole('treeitem').nth(1)
    await session.waitFor({ timeout: 10_000 })
    await session.click()
    await page.getByText('CORDIS_UI_DONE', { exact: true }).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('preserves recorded calls and results without restoring tools or runtime effects', async () => {
    const persisted = await scaffold.ctx.sessionPersistence.inspect(SessionId(SEED_ID))
    expect(toolRecords(persisted.events)).toEqual(toolRecords(expectedEvents))
    const names = scaffold.ctx.tools.schemas().map(tool => tool.name)
    for (const retired of ['cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine']) {
      expect(names).not.toContain(retired)
    }
    expect(await scaffold.ctx.dynamicCordisRunner.inventory()).toEqual([])
    expect(await page.locator('[data-snapshot-probe]').count()).toBe(0)
  })

  it('renders recorded source and lifecycle outcomes in their owned cards', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-cordis-history'))
    await expandTurnProcesses(page)
    const define = page.locator('[data-tool="cordis_define"]').first()
    await define.waitFor({ timeout: 10_000 })
    const disclosure = define.locator('[aria-expanded]').first()
    if (await disclosure.getAttribute('aria-expanded') === 'true') await disclosure.click()
    await expect.poll(() => disclosure.getAttribute('aria-expanded')).toBe('false')
    await auditWorkflowState(page, 'cordis-history', 'collapsed-definition', define)
    await disclosure.click()
    await define.getByRole('tab', { name: 'Host' }).click()
    await expect.poll(() => define.textContent()).toContain('snapshot-noop')
    await auditWorkflowState(page, 'cordis-history', 'host-source', define)
    await define.getByRole('button', { name: 'Copy', exact: true }).click()
    await define.getByRole('button', { name: 'Copied', exact: true }).waitFor()
    await define.getByRole('button', { name: 'Copy', exact: true }).waitFor()
    await define.getByRole('tab', { name: 'Client' }).click()
    await expect.poll(() => define.textContent()).toContain('data-snapshot-probe')
    await auditWorkflowState(page, 'cordis-history', 'client-source', define)
    await define.getByRole('button', { name: 'Copy', exact: true }).click()
    await define.getByRole('button', { name: 'Copied', exact: true }).waitFor()
    const run = page.locator('[data-tool="cordis_run"]').first()
    await expect.poll(() => run.getAttribute('data-cordis-status')).toBe('idle')
    await auditWorkflowState(page, 'cordis-history', 'historical-run-idle', run)
    const stop = page.locator('[data-tool="cordis_stop"]').first()
    await expect.poll(() => stop.getAttribute('data-state')).toBe('ok')
    await auditWorkflowState(page, 'cordis-history', 'stopped', stop)
    expect(await page.locator('[data-snapshot-probe]').count()).toBe(0)
    expect(await scaffold.ctx.dynamicCordisRunner.inventory()).toEqual([])
    expect(toolRecords((await scaffold.ctx.sessionPersistence.inspect(SessionId(SEED_ID))).events)).toEqual(toolRecords(expectedEvents))
    await collapseTurnProcesses(page)
  }, workflowMatrixEnabled ? 180_000 : 30_000)

  it('switches historical source tabs from the keyboard without activating the recorded package', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-cordis-history-keyboard'))
    await expandTurnProcesses(page)
    try {
      const define = page.locator('[data-tool="cordis_define"]').first()
      const disclosure = define.locator('[aria-expanded]').first()
      if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click()
      const host = define.getByRole('tab', { name: 'Host', exact: true })
      const client = define.getByRole('tab', { name: 'Client', exact: true })
      await host.click()
      await host.focus()
      await host.press('ArrowLeft')
      await expect.poll(() => client.getAttribute('aria-selected')).toBe('true')
      expect(await client.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await client.getAttribute('tabindex')).toBe('0')
      expect(await host.getAttribute('tabindex')).toBe('-1')
      await client.press('End')
      await expect.poll(() => host.getAttribute('aria-selected')).toBe('true')
      expect(await host.evaluate(element => element === document.activeElement)).toBe(true)
      await host.press('Home')
      await expect.poll(() => client.getAttribute('aria-selected')).toBe('true')
      expect(await client.evaluate(element => element === document.activeElement)).toBe(true)
      await client.press('ArrowRight')
      await expect.poll(() => host.getAttribute('aria-selected')).toBe('true')
      expect(await host.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await host.getAttribute('tabindex')).toBe('0')
      expect(await client.getAttribute('tabindex')).toBe('-1')
      const panel = define.getByRole('tabpanel', { name: 'Host', exact: true })
      expect(await host.getAttribute('aria-controls')).toBe(await panel.getAttribute('id'))
      expect(await panel.getAttribute('aria-labelledby')).toBe(await host.getAttribute('id'))
      expect(await scaffold.ctx.dynamicCordisRunner.inventory()).toEqual([])
      expect(await page.locator('[data-snapshot-probe]').count()).toBe(0)
      expect(tripwire.pageErrors).toEqual([])
    } finally { await collapseTurnProcesses(page) }
  })

  it('matches the historical conversation aria golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-cordis-history-aria'))
    await page.locator('[data-conversation-scroll]').evaluate((host) => { host.scrollTop = host.scrollHeight })
    await page.mouse.move(0, 0)
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareWorkflowGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl', 'ui.expected.md'])
  })
})

it.skipIf(MODE === 'record')('opens the Cordis footer inventory and controls its actual Host-owned packages', async () => {
  const releaseRead = completionBarrier()
  const owned: { world?: WebScaffold; browser?: Browser; page?: Page } = {}
  onTestFinished(async () => {
    releaseRead.resolve()
    try { await owned.page?.unrouteAll({ behavior: 'wait' }) } finally {
      try { await owned.browser?.close() } finally { await owned.world?.close() }
    }
  })
  const world = await launchWebScaffold({ cordisTools: true })
  owned.world = world
  const session = await seedSession(world, await readFile(FIXTURE, 'utf8'), 'cordis-panel-owner')
  await (await world.ctx.workspaceRegistry.create(world.workspaceCwd)).attachSession(session)
  await world.ctx.agents.resume({ resumeSessionId: session, setup: ctx => world.ctx.agentPresets.mount(ctx).then(() => undefined) })
  const runner = world.ctx.dynamicCordisRunner
  // The current Host service owns these definitions; no retired model tool or recorded call is executed.
  const first = runner.define({ sessionId: session, plugin: { kind: 'new', idPrefix: 'audit' },
    name: 'Inventory package with a long descriptive name for narrow sidebar layouts',
    purpose: 'Keep the selected package and its lifecycle actions readable when this footer panel is narrower than its explanatory text.',
    code: { host: 'return { name: "inventory-first", apply() {} }' } })
  const second = runner.define({ sessionId: session, plugin: { kind: 'existing', pluginId: first.pluginId },
    name: 'Second immutable package with another long name', purpose: 'Select an older version without starting it.',
    code: { host: 'return { name: "inventory-second", apply() {} }' } })
  const browser = await responsiveBrowser.launch()
  owned.browser = browser
  const page = await newWorkflowPage(browser)
  owned.page = page
  const tripwire = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'cordis-footer-inventory'))
  let readMode: 'held' | 'failed' | 'live' = 'held'
  let reads = 0
  const readError = 'Private fixture inventory unavailable at /workspace/LongInventoryLocationWithoutWhitespace0123456789'
  await page.route(url => url.origin === new URL(world.baseUrl).origin && url.pathname === '/api/dynamicCordisRunner/inventory', async (route) => {
    reads++
    if (readMode === 'held') await releaseRead.promise
    if (readMode === 'failed') {
      const request = route.request().postDataJSON() as { rpcId: string }
      await route.fulfill({ json: { type: 'server-response', rpcId: request.rpcId,
        result: { ok: false, error: { code: 'fixture/inventory-unavailable', message: readError, details: {} } } } })
    } else await route.continue()
  })
  const activate = async (control: Locator): Promise<void> => {
    if (workflowMatrixEnabled) await control.tap()
    else await control.click()
  }
  const showSidebar = async (): Promise<void> => {
    const open = page.getByRole('button', { name: 'Open sidebar', exact: true })
    if (await open.isVisible()) await activate(open)
  }
  const badge = page.getByRole('button', { name: 'Cordis plugins', exact: true })
  const panel = page.locator('[data-cordis-panel]')
  const reveal = async (): Promise<void> => {
    await showSidebar()
    if (await badge.getAttribute('aria-expanded') !== 'true') await activate(badge)
    await panel.waitFor()
  }
  const audit = (state: string, controls: readonly Locator[] = []): Promise<void> =>
    auditWorkflowState(page, 'cordis-inventory', state, panel, controls, reveal)
  await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
  await expect.poll(() => reads, { timeout: 15_000 }).toBeGreaterThan(0)
  await showSidebar()
  expect(await badge.count()).toBe(0)
  expect(await page.getByText('No plugins defined yet', { exact: true }).count()).toBe(0)
  await auditWorkflowState(page, 'cordis-inventory', 'initial-read-hides-empty-badge', page.locator('[data-sidebar-root]'), [], showSidebar)
  readMode = 'failed'
  releaseRead.resolve()
  await badge.waitFor()
  await reveal()
  await panel.getByRole('alert').filter({ hasText: readError }).waitFor()
  await audit('read-failed-long-reason', [panel.getByRole('button', { name: 'Retry', exact: true })])
  const previousReads = reads
  readMode = 'live'
  await activate(panel.getByRole('button', { name: 'Retry', exact: true }))
  await expect.poll(() => reads).toBeGreaterThan(previousReads)
  const row = panel.locator(`[data-cordis-row="${first.pluginId}"]`)
  await row.waitFor()
  await expect.poll(() => panel.getByRole('alert').count()).toBe(0)
  await audit('idle-two-versions', [row.getByRole('combobox', { name: 'Version', exact: true })])
  await row.getByRole('combobox', { name: 'Version', exact: true }).selectOption(first.packageId)
  await row.getByText(first.name, { exact: true }).waitFor()
  await audit('selected-old-package', [row.getByRole('button', { name: 'Run', exact: true })])
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden' })
  expect(await badge.evaluate(element => element === document.activeElement)).toBe(true)
  await reveal()
  expect(await row.getByRole('combobox', { name: 'Version', exact: true }).inputValue()).toBe(first.packageId)
  await activate(row.getByRole('button', { name: 'Run', exact: true }))
  await expect.poll(async () => (await runner.inventory())[0]?.activeRun?.packageId).toBe(first.packageId)
  await expect.poll(() => row.getAttribute('data-cordis-status')).toBe('running')
  await audit('running-host-package', [row.getByRole('button', { name: 'Stop', exact: true })])
  await activate(row.getByRole('button', { name: 'Stop', exact: true }))
  await expect.poll(async () => (await runner.inventory())[0]?.activeRun).toBeUndefined()
  await expect.poll(() => row.getAttribute('data-cordis-status')).toBe('idle')
  await audit('stopped-retains-versions')
  const failure = 'Inventory activation failed for the deliberately failing private Host package'
  const broken = runner.define({ sessionId: session, plugin: { kind: 'existing', pluginId: first.pluginId },
    name: 'Deliberately failing package', purpose: 'Keep the failure visible while another retained version remains available.',
    code: { host: `throw new Error(${JSON.stringify(failure)})` } })
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden' })
  await reveal()
  await expect.poll(() => row.locator('option').count()).toBe(3)
  await row.getByRole('combobox', { name: 'Version', exact: true }).selectOption(broken.packageId)
  await activate(row.getByRole('button', { name: 'Run', exact: true }))
  await row.getByRole('alert').filter({ hasText: failure }).waitFor()
  await audit('activation-failed', [row.getByRole('combobox', { name: 'Version', exact: true })])
  await row.getByRole('combobox', { name: 'Version', exact: true }).selectOption(second.packageId)
  await activate(row.getByRole('button', { name: 'Run', exact: true }))
  await expect.poll(async () => (await runner.inventory())[0]?.activeRun?.packageId).toBe(second.packageId)
  await expect.poll(() => row.getAttribute('data-cordis-status')).toBe('running')
  await expect.poll(() => row.getByRole('alert').count()).toBe(0)
  await audit('recovered-with-retained-version')
  await activate(row.getByRole('button', { name: 'Remove', exact: true }))
  await expect.poll(() => runner.inventory()).toEqual([])
  await panel.getByText('No plugins defined yet', { exact: true }).waitFor()
  await audit('empty-after-removal')
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden' })
  await expect.poll(() => badge.count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
}, workflowMatrixEnabled ? 360_000 : 120_000)
