/** Assembled shell contributions with isolated HTTP adapters for account usage and native launches. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Browser, Locator, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT, saveFailureShot } from './support.ts'
import { responsiveBrowser } from './responsive-browser.ts'
import { auditWorkflowState, compareWorkflowGolden, newWorkflowPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'
import { captureTextContrast, expectTextContrast } from './text-contrast.ts'

interface UsagePayload {
  month: string
  alerts: Array<{ metric: 'tokens' | 'company-cost'; threshold: 80 | 100; createdAt: number }>
}

function history(): string {
  const session = Session.create(SessionId('auxiliary-shell-source'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { stream: [], turn: 1, step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'Auxiliary shell acceptance is ready.' }],
      source: { provider: 'fixture', model: 'fixture' } }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
    cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

describe('web e2e: auxiliary shell contributions', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let scratch: string
  let sessionId: Awaited<ReturnType<typeof seedSession>>
  let apps: readonly string[] = []
  let appsStatus = 200
  let usage: UsagePayload = { month: '2026-11', alerts: [] }
  let usageStatus = 200
  let launchStatus = 200
  let launchGate: Promise<void> | undefined
  let releaseLaunch: (() => void) | undefined
  const launches: Array<{ app: string; path: string }> = []

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-auxiliary-shell-'))
    const overlay = join(scratch, 'plugins.patch.yml')
    // The native launcher stays disabled. Only its browser contribution is mounted under a fixture-owned row.
    await writeFile(overlay, [
      '- insert:',
      '    - id: auxiliary-open-in-app',
      "      name: '@deepseek-ai/dsh-client-ui-open-in-app'",
      '    - id: auxiliary-usage-alert',
      "      name: '@deepseek-ai/dsh-client-ui-usage-alert'", '',
    ].join('\n'))
    scaffold = await launchWebScaffold({ openInApp: false, extraOverlayPath: overlay,
      extraInstallAnchors: ['ui-open-in-app', 'ui-usage-alert'].map(name => join(REPO_ROOT, 'packages/client', name, 'package.json')) })
    const register = (path: string, handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) => {
      scaffold.ctx.effect(() => scaffold.ctx.webServer.register({ kind: 'exact', path, handler: (request, response) => {
        const rejection = scaffold.ctx.connection.requestRejection(request)
        if (rejection !== undefined) { response.writeHead(rejection); response.end(); return }
        return handler(request, response)
      } }), `auxiliary acceptance: ${path}`)
    }
    const json = (response: ServerResponse, status: number, value: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(value))
    }
    register('/open-in-app/apps', (_request, response) => { json(response, appsStatus, { apps }) })
    for (const id of ['vscode', 'cursor']) register(`/open-in-app/icon/${id}`, (_request, response) => {
      response.writeHead(404); response.end()
    })
    register('/open-in-app/open', async (request, response) => {
      expect(request.method).toBe('POST')
      request.setEncoding('utf8')
      let body = ''
      for await (const chunk of request as AsyncIterable<string>) body += chunk
      const value = JSON.parse(body) as { app: string; path: string }
      expect(value.path).toBe(scaffold.workspaceCwd)
      expect(apps).toContain(value.app)
      launches.push(value)
      await launchGate
      json(response, launchStatus, launchStatus === 200 ? { ok: true } : { code: 'launch-failed' })
    })
    register('/account/api/usage', (_request, response) => { json(response, usageStatus, usage) })
    sessionId = await seedSession(scaffold, history(), 'auxiliary-shell')
    browser = await responsiveBrowser.launch()
  }, 120_000)
  afterAll(async () => {
    releaseLaunch?.()
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally { if (scratch) await rm(scratch, { recursive: true, force: true }) }
    }
  })

  async function open(choice?: string): Promise<{ page: Page; tripwire: ReturnType<typeof watchConsole> }> {
    const page = await newWorkflowPage(browser)
    const tripwire = watchConsole(page)
    page.setDefaultTimeout(15_000)
    await page.addInitScript(({ id, chosen }) => {
      if (window !== window.top) return
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
      if (chosen !== undefined && localStorage.getItem('dsh.open-in-app.choice') === null) {
        localStorage.setItem('dsh.open-in-app.choice', JSON.stringify(chosen))
      }
    }, { id: sessionId, chosen: choice })
    const available = page.waitForResponse(response => new URL(response.url()).pathname === '/open-in-app/apps')
    const account = page.waitForResponse(response => new URL(response.url()).pathname === '/account/api/usage')
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    await Promise.all([available, account])
    await page.getByText('Auxiliary shell acceptance is ready.', { exact: true }).waitFor()
    return { page, tripwire }
  }

  async function activate(control: Locator): Promise<void> {
    if (workflowMatrixEnabled) await control.tap()
    else await control.click()
  }

  it('opens the app menu, remembers successful choices and ignores repeated launches while busy', async () => {
    apps = ['vscode', 'cursor', 'unnameable-fixture-app']; appsStatus = 200; launchStatus = 200
    const { page, tripwire } = await open('removed-app')
    try {
      const choose = page.getByRole('button', { name: 'Choose an app to open in', exact: true })
      const split = choose.locator('..')
      await page.getByRole('button', { name: 'Open workspace in VS Code', exact: true }).waitFor()
      await auditWorkflowState(page, 'open-in-app', 'available-fallback', split, [], undefined, async () => {
        for (const control of await split.getByRole('button').all()) {
          const box = await control.boundingBox()
          expect(box?.width, 'Open in app touch width').toBeGreaterThanOrEqual(44)
          expect(box?.height, 'Open in app touch height').toBeGreaterThanOrEqual(44)
        }
      })
      await activate(choose)
      const menu = page.getByRole('menu')
      await menu.getByRole('menuitem', { name: 'Cursor', exact: true }).waitFor()
      expect(await menu.getByRole('menuitem').count()).toBe(2)
      expectTextContrast(await captureTextContrast(page,
        (await menu.getByRole('menuitem').all()).map((item, index) => ({
          label: `application-${index}`, text: item.locator('[class*="itemLabel"]'),
        })), 'open-in-app-menu'))
      await auditWorkflowState(page, 'open-in-app', 'application-menu', menu)
      await compareWorkflowGolden(join(REPO_ROOT, 'apps/web/tests/expected/auxiliary-shell/apps.expected.md'), await menu.ariaSnapshot(), webSnapshotMode())
      await activate(menu.getByRole('menuitem', { name: 'Cursor', exact: true }))
      const current = page.getByRole('button', { name: 'Open workspace in Cursor', exact: true })
      await current.waitFor()
      expect(launches.at(-1)).toEqual({ app: 'cursor', path: scaffold.workspaceCwd })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await current.waitFor()
      await auditWorkflowState(page, 'open-in-app', 'remembered-choice', split)
      const before = launches.length
      launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve })
      await activate(current)
      await expect.poll(() => current.isDisabled()).toBe(true)
      await activate(choose)
      await activate(menu.getByRole('menuitem', { name: 'VS Code', exact: true }))
      expect(launches.length).toBe(before + 1)
      await auditWorkflowState(page, 'open-in-app', 'launch-pending', split)
      releaseLaunch?.(); launchGate = undefined
      await expect.poll(() => current.isDisabled()).toBe(false)
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.open-in-app.choice') ?? 'null') as string | null)).toBe('cursor')
      launchStatus = 502
      await activate(choose)
      await activate(menu.getByRole('menuitem', { name: 'VS Code', exact: true }))
      await page.getByRole('button', { name: 'Failed to open', exact: true }).waitFor()
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.open-in-app.choice') ?? 'null') as string | null)).toBe('cursor')
      await current.waitFor()
      await auditWorkflowState(page, 'open-in-app', 'failed-launch-preserves-choice', split)
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(page, 'auxiliary-open-in-app'); throw error }
    finally { releaseLaunch?.(); launchGate = undefined; launchStatus = 200; await page.close() }
  }, 240_000)

  it('omits the launcher when availability is empty, unavailable, or contains only unknown applications', async () => {
    for (const scenario of [
      { state: 'no-applications', apps: [], status: 200 },
      { state: 'unnameable-applications', apps: ['unnameable-fixture-app'], status: 200 },
      { state: 'availability-failed', apps: ['vscode'], status: 503 },
    ]) {
      apps = scenario.apps; appsStatus = scenario.status
      const { page, tripwire } = await open()
      try {
        expect(await page.getByRole('button', { name: 'Choose an app to open in', exact: true }).count()).toBe(0)
        await auditWorkflowState(page, 'open-in-app', scenario.state, page.locator('[data-conversation-region="chat"]'))
        expect(tripwire.pageErrors).toEqual([])
      } finally { await page.close() }
    }
    appsStatus = 200
  }, 180_000)

  it('reads threshold notices and keeps the shell usable when the account read fails or has no alerts', async () => {
    apps = []; appsStatus = 200
    for (const scenario of [
      { state: 'token-warning', alerts: [{ metric: 'tokens' as const, threshold: 80 as const, createdAt: 1 }], status: 200 },
      { state: 'all-thresholds', alerts: (['tokens', 'company-cost'] as const).flatMap(metric =>
        ([80, 100] as const).map(threshold => ({ metric, threshold, createdAt: 1 }))), status: 200 },
      { state: 'no-alerts', alerts: [], status: 200 },
      { state: 'usage-unavailable', alerts: [], status: 503 },
    ]) {
      usage = { month: '2026-11', alerts: scenario.alerts }; usageStatus = scenario.status
      const { page, tripwire } = await open()
      try {
        const notices = page.locator('[aria-live="polite"]').filter({ has: page.getByRole('status').filter({ hasText: 'usage alert' }) })
        if (scenario.alerts.length > 0) {
          await expect.poll(() => notices.getByRole('status').count()).toBe(scenario.alerts.length)
          expectTextContrast(await captureTextContrast(page,
            (await notices.getByRole('status').all()).flatMap((notice, index) => [
              { label: `heading-${index}`, text: notice.locator('strong') },
              { label: `body-${index}`, text: notice.locator(':scope > span') },
            ]), `usage-${scenario.state}`))
          await auditWorkflowState(page, 'usage-alert', scenario.state, notices, await notices.getByRole('status').all())
          await compareWorkflowGolden(join(REPO_ROOT, `apps/web/tests/expected/auxiliary-shell/${scenario.state}.expected.md`), await notices.ariaSnapshot(), webSnapshotMode())
        } else {
          expect(await notices.count()).toBe(0)
          await auditWorkflowState(page, 'usage-alert', scenario.state, page.locator('[data-conversation-region="chat"]'))
        }
        await activate(page.getByRole('button', { name: 'Settings', exact: true }))
        const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
        await dialog.waitFor()
        await activate(dialog.getByRole('button', { name: 'Close', exact: true }))
        expect(tripwire.pageErrors).toEqual([])
      } catch (error) { await saveFailureShot(page, `usage-${scenario.state}`); throw error }
      finally { await page.close() }
    }
    usage = { month: '2026-11', alerts: [] }; usageStatus = 200
  }, 240_000)
})
