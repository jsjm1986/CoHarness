/** Durable Tool details survive bounded chat history through the shipped Web application. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { beforeAll, afterAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  launchWebScaffold, seedSession, watchConsole, captureStableAria, compareOrRefreshGolden,
  assertFixtureInventory, webSnapshotMode, acknowledgeReloadConnectionLoss, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

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
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
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
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.getByText('Later answer 30', { exact: true }).waitFor()
    // The fixture exceeds one tail page; reaching the head requests its only older page.
    await page.locator('[data-conversation-scroll]').evaluate((element) => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })
    await page.getByRole('button', { name: '2 tool calls · 2 intermediate messages', exact: true }).click()
    const call = page.locator(`[data-chat-call-id="${CALL}"]`)
    await call.getByText('Read', { exact: true }).click()
    await call.getByRole('button', { name: 'Open details in sidebar', exact: true }).click()
    const panel = page.locator('[data-sidebar-right-panel]')
    await panel.getByText('Input', { exact: true }).waitFor()
    expect(await panel.textContent()).toContain('a.txt')
    expect(tripwire.warnings).toEqual([])
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.getByText('Later answer 30', { exact: true }).waitFor()
    await panel.getByText('Input', { exact: true }).waitFor()
    expect(await page.locator(`[data-conversation-scroll] [data-chat-call-id="${CALL}"]`).count()).toBe(0)
    expect(await panel.textContent()).toContain('a.txt')
    expect(await panel.textContent()).toContain('alpha')
    const snapshot = await captureStableAria(page, '[data-sidebar-right-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(DIRECTORY, 'details.expected.md'), snapshot, webSnapshotMode())
    expect(scaffold.ctx.agents.get(SessionId(SESSION))?.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(30)
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(await page.locator('[data-slot-error]').count()).toBe(0)
  }, 60_000)

  it('owns only its detail golden', async () => {
    await assertFixtureInventory(DIRECTORY, ['details.expected.md'])
  })
})
