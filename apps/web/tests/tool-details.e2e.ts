/** Durable Tool details survive bounded chat history through the shipped Web application. */
import { auditWorkflowState, compareWorkflowGolden, newWorkflowPage } from './workflow-responsive-state.ts'
import { responsiveBrowser } from './responsive-browser.ts'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'

import { beforeAll, afterAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  launchWebScaffold, seedSession, watchConsole, captureStableAria,
  assertFixtureInventory, webSnapshotMode, acknowledgeReloadConnectionLoss, selectedSessionFixture, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, REPO_ROOT, saveFailureShot } from './support.ts'
import { captureTextContrast, expectTextContrast } from './text-contrast.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const DIRECTORY = fileURLToPath(new URL('./snapshots/tool-details', import.meta.url))
const CALL = 'call_00_OsndvlcKnCcUmae7QXal8633'
const SESSION = 'tool-details-history'

describe('web e2e: durable Tool detail tab', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    let seed = await readFile(SEED, 'utf8')
    // Complete extra turns put the recorded call beyond the ordinary tail page.
    for (let turn = 2; turn <= 30; turn++) {
      const user = createUserMessage({ content: [{ type: 'text', text: `Later question ${turn}` }], source: { kind: 'user' } })
      const assistant = createAssistantMessage({ content: [{ type: 'text', text: `Later answer ${turn}` }], source: { provider: 'fixture', model: 'fixture' } })
      seed += [
        { type: 'turn/start', data: { turn } },
        { type: 'step/start', data: { turn, step: 1 } },
        { type: 'user/message', data: user, surfaceOp: 'append' },
        { type: 'assistant/message', data: { turn, step: 1, stream: [], message: assistant }, surfaceOp: 'append' },
        { type: 'step/end', data: { turn, step: 1, reason: { kind: 'completed' } } },
        { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
      ].map(event => JSON.stringify(event)).join('\n') + '\n'
    }
    const history = await seedSession(scaffold, seed, SESSION)
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(history)
    browser = await responsiveBrowser.launch()
    page = await newWorkflowPage(browser)
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() }
    finally { await scaffold?.close() }
  })

  it('reads cold details without activation and restores the tab outside the chat window', async () => {
    if (scaffold === undefined) throw new Error('Web scaffold unavailable')
    onTestFailed(() => saveFailureShot(page, 'web-e2e-tool-details'))
    const tripwire = watchConsole(page)
    expect(scaffold.ctx.agents.get(SessionId(SESSION)) === undefined).toBe(true)
    const cold = await scaffold.ctx.apiProxy.sessions.history({
      rpcId: RpcId('cold-tool-detail'), payload: { sessionId: SessionId(SESSION), toolCallId: ToolCallId(CALL) },
    })
    expect(cold.result.ok).toBe(true)
    expect(scaffold.ctx.agents.get(SessionId(SESSION)) === undefined).toBe(true)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByText('Later answer 30', { exact: true }).waitFor()
    // The fixture exceeds one tail page; reaching the head requests its only older page.
    await page.locator('[data-conversation-scroll]').evaluate((element) => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })
    // The whole-turn process disclosure carries the durable counts as data
    // attributes; opening it reveals the collapsed step group over the calls.
    const process = page.locator('[data-turn-process="1"]')
    await process.waitFor()
    expect(await process.getAttribute('data-turn-process-tool-calls')).toBe('2')
    await process.click()
    await page.getByRole('button', { name: 'Read files', exact: true }).click()
    const call = page.locator(`[data-chat-call-id="${CALL}"]`)
    await call.getByRole('button', { name: 'Read', exact: true }).click()
    await call.getByRole('button', { name: 'Open details in sidebar', exact: true }).click()
    const panel = page.locator('[data-sidebar-right-panel]')
    await panel.getByText('Input', { exact: true }).waitFor()
    expect(await panel.textContent()).toContain('a.txt')
    await auditWorkflowState(page, 'tool-cards', 'cold-call-sidebar-details', panel)
    expect(tripwire.warnings).toEqual([])
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.getByText('Later answer 30', { exact: true }).waitFor()
    await panel.getByText('Input', { exact: true }).waitFor()
    expect(await page.locator(`[data-conversation-scroll] [data-chat-call-id="${CALL}"]`).count()).toBe(0)
    expect(await panel.textContent()).toContain('a.txt')
    expect(await panel.textContent()).toContain('alpha')
    await auditWorkflowState(page, 'tool-cards', 'restored-call-sidebar-details', panel)
    const snapshot = await captureStableAria(page, '[data-sidebar-right-panel]', scaffold.workspaceCwd)
    await compareWorkflowGolden(join(DIRECTORY, 'details.expected.md'), snapshot, webSnapshotMode())
    const stored = await scaffold.ctx.sessionPersistence.inspect(SessionId(SESSION))
    expect(stored.events.filter(event => event.type === 'turn/start')).toHaveLength(30)
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(await page.locator('[data-slot-error]').count()).toBe(0)
  }, 60_000)

  it.each([
    { tone: 'success', fixture: 'workflow-run', callId: 'call_00_dD2BLuNeJCTh2iiYC1QR3449' },
    { tone: 'warning', fixture: 'background-job-admission', callId: 'bounded-task-kill' },
    { tone: 'error', fixture: 'product-subagent-result-diagnostic', callId: 'call_claude_output' },
  ])('reads the recorded $tone receipt in Chat and sidebar details', async ({ tone, fixture, callId }) => {
    if (scaffold === undefined || browser === undefined) throw new Error('Web scaffold unavailable')
    const source = await selectedSessionFixture(join(REPO_ROOT, 'examples/acp-agent/tests/snapshots', fixture, 'session.v7.jsonl'))
    const id = await seedSession(scaffold, await readFile(source, 'utf8'), `tool-receipt-${tone}`)
    await (await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)).attachSession(id)
    const target = await newWorkflowPage(browser)
    const errors = watchConsole(target)
    await target.addInitScript((sessionId) => {
      if (window === window.top) localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }))
    }, id)
    try {
      await target.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      const card = target.locator(`[data-chat-call-id="${callId}"]`)
      await expandOwningTurnProcess(target, card)
      const disclosure = card.locator('[data-expandable]').first()
      await disclosure.waitFor()
      if (await disclosure.getAttribute('aria-expanded') !== 'true') {
        const box = await disclosure.boundingBox()
        if (box === null) throw new Error('Recorded receipt has no disclosure bounds')
        await disclosure.click({ position: { x: 8, y: box.height / 2 } })
      }
      const inlineBadge = card.locator(`[class*="badge"][data-tone="${tone}"]`).first()
      await inlineBadge.waitFor()
      const badgeText = await inlineBadge.innerText()
      expect(badgeText.trim().length).toBeGreaterThan(0)
      expectTextContrast(await captureTextContrast(target, [{ label: tone, text: inlineBadge }], `tool-receipt-${tone}-inline`))
      await auditWorkflowState(target, 'tool-receipts', `${tone}-inline`, card, [disclosure])
      await card.getByRole('button', { name: 'Open details in sidebar', exact: true }).click()
      const panel = target.locator('[data-sidebar-right-panel]')
      const sidebarBadge = panel.locator(`[class*="badge"][data-tone="${tone}"]`).first()
      await sidebarBadge.waitFor()
      expect(await sidebarBadge.innerText()).toBe(badgeText)
      expectTextContrast(await captureTextContrast(target, [{ label: tone, text: sidebarBadge }], `tool-receipt-${tone}-sidebar`))
      await auditWorkflowState(target, 'tool-receipts', `${tone}-sidebar`, panel)
      await compareWorkflowGolden(join(DIRECTORY, `receipt-${tone}.expected.md`),
        await captureStableAria(target, '[data-sidebar-right-panel]', scaffold.workspaceCwd), webSnapshotMode())
      expect(errors.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(target, `tool-receipt-${tone}`); throw error }
    finally { await target.close() }
  }, 180_000)

  it('owns only its detail goldens', async () => {
    await assertFixtureInventory(DIRECTORY, ['details.expected.md', 'receipt-success.expected.md', 'receipt-warning.expected.md', 'receipt-error.expected.md'])
  })
})
