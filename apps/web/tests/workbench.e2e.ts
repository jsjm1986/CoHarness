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
  afterEach(async () => {
    await browser?.close()
    await scaffold?.close()
    browser = undefined
    scaffold = undefined
  })

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
    scaffold.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const log = events.get(session.id) ?? []
      log.push(event)
      events.set(session.id, log)
    })
    // Seed one content-bearing Session per Workspace through the production
    // persistence and Workspace registry paths; the chooser's history list
    // hides blank Sessions, and attachSession validates the header cwd against
    // the workspace path. The browser exercises chooser selection and pane
    // binding; no Session internals are injected.
    const seed = await readFile(SEED, 'utf8')
    const workspaceIds: string[] = []
    for (const name of ['alpha', 'beta', 'gamma', 'delta-with-a-long-workspace-name']) {
      const path = join(scaffold.workspaceCwd, name)
      await mkdir(path)
      await mkdir(join(path, 'workspace'))
      const workspace = await scaffold.ctx.workspaceRegistry.create(path)
      const session = await seedSession(scaffold, seed, `workbench-${name}`, undefined, path)
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
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    const toolbar = page.locator('[data-workbench-toolbar]')
    await toolbar.waitFor({ timeout: 30_000 })
    // The conversation viewport boots in single-session mode; entering the
    // workbench is an explicit gesture through the toolbar's chooser, which
    // switches the viewport and mounts the default layout's (empty) panes.
    await toolbar.getByRole('button', { name: '选择工作台' }).click()
    await page.getByRole('menuitem', { name: /我的工作台/ }).click()
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
    const ids = await panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-pane')!))
    const [a, b, c, d] = ids.map(id => page.locator(`[data-session-pane="${id}"]`)) as [Locator, Locator, Locator, Locator]
    await d.locator('textarea').first().fill('Delta draft survives pane changes')
    await a.locator('[aria-label^="Access mode"]').click()
    await page.getByRole('menuitem', { name: 'Read Only', exact: true }).click()
    const approvalPrompt = fixtureUserPrompts(await readFile(APPROVAL, 'utf8'))[0]!
    const replyPrompt = fixtureUserPrompts(await readFile(REPLY, 'utf8'))[0]!
    await prompt(a, approvalPrompt)
    await expect.poll(() => events.get(ids[0]!)?.some(event => event.type === 'assistant/chunk'), { timeout: 30_000 }).toBe(true)
    await prompt(b, replyPrompt)
    await expect.poll(() => events.get(ids[1]!)?.some(event => event.type === 'assistant/chunk'), { timeout: 30_000 }).toBe(true)
    expect(await a.locator('[data-state="ongoing"]').count()).toBeGreaterThan(0)
    expect(await b.locator('[data-state="ongoing"]').count()).toBeGreaterThan(0)
    const approval = a.locator('[data-approval-key]')
    await approval.waitFor({ timeout: 60_000 })
    await prompt(c, replyPrompt)
    await expect.poll(() => events.get(ids[2]!)?.some(event => event.type === 'assistant/chunk'), { timeout: 30_000 }).toBe(true)
    await c.getByRole('button', { name: 'Close pane', exact: true }).click()
    await expect.poll(() => events.get(ids[2]!)?.some(event => event.type === 'turn/end'), { timeout: 60_000 }).toBe(true)
    expect(await panes.count()).toBe(3)
    expect(await approval.count()).toBe(1)
    expect(await d.locator('textarea').first().inputValue()).toBe('Delta draft survives pane changes')
    await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
    await expect.poll(() => events.get(ids[0]!)?.some(event => event.type === 'turn/end'), { timeout: 60_000 }).toBe(true)
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
    await toolbar.getByRole('button', { name: '选择工作台' }).click()
    await page.getByRole('menuitem', { name: 'Exit workbench', exact: true }).click()
    expect(await page.locator('[data-session-pane]').count()).toBe(0)
    expect(await page.locator('textarea').first().inputValue()).toBe('Delta draft survives pane changes')
    await toolbar.getByRole('button', { name: '选择工作台' }).click()
    await page.getByRole('menuitem', { name: /我的工作台/ }).click()
    expect(await toolbar.getByRole('tab').count()).toBe(3)
    expect(tripwire.pageErrors).toEqual([])
  }, 240_000)
})
