// Real Web composition and transport, with recorded LLM streams for keyless
// concurrency/approval coverage. Workspaces and Sessions are created through
// their production actions; the workbench receives no fixture-only UI state.
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page, Locator } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  captureStableAria, compareOrRefreshGolden,
  fixtureUserPrompts, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const APPROVAL = fileURLToPath(new URL('./snapshots/approval-composer/session.jsonl', import.meta.url))
const REPLY = fileURLToPath(new URL('./snapshots/live-interactions/session.jsonl', import.meta.url))
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const SNAPSHOTS = fileURLToPath(new URL('./snapshots/workbench', import.meta.url))
const MODE = webSnapshotMode()

/** Submit through one explicit pane's existing composer. */
async function prompt(pane: Locator, text: string): Promise<void> {
  const input = pane.locator('textarea').first()
  await input.fill(text)
  await input.press('Enter')
}

describe('web: Cordis Workspace workbench', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let releaseStartupHistory: (() => void) | undefined
  afterEach(async () => {
    releaseStartupHistory?.()
    releaseStartupHistory = undefined
    await browser?.close()
    await scaffold?.close()
    browser = undefined
    scaffold = undefined
  })

  it.skipIf(MODE === 'record')('shares the focused Session tools without clipping or changing action ownership', async () => {
    try {
      scaffold = await launchWebScaffold({ workbench: true, openInApp: false })
      const runtime = scaffold
      const seed = await readFile(SEED, 'utf8')
      const hostIds = []
      for (const name of ['header-one', 'header-two', 'header-three', 'header-four']) {
        const path = join(runtime.workspaceCwd, name)
        await mkdir(join(path, 'workspace'), { recursive: true })
        const workspace = await runtime.ctx.workspaceRegistry.create(path)
        const id = await seedSession(runtime, seed, name, undefined, path)
        await workspace.attachSession(id)
        await runtime.ctx.agents.resume({ resumeSessionId: id, setup: ctx => runtime.ctx.agentPresets.mount(ctx).then(() => undefined) })
        hostIds.push(id)
      }
      browser = await chromium.launch()
      page = await browser.newPage({ viewport: { width: 2160, height: 900 }, locale: 'en-US' })
      const tripwire = watchConsole(page)
      onTestFailed(() => saveFailureShot(page, 'workbench-header-tools'))
      await page.goto(runtime.authenticatedUrl, { waitUntil: 'load' })
      const toolbar = page.locator('[data-workbench-toolbar]')
      await toolbar.waitFor({ timeout: 30_000 })
      await toolbar.getByRole('button', { name: 'Select workbench' }).click()
      await page.getByRole('menuitem', { name: /My workbench/ }).click()
      await page.locator('[data-workbench-empty-content]').waitFor()
      for (const name of ['header-one', 'header-two', 'header-three', 'header-four']) {
        await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).click()
        const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
        await picker.locator('button').filter({ hasText: name }).first().click()
        await picker.waitFor({ state: 'hidden' })
      }
      const panes = page.locator('[data-session-pane]')
      const tools = page.locator('[data-workbench-tools-host]')
      const header = tools.locator('[data-workbench-session-tools]:not([hidden])')
      const opener = tools.getByRole('button', { name: 'Open right sidebar', exact: true })
      await opener.waitFor()
      const expectedDir = fileURLToPath(new URL('./expected/workbench/header-tools/', import.meta.url))
      if (MODE === 'refresh') await mkdir(expectedDir, { recursive: true })
      const codingView = async (enabled: boolean): Promise<void> => {
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
        const toggle = dialog.getByRole('switch', { name: 'Show coding view', exact: true })
        await expect.poll(() => toggle.isEnabled()).toBe(true)
        if ((await toggle.getAttribute('aria-checked') === 'true') !== enabled) await toggle.click()
        await expect.poll(() => toggle.getAttribute('aria-checked')).toBe(String(enabled))
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden' })
      }
      await codingView(true)
      await expect.poll(() => tools.getByRole('tab').count()).toBe(2)
      await compareOrRefreshGolden(join(expectedDir, 'coding-view.expected.md'),
        await captureStableAria(page, '[data-workbench-tools-host]', runtime.workspaceCwd), MODE)
      await codingView(false)
      await expect.poll(() => header.count()).toBe(1)
      expect(await panes.locator('[data-slot="conversation.session.header"] > header').count()).toBe(0)
      expect(await panes.locator('[data-workbench-pane-header]').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height <= 36))).toBe(true)
      const originalToolHeight = await toolbar.evaluate(node => node.getBoundingClientRect().height)
      expect(originalToolHeight).toBeLessThanOrEqual(44)
      const agent = runtime.ctx.agents.get(hostIds[3]!)
      if (agent === undefined) throw new Error('The header fixture Session has no live Agent')
      await runtime.ctx.tools.execute({
        signal: new AbortController().signal, callId: ToolCallId('workbench-header-job'), name: 'bash',
        arguments: { command: 'sleep 300', description: 'Verify workbench job controls', run_in_background: true }, agent,
      })
      const otherAgent = runtime.ctx.agents.get(hostIds[0]!)
      if (otherAgent === undefined) throw new Error('The first fixture Session has no live Agent')
      await runtime.ctx.tools.execute({
        signal: new AbortController().signal, callId: ToolCallId('workbench-other-job'), name: 'bash',
        arguments: { command: 'sleep 301', description: 'Verify separate Session ownership', run_in_background: true }, agent: otherAgent,
      })
      const trigger = tools.getByRole('button', { name: '1 background job running', exact: true })
      await trigger.waitFor({ timeout: 15_000 })
      expect(await header.isVisible()).toBe(true)
      await compareOrRefreshGolden(join(expectedDir, 'job-tools.expected.md'),
        await captureStableAria(page, '[data-workbench-tools-host]', runtime.workspaceCwd), MODE)
      await trigger.focus()
      await page.keyboard.press('Enter')
      const menu = page.getByRole('list', { name: 'Background jobs', exact: true })
      await menu.waitFor()
      expect(await menu.getByRole('button', { name: 'Stop task sleep 300', exact: true }).count()).toBe(1)
      expect(await menu.getByRole('button', { name: 'Stop task sleep 301', exact: true }).count()).toBe(0)
      await panes.first().locator('[data-workbench-pane-header]').click()
      await menu.waitFor({ state: 'hidden' })
      await trigger.click()
      await menu.waitFor()
      expect(await menu.getByRole('button', { name: 'Stop task sleep 301', exact: true }).count()).toBe(1)
      expect(await menu.getByRole('button', { name: 'Stop task sleep 300', exact: true }).count()).toBe(0)
      await panes.last().getByRole('button', { name: 'Collapse pane', exact: true }).focus()
      await menu.waitFor({ state: 'hidden' })
      await trigger.click()
      await menu.waitFor()
      await panes.last().getByRole('button', { name: 'Collapse pane', exact: true }).focus()
      await page.keyboard.press('Space')
      await menu.waitFor({ state: 'hidden' })
      await panes.last().getByRole('button', { name: 'Expand pane', exact: true }).click()
      await panes.last().locator('[data-workbench-pane-header]').click()
      await trigger.click()
      await menu.waitFor()
      for (const width of [1566, 1024]) {
        await page.setViewportSize({ width, height: 900 })
        await expect.poll(() => menu.evaluate((node) => {
          const rect = node.getBoundingClientRect()
          const hit = document.elementFromPoint(rect.right - 8, rect.top + rect.height / 2)
          return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && hit !== null && node.contains(hit)
        })).toBe(true)
      }
      await menu.getByRole('button', { name: 'Stop task sleep 300', exact: true }).click()
      await menu.getByRole('button', { name: 'Click again to confirm', exact: true }).click()
      await tools.getByRole('button', { name: '1 background job', exact: true }).waitFor({ timeout: 20_000 })
      await menu.getByRole('button', { name: 'Clear', exact: true }).click()
      await page.setViewportSize({ width: 390, height: 900 })
      await expect.poll(() => page.locator('[data-workbench-tools-host]').count()).toBe(0)
      await expect.poll(() => panes.count()).toBe(1)
      expect(await panes.locator('[data-slot="conversation.session.header"] > header').count()).toBe(1)
      await page.setViewportSize({ width: 2160, height: 900 })
      await expect.poll(() => toolbar.evaluate(node => node.getBoundingClientRect().height)).toBe(originalToolHeight)
      await expect.poll(() => header.count()).toBe(1)
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      if (page !== undefined) {
        await saveFailureShot(page, 'workbench-header-tools')
        console.info('[workbench-header-state]', (await page.locator('body').ariaSnapshot()).slice(0, 12000))
      }
      throw error
    }
  }, 180_000)

  it.skipIf(MODE === 'record')('isolates four panes, concurrent streams, approval, draft recovery, and background completion', async () => {
    scaffold = await launchWebScaffold({
      workbench: true,
      openInApp: false,
      replayFixture: APPROVAL,
      replayChildFixtures: [REPLY, REPLY],
      paceMs: 15,
    })
    const runtime = scaffold
    const events = new Map<string, SessionEvent[]>()
    const assistantFrames = new Map<string, number>()
    scaffold.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const log = events.get(session.id) ?? []
      log.push(event)
      events.set(session.id, log)
    })
    scaffold.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (frame.type !== 'chunk') return
      assistantFrames.set(agent.session.id, (assistantFrames.get(agent.session.id) ?? 0) + 1)
    })
    // Seed one content-bearing Session per Workspace through the production
    // persistence and Workspace registry paths; the chooser's history list
    // hides blank Sessions, and attachSession validates the header cwd against
    // the workspace path. The browser exercises chooser selection and pane
    // binding; no Session internals are injected.
    const seed = await readFile(SEED, 'utf8')
    const workspaceIds: string[] = []
    const hostIds: string[] = []
    for (const name of ['alpha', 'beta', 'gamma', 'delta-with-a-long-workspace-name']) {
      const path = join(scaffold.workspaceCwd, name)
      await mkdir(path)
      await mkdir(join(path, 'workspace'))
      const workspace = await scaffold.ctx.workspaceRegistry.create(path)
      const session = await seedSession(scaffold, seed, `workbench-${name}`, undefined, path)
      hostIds.push(session)
      await workspace.attachSession(session)
      await scaffold.ctx.agents.resume({
        resumeSessionId: session,
        setup: agentCtx => runtime.ctx.agentPresets.mount(agentCtx).then(() => undefined),
      })
      workspaceIds.push(workspace.id)
    }
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, locale: 'en-US' })
    const sockets: string[] = []
    page.on('websocket', (socket) => { sockets.push(socket.url()) })
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'workbench'))
    const requestedHistory = Promise.withResolvers<undefined>()
    const releasedHistory = Promise.withResolvers<undefined>()
    releaseStartupHistory = () => { releasedHistory.resolve(undefined) }
    let held = false
    await page.route(/\/api\/session\.history(?:\?.*)?$/, async (route) => {
      if (!held) {
        held = true
        requestedHistory.resolve(undefined)
        await releasedHistory.promise
      }
      await route.continue()
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await requestedHistory.promise
    const toolbar = page.locator('[data-workbench-toolbar]')
    await toolbar.waitFor({ timeout: 30_000 })
    // History completion moves the same root controls from Hero to title row;
    // an already-open menu must survive without a second opening gesture.
    await toolbar.getByRole('button', { name: 'Select workbench' }).click()
    await page.getByRole('menuitem', { name: /My workbench/ }).waitFor()
    releasedHistory.resolve(undefined)
    await page.locator('[class*="titleRow"] [data-workbench-toolbar]').waitFor()
    expect(await toolbar.getByRole('button', { name: 'Select workbench' }).getAttribute('aria-expanded')).toBe('true')
    await page.getByRole('menuitem', { name: /My workbench/ }).click()
    await page.locator('[data-workbench-empty-content]').waitFor({ timeout: 30_000 })
    for (const workspaceId of workspaceIds) {
      await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).click()
      const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
      const name = ['alpha', 'beta', 'gamma', 'delta-with-a-long-workspace-name'][workspaceIds.indexOf(workspaceId)]!
      await picker.locator('button').filter({ hasText: name }).first().click()
      await picker.waitFor({ state: 'hidden' })
    }
    const panes = page.locator('[data-session-pane]')
    expect(await panes.count()).toBe(4)
    const firstHeader = panes.first().locator('[data-workbench-pane-header]')
    const lastHeader = panes.last().locator('[data-workbench-pane-header]')
    const firstActions = firstHeader.locator('[class*="paneActions"]')
    const lastActions = lastHeader.locator('[class*="paneActions"]')
    await toolbar.hover()
    await expect.poll(() => firstActions.evaluate(node => getComputedStyle(node).opacity)).toBe('0')
    await expect.poll(() => lastActions.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
    const titleBounds = await firstHeader.locator('strong').boundingBox()
    await firstHeader.hover()
    await expect.poll(() => firstActions.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
    expect(await firstHeader.locator('strong').boundingBox()).toEqual(titleBounds)
    await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).focus()
    await toolbar.hover()
    await expect.poll(() => firstActions.evaluate(node => getComputedStyle(node).opacity)).toBe('0')
    await page.keyboard.press('Tab')
    await expect.poll(() => firstHeader.evaluate(node => node.contains(document.activeElement))).toBe(true)
    await expect.poll(() => firstActions.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
    await firstHeader.getByRole('button', { name: 'More pane actions', exact: true }).click()
    await page.getByRole('menu').hover()
    expect(await firstActions.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
    await page.keyboard.press('Escape')
    for (const [width, visiblePanes] of [[1566, 4], [1024, 4], [600, 1], [375, 1], [1920, 4]] as const) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(() => panes.count()).toBe(visiblePanes)
      expect(await page.locator('[data-workbench-row]').count()).toBe(1)
      await expect.poll(() => page.locator('[data-workbench-row]').evaluateAll(rows => rows.every((row) => {
        const bounds = row.getBoundingClientRect()
        const first = row.firstElementChild!.getBoundingClientRect()
        const last = row.lastElementChild!.getBoundingClientRect()
        return Math.abs(first.left - bounds.left) < 1 && Math.abs(last.right - bounds.right) < 1
          && Math.abs(bounds.height - row.parentElement!.clientHeight) < 1
      }))).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      if (width === 1024) {
        const roster = page.getByRole('list', { name: 'Panes', exact: true }).locator('[class*="sidebarPaneFocus"]')
        await roster.first().click()
        await expect.poll(() => page.locator('[data-workbench-grid]').evaluate(node => node.scrollLeft)).toBe(0)
        await roster.last().click()
        await expect.poll(() => page.locator('[data-workbench-grid]').evaluate((node) => {
          const pane = node.querySelector('[data-session-pane][data-active]')!
          return pane.getBoundingClientRect().right <= node.getBoundingClientRect().right + 1
        })).toBe(true)
      }
    }
    const ids = await panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-pane')!))
    const [a, b, c, d] = ids.map(id => page.locator(`[data-session-pane="${id}"]`)) as [Locator, Locator, Locator, Locator]
    await d.locator('textarea').first().fill('Delta draft survives pane changes')
    await a.locator('[aria-label^="Access mode"]').click()
    await page.getByRole('menuitem', { name: 'Read only', exact: true }).click()
    const approvalPrompt = fixtureUserPrompts(await readFile(APPROVAL, 'utf8'))[0]!
    const replyPrompt = fixtureUserPrompts(await readFile(REPLY, 'utf8'))[0]!
    await prompt(a, approvalPrompt)
    await expect.poll(() => (assistantFrames.get(hostIds[0]!) ?? 0) > 0, { timeout: 30_000 }).toBe(true)
    await prompt(b, replyPrompt)
    await expect.poll(() => (assistantFrames.get(hostIds[1]!) ?? 0) > 0, { timeout: 30_000 }).toBe(true)
    expect(await a.locator('[data-state="ongoing"]').count()).toBeGreaterThan(0)
    expect(await b.locator('[data-state="ongoing"]').count()).toBeGreaterThan(0)
    const approval = a.locator('[data-approval-key]')
    await approval.waitFor({ timeout: 60_000 })
    await prompt(c, replyPrompt)
    await expect.poll(() => (assistantFrames.get(hostIds[2]!) ?? 0) > 0, { timeout: 30_000 }).toBe(true)
    await c.getByRole('button', { name: 'Close pane', exact: true }).click()
    await expect.poll(() => events.get(hostIds[2]!)?.some(event => event.type === 'turn/end'), { timeout: 60_000 }).toBe(true)
    expect(await panes.count()).toBe(3)
    expect(await approval.count()).toBe(1)
    expect(await d.locator('textarea').first().inputValue()).toBe('Delta draft survives pane changes')
    await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
    await expect.poll(() => events.get(hostIds[0]!)?.some(event => event.type === 'turn/end'), { timeout: 60_000 }).toBe(true)
    expect(await approval.count()).toBe(0)
    expect(sockets.length).toBe(2)
    await compareOrRefreshGolden(join(SNAPSHOTS, 'toolbar.expected.md'), await captureStableAria(page, '[data-workbench-toolbar]', scaffold.workspaceCwd), MODE)
    await page.setViewportSize({ width: 600, height: 900 })
    await expect.poll(() => panes.count()).toBe(1)
    expect(await toolbar.getByRole('tab').count()).toBe(3)
    await toolbar.getByRole('tab').last().click()
    expect(await panes.locator('textarea').first().inputValue()).toBe('Delta draft survives pane changes')
    await compareOrRefreshGolden(join(SNAPSHOTS, 'tabs.expected.md'), await captureStableAria(page, '[data-workbench-toolbar]', scaffold.workspaceCwd), MODE)
    await page.reload({ waitUntil: 'load' })
    await page.locator('[data-session-pane]').waitFor({ timeout: 30_000 })
    await expect.poll(() => page.locator('[data-session-pane] textarea').first().inputValue()).toBe('Delta draft survives pane changes')
    await toolbar.getByRole('button', { name: 'Select workbench' }).click()
    await page.getByRole('menuitem', { name: 'Exit workbench', exact: true }).click()
    expect(await page.locator('[data-session-pane]').count()).toBe(0)
    expect(await page.locator('textarea').first().inputValue()).toBe('Delta draft survives pane changes')
    await toolbar.getByRole('button', { name: 'Select workbench' }).click()
    await page.getByRole('menuitem', { name: /My workbench/ }).click()
    expect(await toolbar.getByRole('tab').count()).toBe(3)
    expect(tripwire.pageErrors).toEqual([])
  }, 240_000)
})
