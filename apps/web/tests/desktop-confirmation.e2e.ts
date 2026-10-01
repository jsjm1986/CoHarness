/** Shipped Web confirmation through real RPC and the Gateway confirmation controller, with a deterministic authority transport. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { GatewayRequestPrincipal } from '@deepseek-ai/dsh-gateway-runtime'
import { desktopConfirmationController } from '@deepseek-ai/dsh-gateway-execution/src/desktop-confirmation.ts'
import {
  launchWebScaffold, captureStableAria, compareOrRefreshGolden, assertFixtureInventory,
  seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const ROOT = SessionId('desktop-confirmation-root')
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const DIRECTORY = fileURLToPath(new URL('./snapshots/desktop-confirmation', import.meta.url))

describe('web e2e: explicit root desktop confirmation', () => {
  let scaffold: WebScaffold | undefined, browser: Browser | undefined, page: Page
  let confirmed = false, rejectSave = false
  const saves: boolean[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const { ctx, workspaceCwd } = scaffold
    // A seeded Session carries committed history, so the sidebar lists it and
    // landing opens it — the live Agent arrives with that ordinary resume.
    await seedSession(scaffold, await readFile(SEED, 'utf8'), ROOT)
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
            eligible: true, confirmed, occupancy: { available: true, inUse: false, heldByThisSession: false, queued: 0 } })
        },
      }, agent => agent, 'display-0'),
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
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    // Landing restores the seeded Session; its transcript marker proves the
    // session view (and with it the session header) is mounted.
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 30_000 })
    // The confirmation RPC resolves the Session's live Agent, which the open
    // resume publishes asynchronously — wait for it before reading status.
    await expect.poll(() => scaffold?.ctx.agents.get(ROOT) !== undefined, { timeout: 15_000 }).toBe(true)
    const turnStarts = () => scaffold?.ctx.sessions.get(ROOT)?.snapshotEvents()
      .filter(event => event.type === 'turn/start').length
    const baseline = turnStarts()
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
    expect(turnStarts()).toBe(baseline)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    expect(await page.locator('[data-slot-error]').count()).toBe(0)
  })

  it('owns one regional dialog golden', async () => { await assertFixtureInventory(DIRECTORY, ['dialog.expected.md']) })
})
