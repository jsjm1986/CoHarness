/** Shipped Web confirmation through real RPC and the Gateway confirmation controller, with a deterministic authority transport. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { GatewayRequestPrincipal } from '@deepseek-ai/dsh-gateway-runtime'
import { desktopConfirmationController } from '@deepseek-ai/dsh-gateway-execution/src/desktop-confirmation.ts'
import {
  launchWebScaffold, captureStableAria, compareOrRefreshGolden, assertFixtureInventory,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const ROOT = SessionId('desktop-confirmation-root')
const DIRECTORY = fileURLToPath(new URL('./snapshots/desktop-confirmation', import.meta.url))

describe('web e2e: explicit root desktop confirmation', () => {
  let scaffold: WebScaffold | undefined, browser: Browser | undefined, page: Page
  let confirmed = false, rejectSave = false
  const saves: boolean[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const { ctx, workspaceCwd } = scaffold
    const created = await ctx.apiProxy.sessions.create({ rpcId: RpcId('desktop-create'), payload: { sessionId: ROOT, cwd: workspaceCwd } })
    if (!created.result.ok) throw new Error(created.result.error.message)
    const root = ctx.agents.get(ROOT)
    if (root === undefined) throw new Error('Created desktop Session has no Agent')
    const workspace = await ctx.workspaceRegistry.create(workspaceCwd)
    await workspace.attachSession(ROOT)
    const human = { claims: { user: { id: 12 }, expiresAt: Date.now() + 180_000 } } as GatewayRequestPrincipal
    ctx.provide('executionAuthorityRequired', true)
    ctx.provide('computerUseAuthorization', {
      run: async () => { throw new Error('A confirmation gesture must not drive the desktop.') },
      confirmation: desktopConfirmationController({
        interactive: () => human,
        request: async (path, options) => {
          expect(options?.principal).toBe(human)
          const body = JSON.parse(options?.body as string) as Record<string, unknown>
          expect(body.sessionId).toBe(ROOT)
          expect(body.desktop).toBe('display-0')
          if (path.endsWith('/desktop-confirm')) {
            if (rejectSave) return new Response(null, { status: 409 })
            expect(body.expectedNodeId).toBe('acceptance-node')
            expect(typeof body.confirmed).toBe('boolean')
            confirmed = body.confirmed as boolean
            saves.push(confirmed)
            return Response.json({ saved: true })
          }
          expect(path).toBe('/internal/runtime/execution/desktop-confirmation')
          return Response.json({ rootSessionId: ROOT, nodeId: 'acceptance-node', desktop: 'display-0', userId: 12,
            eligible: true, confirmed })
        },
      }, () => root, 'display-0'),
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
  })
  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('shows the exact target, preserves rejected saves and withdraws through the actual page', async () => {
    if (scaffold === undefined) throw new Error('Desktop scaffold unavailable')
    onTestFailed(() => saveFailureShot(page, 'web-desktop-confirmation'))
    const tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Desktop access', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Desktop confirmation', exact: true })
    await dialog.getByText('acceptance-node', { exact: true }).waitFor()
    expect(saves).toEqual([])
    const text = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(DIRECTORY, 'dialog.expected.md'), text, webSnapshotMode())
    rejectSave = true
    await dialog.getByRole('button', { name: 'Confirm this desktop', exact: true }).click()
    await dialog.getByRole('alert').waitFor()
    expect(confirmed).toBe(false)
    expect(saves).toEqual([])
    rejectSave = false
    await dialog.getByRole('button', { name: 'Check again', exact: true }).click()
    await dialog.getByRole('button', { name: 'Confirm this desktop', exact: true }).click()
    await dialog.getByText('You confirmed this root session may use this desktop.', { exact: true }).waitFor()
    expect(confirmed).toBe(true)
    await dialog.getByRole('button', { name: 'Withdraw my confirmation', exact: true }).click()
    await dialog.getByText('You have not confirmed this root session may use this desktop.', { exact: true }).waitFor()
    expect(saves).toEqual([true, false])
    expect(scaffold.ctx.sessions.get(ROOT)?.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    expect(await page.locator('[data-slot-error]').count()).toBe(0)
  })

  it('owns one regional dialog golden', async () => { await assertFixtureInventory(DIRECTORY, ['dialog.expected.md']) })
})
