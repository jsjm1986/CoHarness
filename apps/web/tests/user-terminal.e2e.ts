/** Shipped terminal tabs use real PTYs and Remote streams without starting model turns. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import {
  launchWebScaffold, captureStableAria, compareOrRefreshGolden, assertFixtureInventory,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SESSION = SessionId('user-terminal-root')
const DIRECTORY = fileURLToPath(new URL('./snapshots/user-terminal', import.meta.url))

describe('web e2e: private user terminal lifecycle', () => {
  let scaffold: WebScaffold | undefined, browser: Browser | undefined, page: Page
  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const result = await scaffold.ctx.apiProxy.sessions.create({ rpcId: RpcId('terminal-create'), payload: { sessionId: SESSION, cwd: scaffold.workspaceCwd } })
    if (!result.result.ok) throw new Error(result.result.error.message)
    await (await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)).attachSession(SESSION)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
  })
  afterAll(async () => { try { await browser?.close() } finally { await scaffold?.close() } })

  it('writes through a real shell, retains it while hidden and reloaded, and closes explicitly', async () => {
    if (scaffold === undefined) throw new Error('Terminal scaffold unavailable')
    const world = scaffold
    onTestFailed(() => saveFailureShot(page, 'web-user-terminal'))
    const tripwire = watchConsole(page)
    const errors: string[] = []
    const capture = (entry: import('playwright').ConsoleMessage): void => { if (entry.type() === 'error') errors.push(entry.text()) }
    page.on('console', capture)
    onTestFinished(() => { page.removeListener('console', capture) })
    onTestFailed(() => { console.error(errors.join('\n'), tripwire.pageErrors.join('\n')) })
    await page.goto(world.baseUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
    const guide = '[data-sidebar-right-guide-entry="terminal"]'
    await page.locator(guide).waitFor()
    await compareOrRefreshGolden(join(DIRECTORY, 'guide.expected.md'), await captureStableAria(page, guide, world.workspaceCwd), webSnapshotMode())
    await page.locator(guide).getByRole('button', { name: /New terminal/ }).click()
    const input = page.getByRole('textbox', { name: 'Terminal', exact: true })
    await input.waitFor()
    await input.fill('echo terminal-browser-proof > terminal-proof.txt')
    await input.press('Enter')
    await expect.poll(async () => readFile(join(world.workspaceCwd, 'terminal-proof.txt'), 'utf8').catch(() => '')).toContain('terminal-browser-proof')
    const inventory = await world.ctx.terminalController.list(SESSION)
    expect(inventory).toHaveLength(1)
    const management = async (method: string, args: object) => {
      const response = await fetch(`${world.baseUrl}/api/terminal/${method}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'terminal-administration', method: `terminal/${method}`, payload: { args } }) })
      expect(response.status).toBe(200)
      return await response.json() as { result: { ok: boolean; value: unknown } }
    }
    const metadata = await management('adminList', {})
    expect(metadata.result).toEqual({ ok: true, value: await world.ctx.terminalController.adminList(new AbortController().signal) })
    expect(metadata.result.value).toEqual([expect.objectContaining({ sessionId: SESSION, id: inventory[0]!.id, state: 'running' })])

    await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
    expect((await world.ctx.terminalController.list(SESSION)).map(item => item.id)).toEqual(inventory.map(item => item.id))
    await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
    await page.reload({ waitUntil: 'load' })
    await input.waitFor()
    expect((await world.ctx.terminalController.list(SESSION)).map(item => item.id)).toEqual(inventory.map(item => item.id))
    await input.fill('echo retained-process-proof >> terminal-proof.txt')
    await input.press('Enter')
    await expect.poll(async () => readFile(join(world.workspaceCwd, 'terminal-proof.txt'), 'utf8')).toContain('retained-process-proof')
    await page.locator('[data-sidebar-right-panel]').getByRole('button', { name: 'Close', exact: true }).click()
    await expect.poll(() => world.ctx.terminalController.list(SESSION)).toEqual([])
    await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
    await page.locator(guide).getByRole('button', { name: /New terminal/ }).click()
    await input.waitFor()
    const [managed] = await world.ctx.terminalController.adminList(new AbortController().signal)
    if (managed === undefined) throw new Error('Administrative inventory lost the live terminal')
    expect((await management('adminClose', { ownerId: managed.ownerId, id: managed.id })).result.ok).toBe(true)
    await expect.poll(() => world.ctx.terminalController.list(SESSION)).toEqual([])
    expect(world.ctx.sessions.get(SESSION)?.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(await page.locator('[data-slot-error]').count()).toBe(0)
  })

  it('owns one regional terminal guide golden', async () => { await assertFixtureInventory(DIRECTORY, ['guide.expected.md']) })
})
