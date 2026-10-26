/** Cold-boot request sharing and authenticated connection readiness; no model calls. */
import { fileURLToPath } from 'node:url'
import type { Browser, Request } from 'playwright'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

/**
 * Both reads are the mirror's: once eagerly at bind time over HTTP, and once
 * on the first-connection reset — that second read closes the window where a
 * document commit lands between the eager read and the SSE subscription and
 * its invalidation is lost. Every settings consumer derives from these two.
 */
const DESCRIBE_BUDGET = 2
const WORKSPACE_LIST_BUDGET = 1

it('shares cold-boot settings and workspace baselines across their consumers', async () => {
  const scaffold = await launchWebScaffold()
  let browser: Browser | undefined
  const failures: unknown[] = []
  try {
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    const consoleWatch = watchConsole(page)
    const calls: string[] = []
    const pending = new Set<Request>()
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (!url.pathname.startsWith('/api/')) return
      calls.push(url.pathname.slice('/api/'.length))
      pending.add(request)
    })
    page.on('requestfinished', request => pending.delete(request))
    page.on('requestfailed', request => pending.delete(request))
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('textbox', { name: 'Choose workspace' }).waitFor({ timeout: 30_000 })
    await expect.poll(() => calls.filter(method => method === 'settings.describe').length).toBe(DESCRIBE_BUDGET)
    await expect.poll(() => pending.size).toBe(0)
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
    }))
    const details = `startup /api calls:\n${calls.join('\n')}`
    expect(calls.filter(method => method === 'settings.describe').length, details).toBe(DESCRIBE_BUDGET)
    expect(calls.filter(method => method === 'workspace.list').length, details).toBe(WORKSPACE_LIST_BUDGET)
    expect(consoleWatch.pageErrors).toEqual([])
  } catch (error) { failures.push(error) } finally {
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold.close().catch((error: unknown) => failures.push(error))
  }
  if (failures.length > 0) throw new AggregateError(failures, 'startup RPC budget failed')
})

it.skipIf(webSnapshotMode() === 'record').each([
  { kind: 'personal' as const },
  { kind: 'project' as const, projectId: 42 },
])('connects both $kind event streams before describe while keeping the chat behind readiness', async (runtimeTarget) => {
  const scaffold = await launchWebScaffold()
  let browser: Browser | undefined
  const release = Promise.withResolvers<undefined>()
  const described = Promise.withResolvers<undefined>()
  const failures: unknown[] = []
  try {
    scaffold.ctx.on('webserver/index-inject', (rows) => {
      rows.push({ kind: 'global', name: '__DSH_DOCUMENT_IDENTITY__', value: {
        version: 1, principalId: 7, runtimeTarget,
      } })
    })
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.addInitScript(() => {
      const opened: string[] = []
      Object.assign(globalThis, { __startupSocketOpens: opened })
      globalThis.WebSocket = new Proxy(WebSocket, {
        construct(target, args) {
          const socket = Reflect.construct(target, args) as WebSocket
          socket.addEventListener('open', () => { opened.push(socket.url) })
          return socket
        },
      })
    })
    const baseline: Record<string, number> = { 'session.list': 0, 'workspace.list': 0 }
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (!path.startsWith('/api/')) return
      const method = path.slice('/api/'.length)
      if (Object.hasOwn(baseline, method)) baseline[method] = (baseline[method] ?? 0) + 1
    })
    await page.route('**/api/host.describe*', async (route) => {
      const response = await route.fetch()
      const reply = await response.json() as { result: { ok: boolean; value: Record<string, unknown> } }
      if (!reply.result.ok) throw new Error('Fixture Host description failed')
      reply.result.value.runtimeTarget = runtimeTarget
      described.resolve(undefined)
      await release.promise
      await route.fulfill({ status: response.status(), json: reply, headers: { 'x-dsh-principal-id': '7' } })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    await described.promise
    const opened = (): Promise<string[]> => page.evaluate(() =>
      (globalThis as typeof globalThis & { __startupSocketOpens: string[] }).__startupSocketOpens)
    await expect.poll(async () => (await opened()).map(value => new URL(value).pathname).toSorted(), { timeout: 30_000 })
      .toEqual(['/api/events.host', '/api/events.mux'])
    for (const value of await opened()) {
      const url = new URL(value)
      expect(url.searchParams.get('dshPrincipal')).toBe('7')
      expect(url.searchParams.get('dshTarget')).toBe(runtimeTarget.kind === 'personal' ? 'personal' : 'project:42')
    }
    const before = { eventSockets: (await opened()).length, sessionBaselines: baseline['session.list'], workspaceBaselines: baseline['workspace.list'] }
    expect(before).toEqual({ eventSockets: 2, sessionBaselines: 0, workspaceBaselines: 0 })
    release.resolve(undefined)
    const workspace = page.getByRole('textbox', { name: 'Choose workspace' })
    await workspace.waitFor()
    const workspacePrompt = await workspace.getAttribute('placeholder')
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const composer = page.locator('textarea:enabled[placeholder="Describe what you want to build"]')
    const model = page.getByRole('button', { name: 'Select model, current DeepSeek-V4-Flash', exact: true })
    await model.waitFor()
    await composer.fill('Draft after authenticated startup')
    const expected = fileURLToPath(new URL(`./expected/startup-document-identity/${runtimeTarget.kind}.expected.md`, import.meta.url))
    await compareOrRefreshGolden(expected, JSON.stringify({
      runtimeTarget,
      beforeDescription: before,
      workspacePrompt,
      selectedModel: await model.getAttribute('aria-label'),
      composerPrompt: await composer.getAttribute('placeholder'),
      composerEnabled: await composer.isEnabled(),
      draft: await composer.inputValue(),
    }, null, 2), webSnapshotMode())
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } catch (error) { failures.push(error) } finally {
    release.resolve(undefined)
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold.close().catch((error: unknown) => failures.push(error))
  }
  if (failures.length > 0) throw new AggregateError(failures, 'authenticated document startup failed')
})
