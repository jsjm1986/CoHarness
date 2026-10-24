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
const PROVIDERS = fileURLToPath(new URL('./snapshots/plan-narrow-viewport/session.jsonl', import.meta.url))
const SNAPSHOTS = fileURLToPath(new URL('./snapshots/workbench', import.meta.url))
const SELECTION_EXPECTED_DIR = fileURLToPath(new URL('./expected/workbench', import.meta.url))
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

  it.skipIf(MODE === 'record')('restores the selected named workbench after reloading identical pane layouts', async () => {
    scaffold = await launchWebScaffold({
      workbench: true, openInApp: false, replayFixture: PROVIDERS, replayProvidersOnly: true,
    })
    const runtime = scaffold
    const seed = await readFile(SEED, 'utf8')
    const names = ['selection-alpha', 'selection-beta']
    for (const name of names) {
      const path = join(scaffold.workspaceCwd, name)
      await mkdir(path)
      await mkdir(join(path, 'workspace'))
      const workspace = await scaffold.ctx.workspaceRegistry.create(path)
      const session = await seedSession(scaffold, seed, name, undefined, path)
      await workspace.attachSession(session)
      await scaffold.ctx.agents.resume({
        resumeSessionId: session,
        setup: agentCtx => runtime.ctx.agentPresets.mount(agentCtx).then(() => undefined),
      })
    }
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'workbench-selection-reload'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const toolbar = page.locator('[data-workbench-toolbar]')
    await page.locator('[class*="titleRow"] [data-workbench-toolbar]').waitFor({ timeout: 30_000 })
    const caption = toolbar.getByRole('button', { name: 'Select workbench', exact: true })
    await caption.click()
    await page.getByRole('menuitem', { name: 'New workbench', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'New workbench', exact: true })
    await create.getByRole('textbox', { name: 'Workbench name', exact: true }).fill('Selection A')
    await create.getByRole('button', { name: 'Confirm', exact: true }).click()
    await create.waitFor({ state: 'hidden' })
    for (const name of names) {
      await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).click()
      const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
      await picker.locator('button').filter({ hasText: name }).first().click()
      await picker.waitFor({ state: 'hidden' })
    }
    const panes = page.locator('[data-session-pane]')
    await expect.poll(() => panes.count()).toBe(2)
    await panes.first().locator('textarea').first().click()
    await expect.poll(() => panes.first().getAttribute('data-active')).toBe('true')
    const layout = await panes.evaluateAll(nodes => nodes.map(node => ({
      id: node.getAttribute('data-session-pane'), active: node.getAttribute('data-active'),
    })))
    const ratios = await page.locator('[data-session-pane] [role="separator"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-valuenow')))
    expect(ratios).toEqual(['50'])
    await caption.click()
    await page.getByRole('menuitem', { name: 'Duplicate workbench', exact: true }).click()
    const duplicate = page.getByRole('dialog', { name: 'Duplicate workbench', exact: true })
    await duplicate.getByRole('textbox', { name: 'Workbench name', exact: true }).fill('Selection B')
    await duplicate.getByRole('button', { name: 'Confirm', exact: true }).click()
    await duplicate.waitFor({ state: 'hidden' })
    expect((await caption.innerText()).trim()).toBe('Selection B')
    expect(await panes.evaluateAll(nodes => nodes.map(node => ({
      id: node.getAttribute('data-session-pane'), active: node.getAttribute('data-active'),
    })))).toEqual(layout)
    expect(await page.locator('[data-session-pane] [role="separator"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-valuenow')))).toEqual(ratios)
    await caption.click()
    await page.getByRole('menuitem', { name: 'Selection A · 2/4', exact: true }).click()
    await page.getByRole('menu').waitFor({ state: 'hidden' })
    expect((await caption.innerText()).trim()).toBe('Selection A')
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => panes.count(), { timeout: 30_000 }).toBe(2)
    await expect.poll(() => panes.evaluateAll(nodes => nodes.filter((node) => {
      const input = node.querySelector('textarea')
      return input !== null && !input.disabled && !input.readOnly
    }).length), { timeout: 30_000 }).toBe(2)
    expect((await caption.innerText()).trim()).toBe('Selection A')
    expect(await panes.evaluateAll(nodes => nodes.map(node => ({
      id: node.getAttribute('data-session-pane'), active: node.getAttribute('data-active'),
    })))).toEqual(layout)
    expect(await page.locator('[data-session-pane] [role="separator"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-valuenow')))).toEqual(ratios)
    expect(tripwire.pageErrors).toEqual([])
    if (MODE === 'refresh') await mkdir(SELECTION_EXPECTED_DIR, { recursive: true })
    await compareOrRefreshGolden(join(SELECTION_EXPECTED_DIR, 'selection-restored.expected.md'), await captureStableAria(page, '[data-workbench-toolbar]', scaffold.workspaceCwd), MODE)
  })

  it.skipIf(MODE === 'record')('selects a stored document into its restored workbench pane across view changes', async () => {
    scaffold = await launchWebScaffold({
      workbench: true, openInApp: false, replayFixture: PROVIDERS, replayProvidersOnly: true,
    })
    const runtime = scaffold
    const seed = await readFile(SEED, 'utf8')
    const names = ['picker-alpha', 'picker-beta']
    for (const name of names) {
      const path = join(runtime.workspaceCwd, name)
      await mkdir(path)
      await mkdir(join(path, 'workspace'))
      const workspace = await runtime.ctx.workspaceRegistry.create(path)
      const session = await seedSession(runtime, seed, name, undefined, path)
      await workspace.attachSession(session)
      await runtime.ctx.agents.resume({
        resumeSessionId: session,
        setup: agentCtx => runtime.ctx.agentPresets.mount(agentCtx).then(() => undefined),
      })
    }
    const content = 'Workbench library selection fixture'.padEnd(47, '.') + '\n'
    const bytes = new TextEncoder().encode(content)
    expect(bytes).toHaveLength(48)
    const target = await runtime.ctx.userDocs.resolveTarget({ name: 'workbench-library.txt' })
    const stored = await runtime.ctx.userDocs.save(target, new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); controller.close() },
    }))
    expect(stored.bytes).toBe(48)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'workbench-document-picker'))
    await page.goto(runtime.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[class*="titleRow"] [data-workbench-toolbar]').waitFor({ timeout: 30_000 })
    const toolbar = page.locator('[data-workbench-toolbar]')
    const caption = toolbar.getByRole('button', { name: 'Select workbench', exact: true })
    await caption.click()
    await page.getByRole('menuitem', { name: 'New workbench', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'New workbench', exact: true })
    await create.getByRole('textbox', { name: 'Workbench name', exact: true }).fill('Picker A')
    await create.getByRole('button', { name: 'Confirm', exact: true }).click()
    await create.waitFor({ state: 'hidden' })
    for (const name of names) {
      await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).click()
      const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
      await picker.locator('button').filter({ hasText: name }).first().click()
      await picker.waitFor({ state: 'hidden' })
    }
    await page.reload({ waitUntil: 'load' })
    const panes = page.locator('[data-session-pane]')
    await expect.poll(() => panes.count(), { timeout: 30_000 }).toBe(2)
    await expect.poll(() => panes.evaluateAll(nodes => nodes.filter((node) => {
      const input = node.querySelector('textarea')
      return input !== null && !input.disabled && !input.readOnly
    }).length), { timeout: 30_000 }).toBe(2)
    const [pKey, qKey] = await panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-pane')!))
    const p = page.locator(`[data-session-pane="${pKey}"]`)
    const q = page.locator(`[data-session-pane="${qKey}"]`)
    expect((await caption.innerText()).trim()).toBe('Picker A')
    expect(await page.getByRole('button', { name: 'Documents', exact: true }).count()).toBe(0)
    await q.locator('textarea').click()
    await p.getByRole('button', { name: 'Choose from Documents', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'Document Manager', exact: true })
    await manager.waitFor({ state: 'visible', timeout: 10_000 })
    await manager.getByText(stored.name, { exact: true }).waitFor()
    const output = [await manager.getByRole('heading', { name: 'Document Manager', exact: true }).ariaSnapshot()]
    await manager.getByRole('button', { name: `Preview ${stored.name}`, exact: true }).click()
    const preview = page.getByRole('dialog', { name: `Preview: ${stored.name}`, exact: true })
    await expect.poll(() => preview.locator('pre').textContent()).toBe(content)
    output.push(await captureStableAria(page, '[role="dialog"]:has(pre)', runtime.workspaceCwd))
    await preview.getByRole('button', { name: 'Close', exact: true }).click()
    await preview.waitFor({ state: 'hidden' })
    await manager.getByRole('button', { name: `Add ${stored.name} to conversation`, exact: true }).click()
    await manager.waitFor({ state: 'hidden' })
    const remove = p.getByRole('button', { name: `Remove document ${stored.name}`, exact: true })
    await remove.waitFor()
    await p.locator('[data-document-status="ready"]').waitFor()
    expect(await q.getByRole('button', { name: `Remove document ${stored.name}`, exact: true }).count()).toBe(0)
    output.push(await captureStableAria(
      page, `[data-session-pane="${pKey}"] [data-document-status="ready"]`, runtime.workspaceCwd,
    ))
    await q.locator('textarea').click()
    expect(await q.getByRole('button', { name: `Remove document ${stored.name}`, exact: true }).count()).toBe(0)
    await p.locator('textarea').click()
    await remove.click()
    await remove.waitFor({ state: 'hidden' })
    await expect.poll(() => p.getByRole('button', { name: 'Send message', exact: true }).isDisabled()).toBe(true)
    expect(new TextDecoder().decode((await runtime.ctx.userDocs.read(stored.docId)).data)).toBe(content)

    await caption.click()
    await page.getByRole('menuitem', { name: 'Exit workbench', exact: true }).click()
    await expect.poll(() => panes.count()).toBe(0)
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    await manager.getByText(stored.name, { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await manager.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Choose from Documents', exact: true }).click()
    await manager.getByText(stored.name, { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await manager.waitFor({ state: 'hidden' })
    await caption.click()
    await page.getByRole('menuitem', { name: 'Picker A · 2/4', exact: true }).click()
    await page.getByRole('menu').waitFor({ state: 'hidden' })
    await expect.poll(() => p.locator('textarea').isEditable()).toBe(true)
    await p.getByRole('button', { name: 'Choose from Documents', exact: true }).click()
    await manager.getByText(stored.name, { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await manager.waitFor({ state: 'hidden' })
    expect(tripwire.pageErrors).toEqual([])
    if (MODE === 'refresh') await mkdir(SELECTION_EXPECTED_DIR, { recursive: true })
    await compareOrRefreshGolden(join(SELECTION_EXPECTED_DIR, 'document-picker.expected.md'), output.join('\n\n'), MODE)
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
