/** Historical workspace review through the shipped recorder, RPC, and Web consumers. */
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {} from '@deepseek-ai/dsh-workspace-changes/types'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import {
  launchWebScaffold, watchConsole, captureStableAria, compareOrRefreshGolden, assertFixtureInventory,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SESSION = SessionId('workspace-review-web')
const DIRECTORY = fileURLToPath(new URL('./snapshots/workspace-review', import.meta.url))

describe('web e2e: delivered files and historical review', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ workbench: true })
    const { ctx, workspaceCwd } = scaffold
    execFileSync('git', ['init', '--quiet'], { cwd: workspaceCwd })
    await writeFile(join(workspaceCwd, 'review.txt'), 'before the turn\n')
    const created = await ctx.apiProxy.sessions.create({ rpcId: RpcId('review-create'), payload: { sessionId: SESSION, cwd: workspaceCwd } })
    if (!created.result.ok) throw new Error(created.result.error.message)
    const agent = ctx.agents.get(SESSION)
    if (agent === undefined) throw new Error('Created Session has no Agent')
    const session = agent.session
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Update the review file.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    const args = { file_path: 'review.txt', content: 'after the turn\n' }
    // The recorder observes the same pre-execution waterfall as a real file tool.
    await ctx.waterfall('tools/pre-execute', { agent, name: 'write', arguments: args } as never, () => Promise.resolve(undefined as never))
    await writeFile(join(workspaceCwd, 'review.txt'), args.content)
    const callId = ToolCallId('review-write')
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name: 'write', arguments: JSON.stringify(args) }],
      source: { provider: 'fixture', model: 'fixture' },
    }) }, { surfaceOp: 'append' })
    const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'write', arguments: JSON.stringify(args) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Updated review.txt' }], isError: false }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    const delivery = await ctx.tools.execute({
      agent, signal: new AbortController().signal, name: 'present', callId: ToolCallId('review-present'),
      arguments: { files: [{ path: 'review.txt', description: 'Reviewed text file' }] },
    })
    expect(delivery.isError).toBe(false)
    expect(session.snapshotEvents().find(event => event.type === 'deliverables/presented'))
      .toMatchObject({ data: { files: [{ path: 'review.txt', description: 'Reviewed text file' }] } })
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      content: [{ type: 'text', text: 'The review file is ready.' }], source: { provider: 'fixture', model: 'fixture' },
    }) }, { surfaceOp: 'append' })
    await ctx.parallel('agent/turn-stopping', { agent, turn: 1 } as never)
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const event = session.snapshotEvents().find(event => event.type === 'workspace/changes')
    if (event === undefined) throw new Error('Shipped recorder did not announce changes')
    expect(ctx.workspaceChanges.summary(SESSION, event.seq)?.files.map(file => file.path)).toContain('review.txt')
    // Ordinary preview must see the newer file while Review keeps the turn snapshot.
    await writeFile(join(workspaceCwd, 'review.txt'), 'current file changed later\n')
    const workspace = await ctx.workspaceRegistry.create(workspaceCwd)
    await workspace.attachSession(SESSION)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('opens the recorded comparison and separately previews the current file', async () => {
    if (scaffold === undefined) throw new Error('Web scaffold unavailable')
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-review'))
    const tripwire = watchConsole(page)
    const summaryResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/workspaceChanges.summary'))
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    const summaryWire: unknown = await (await summaryResponse).json()
    expect(summaryWire, JSON.stringify(summaryWire)).toMatchObject({ result: { ok: true, value: { files: [{ path: 'review.txt' }] } } })
    await page.getByText('The review file is ready.', { exact: true }).waitFor()
    await page.locator('[data-presented-file]').waitFor()
    await page.locator('[data-changed-files] li button').first().click()
    const review = page.locator('[data-changes-review]')
    await expect.poll(() => review.textContent()).toContain('before the turn')
    expect(await review.textContent()).toContain('after the turn')
    expect(await review.textContent()).not.toContain('current file changed later')
    // The host reports an open-in-app handler only on desktops that probe
    // one, so the default-app row is environment-dependent chrome.
    const reviewSnapshot = (await captureStableAria(page, '[data-changes-review]', scaffold.workspaceCwd))
      .replace(/\n *- button "Open [^\n]* in default app":\n *- img/g, '')
    await compareOrRefreshGolden(join(DIRECTORY, 'review.expected.md'), reviewSnapshot, webSnapshotMode())
    await review.locator('[data-review-tool="split"]').click()
    await review.locator('[data-review-tool="wrap"]').click()
    expect(await review.locator('[data-review-tool="split"]').getAttribute('aria-pressed')).toBe('true')
    await review.locator('[data-review-tool="open-file"]').click()
    expect(tripwire.pageErrors).toEqual([])
    await page.getByText('current file changed later', { exact: false }).waitFor()
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(await page.locator('[data-slot-error]').count()).toBe(0)
  }, 60_000)

  it('owns only its review golden', async () => { await assertFixtureInventory(DIRECTORY, ['review.expected.md']) })
})
