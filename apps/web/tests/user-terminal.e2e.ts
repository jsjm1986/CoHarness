/** Shipped terminal tabs use real PTYs and Remote streams without starting model turns. */
import { responsiveBrowser, responsiveBrowserName, responsiveMobileEmulation, responsiveViewports, expectViewportFit } from './responsive-browser.ts'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, type Locator, type Page, type Request, type Route } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import {
  launchWebScaffold, captureStableAria, assertFixtureInventory,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'
import { auditWorkflowState, compareWorkflowGolden, newWorkflowPage } from './workflow-responsive-state.ts'

const SESSION = SessionId('user-terminal-root')
const DIRECTORY = fileURLToPath(new URL('./snapshots/user-terminal', import.meta.url))

/** WebKit reports the outgoing document's cancelled retention fetch as a page error. */
async function reloadRetainedTerminal(page: Page, tripwire: ReturnType<typeof watchConsole>): Promise<void> {
  const errorStart = tripwire.pageErrors.length
  const origin = new URL(page.url()).origin
  const cancelled = new Set<string>()
  const observe = (request: Request): void => {
    const url = new URL(request.url())
    if (url.origin === origin && url.pathname === '/api/_stream/terminal/retain'
      && request.failure()?.errorText === 'cancelled') cancelled.add(url.href)
  }
  page.on('requestfailed', observe)
  try { await page.reload({ waitUntil: 'load' }) }
  finally { page.off('requestfailed', observe) }
  const errors = tripwire.pageErrors.splice(errorStart)
  tripwire.pageErrors.push(...errors.filter((error) => {
    const match = /^(?:TypeError: )?Fetch API cannot load (.+) due to access control checks\.$/u.exec(error)
    const url = match?.[1]?.replace(/^(https?): \//u, '$1://')
    return url === undefined || !cancelled.has(url)
  }))
}

/** Hold the first real input acknowledgement while the remaining command is typed. */
async function typeBehindPendingInput(page: Page, input: Locator, outputPath: string): Promise<number> {
  const accepted = Promise.withResolvers<undefined>()
  const firstReply = accepted.promise.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }))
  const release = Promise.withResolvers<undefined>()
  const operations = new Set<Promise<void>>()
  const errors: unknown[] = []
  const origin = new URL(page.url()).origin
  const inputRequest = (url: URL): boolean => url.origin === origin && url.pathname === '/api/terminal/write'
  let requests = 0
  const handler = (route: Route): Promise<void> => {
    const first = requests++ === 0
    const operation = (async () => {
      const response = await route.fetch()
      if (first) {
        if (response.status() !== 200) throw new Error('Terminal input was not admitted')
        accepted.resolve(undefined)
        await release.promise
      }
      await route.fulfill({ response })
    })()
    operations.add(operation)
    void operation.then(() => { operations.delete(operation) }, (error: unknown) => {
      operations.delete(operation)
      errors.push(error)
      if (first) accepted.reject(error)
    })
    return operation
  }
  await page.route(inputRequest, handler)
  try {
    await expect.poll(() => input.isEditable()).toBe(true)
    await input.press('e')
    await expect.poll(() => requests).toBe(1)
    const first = await firstReply
    if (!first.ok) throw first.error
    await input.pressSequentially('cho terminal-browser-proof > terminal-proof.txt')
    await input.press('Enter')
    expect(requests).toBe(1)
    release.resolve(undefined)
    await expect.poll(() => readFile(outputPath, 'utf8').catch(() => ''))
      .toBe('terminal-browser-proof\n')
    await expect.poll(() => operations.size).toBe(0)
    return requests
  } finally {
    release.resolve(undefined)
    await page.unroute(inputRequest, handler)
    await Promise.allSettled([...operations])
    if (errors.length > 0) throw new AggregateError(errors, 'Terminal input fixture failed')
  }
}

describe('web e2e: private user terminal lifecycle', () => {
  let scaffold: WebScaffold | undefined, browser: Browser | undefined
  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./user-terminal-typing.overlay.yml', import.meta.url)),
    })
    const result = await scaffold.ctx.apiProxy.sessions.create({ rpcId: RpcId('terminal-create'), payload: { sessionId: SESSION, cwd: scaffold.workspaceCwd } })
    if (!result.result.ok) throw new Error(result.result.error.message)
    await (await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)).attachSession(SESSION)
    const executablePath = process.env.DSH_TEST_BROWSER_EXECUTABLE
    browser = await responsiveBrowser.launch(executablePath === undefined ? {} : { executablePath })
  })
  afterEach(async () => {
    if (scaffold === undefined) return
    const { ctx } = scaffold
    const terminals = await ctx.terminalController.list(SESSION)
    if (terminals.length === 0) return
    const agent = ctx.agents.get(SESSION)
    if (agent === undefined) throw new Error('The fixture terminal has no live owner')
    await Promise.all(terminals.map(terminal => ctx.terminalController.close(agent, terminal.id)))
  })
  afterAll(async () => { try { await browser?.close() } finally { await scaffold?.close() } })

  it('writes through the live terminal WebSocket and receives a Host acknowledgement', async () => {
    if (scaffold === undefined || browser === undefined) throw new Error('Terminal scaffold unavailable')
    const proof = await newWorkflowPage(browser)
    onTestFinished(() => proof.context().close())
    let receivedAck = false
    let fallbackWrites = 0
    proof.on('websocket', (socket) => {
      if (new URL(socket.url()).pathname !== '/api/terminal/input') return
      const writes = new Set<number>()
      socket.on('framesent', ({ payload }) => {
        if (typeof payload !== 'string') return
        const frame = JSON.parse(payload) as { type: string; seq: number }
        if (frame.type === 'write') writes.add(frame.seq)
      })
      socket.on('framereceived', ({ payload }) => {
        if (typeof payload !== 'string') return
        const frame = JSON.parse(payload) as { type: string; seq: number }
        if (frame.type === 'ack' && writes.has(frame.seq)) receivedAck = true
      })
    })
    proof.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/terminal/write') fallbackWrites += 1
    })
    await proof.addInitScript(() => {
      const NativeWebSocket = window.WebSocket
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          if (new URL(this.url).pathname === '/api/terminal/input') {
            this.addEventListener('open', () => { document.documentElement.dataset.terminalInputReady = 'true' })
          }
        }
      }
    })
    await proof.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await proof.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
    await proof.locator('[data-sidebar-right-guide-entry="terminal"]').getByRole('button', { name: /New terminal/ }).click()
    const input = proof.getByRole('textbox', { name: 'Terminal', exact: true })
    await proof.locator('html[data-terminal-input-ready="true"]').waitFor({ state: 'attached' })
    await input.fill('echo websocket-ok > terminal-websocket-proof.txt')
    await input.press('Enter')
    const output = join(scaffold.workspaceCwd, 'terminal-websocket-proof.txt')
    await expect.poll(() => readFile(output, 'utf8').catch(() => '')).toBe('websocket-ok\n')
    await expect.poll(() => receivedAck).toBe(true)
    expect(fallbackWrites).toBe(0)
  })

  it('writes through a real shell, retains it while hidden and reloaded, and closes explicitly', async () => {
    if (scaffold === undefined || browser === undefined) throw new Error('Terminal scaffold unavailable')
    const world = scaffold
    const page = await newWorkflowPage(browser)
    onTestFinished(() => page.context().close())
    await page.routeWebSocket(/\/api\/terminal\/input(?:\?|$)/u, socket => socket.close({ code: 1013 }))
    onTestFailed(() => saveFailureShot(page, 'web-user-terminal'))
    const tripwire = watchConsole(page)
    const errors: string[] = []
    let phase = 'opening terminal'
    const capture = (entry: import('playwright').ConsoleMessage): void => { if (entry.type() === 'error') errors.push(entry.text()) }
    const captureFailure = (error: Error): void => { errors.push(`${phase}: ${error.stack ?? String(error)}`) }
    page.on('console', capture)
    page.on('pageerror', captureFailure)
    onTestFinished(() => { page.removeListener('console', capture); page.removeListener('pageerror', captureFailure) })
    onTestFailed(() => { console.error(errors.join('\n'), tripwire.pageErrors.join('\n')) })
    await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
    const guide = '[data-sidebar-right-guide-entry="terminal"]'
    await page.locator(guide).waitFor()
    await compareWorkflowGolden(join(DIRECTORY, 'guide.expected.md'), await captureStableAria(page, guide, world.workspaceCwd), webSnapshotMode())
    await page.locator(guide).getByRole('button', { name: /New terminal/ }).click()
    const input = page.getByRole('textbox', { name: 'Terminal', exact: true })
    await input.waitFor()
    const panel = page.locator('[data-sidebar-right-panel]')
    const inputRequests = await typeBehindPendingInput(page, input, join(world.workspaceCwd, 'terminal-proof.txt'))
    console.info('[terminal-input]', JSON.stringify({ inputRequests }))
    await compareWorkflowGolden(join(DIRECTORY, 'input.expected.md'), JSON.stringify({
      inputRequests,
      deliveredCommandOutput: await readFile(join(world.workspaceCwd, 'terminal-proof.txt'), 'utf8'),
    }, null, 2), webSnapshotMode())
    const inventory = await world.ctx.terminalController.list(SESSION)
    expect(inventory).toHaveLength(1)
    const release = Promise.withResolvers<undefined>()
    let firstInputReady = false
    let queuedRequests = 0
    const inputRoute = /\/api\/terminal\/write(?:\?.*)?$/
    await page.route(inputRoute, async (route) => {
      queuedRequests += 1
      const response = await route.fetch()
      if (queuedRequests === 1) {
        firstInputReady = true
        await release.promise
      }
      await route.fulfill({ response })
    })
    try {
      await input.fill('printf ')
      await expect.poll(() => firstInputReady).toBe(true)
      await page.keyboard.type('QA_界_BATCH > terminal-batch-proof.txt')
      await input.press('Enter')
      expect(queuedRequests).toBe(1)
      await auditWorkflowState(page, 'terminal', 'input-queued-behind-acknowledgement', panel, [input], async () => {
        expect(queuedRequests).toBe(1)
      })
      release.resolve(undefined)
      await expect.poll(async () => readFile(join(world.workspaceCwd, 'terminal-batch-proof.txt'), 'utf8').catch(() => '')).toBe('QA_界_BATCH')
      expect(queuedRequests).toBe(2)
      await compareWorkflowGolden(join(DIRECTORY, 'queued-input.expected.md'),
        `Queued input RPCs: ${queuedRequests}\n\nTerminal file: ${await readFile(join(world.workspaceCwd, 'terminal-batch-proof.txt'), 'utf8')}`, webSnapshotMode())
    } finally {
      release.resolve(undefined)
      await page.unroute(inputRoute)
    }
    await auditWorkflowState(page, 'terminal', 'live-output-after-queued-command', panel, [input])
    const management = async (method: string, args: object) => {
      const response = await world.hostFetch(`/api/terminal/${method}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'terminal-administration', method: `terminal/${method}`, payload: { args } }) })
      expect(response.status).toBe(200)
      return await response.json() as { result: { ok: boolean; value: unknown } }
    }
    const metadata = await management('adminList', {})
    expect(metadata.result).toEqual({ ok: true, value: await world.ctx.terminalController.adminList(new AbortController().signal) })
    expect(metadata.result.value).toEqual([expect.objectContaining({ sessionId: SESSION, id: inventory[0]!.id, state: 'running' })])

    await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
    expect((await world.ctx.terminalController.list(SESSION)).map(item => item.id)).toEqual(inventory.map(item => item.id))
    await auditWorkflowState(page, 'terminal', 'hidden-retained-process', page.locator('[data-viewport]').first(),
      [page.getByRole('button', { name: 'Open right sidebar', exact: true })], async () => {
        expect((await world.ctx.terminalController.list(SESSION)).map(item => item.id)).toEqual(inventory.map(item => item.id))
        if ((page.viewportSize()?.width ?? 0) < 768) {
          const drawer = page.locator('[class*="drawer"]').first()
          expect(await drawer.evaluate(node => node instanceof HTMLElement && node.inert)).toBe(true)
          await page.getByRole('button', { name: 'Open right sidebar', exact: true }).focus()
          await page.keyboard.press('Tab')
          expect(await drawer.evaluate(node => node.contains(document.activeElement))).toBe(false)
        }
      })
    await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
    await auditWorkflowState(page, 'terminal', 'revealed-retained-process', panel, [input], async () => {
      expect((await world.ctx.terminalController.list(SESSION)).map(item => item.id)).toEqual(inventory.map(item => item.id))
    })
    phase = 'reloading the retained terminal'
    await reloadRetainedTerminal(page, tripwire)
    await input.waitFor()
    phase = 'writing to the retained terminal'
    expect((await world.ctx.terminalController.list(SESSION)).map(item => item.id)).toEqual(inventory.map(item => item.id))
    await input.fill('echo retained-process-proof >> terminal-proof.txt')
    await input.press('Enter')
    await expect.poll(async () => readFile(join(world.workspaceCwd, 'terminal-proof.txt'), 'utf8')).toContain('retained-process-proof')
    await auditWorkflowState(page, 'terminal', 'reloaded-retained-process', panel, [input], async () => {
      expect((await world.ctx.terminalController.list(SESSION)).map(item => item.id)).toEqual(inventory.map(item => item.id))
    })
    phase = 'closing the retained terminal'
    await page.locator('[data-sidebar-right-panel]').getByRole('button', { name: 'Close', exact: true }).click()
    await expect.poll(() => world.ctx.terminalController.list(SESSION), { timeout: 15_000 }).toEqual([])
    await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
    await page.locator(guide).getByRole('button', { name: /New terminal/ }).click()
    await input.waitFor()
    phase = 'administratively closing the new terminal'
    const [managed] = await world.ctx.terminalController.adminList(new AbortController().signal)
    if (managed === undefined) throw new Error('Administrative inventory lost the live terminal')
    expect((await management('adminClose', { ownerId: managed.ownerId, id: managed.id })).result.ok).toBe(true)
    await expect.poll(() => world.ctx.terminalController.list(SESSION), { timeout: 15_000 }).toEqual([])
    expect(world.ctx.sessions.get(SESSION)?.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(await page.locator('[data-slot-error]').count()).toBe(0)
  })

  it.each(responsiveViewports)('$name operates and closes a real PTY without clipping its surface', async ({ name, width, height }) => {
    if (scaffold === undefined || browser === undefined) throw new Error('Terminal scaffold unavailable')
    const world = scaffold
    const terminalPage = await browser.newPage({ viewport: { width, height }, locale: 'en-US', hasTouch: true,
      isMobile: responsiveMobileEmulation && width < 768, reducedMotion: 'reduce' })
    const tripwire = watchConsole(terminalPage)
    const screenshots = process.env.DSH_MOBILE_SCREENSHOTS ?? process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
    try {
      await terminalPage.goto(world.authenticatedUrl, { waitUntil: 'load' })
      await terminalPage.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
      await terminalPage.locator('[data-sidebar-right-guide-entry="terminal"]').getByRole('button', { name: /New terminal/ }).click()
      const input = terminalPage.getByRole('textbox', { name: 'Terminal', exact: true })
      await input.waitFor()
      const panel = terminalPage.locator('[data-sidebar-right-panel]')
      const screen = panel.locator('.xterm-screen')
      await expectViewportFit(terminalPage, panel, [panel.getByRole('button', { name: 'Close', exact: true })])
      await expectViewportFit(terminalPage, screen)
      await screen.tap()
      await expect.poll(() => input.evaluate(node => node === document.activeElement)).toBe(true)
      const proof = `terminal-${width}-${height}.txt`
      await input.fill(`printf 'responsive-terminal-${name}' > ${proof}`)
      await input.press('Enter')
      await expect.poll(() => readFile(join(world.workspaceCwd, proof), 'utf8').catch(() => '')).toBe(`responsive-terminal-${name}`)
      const tab = panel.locator('[data-dockkit-tab]')
      await panel.locator('[data-dockkit-tab-actions]').tap()
      await terminalPage.getByRole('menuitem', { name: /^Rename terminal/ }).tap()
      const editor = terminalPage.getByRole('textbox', { name: 'Terminal name', exact: true })
      await expectViewportFit(terminalPage, panel, [editor])
      expect((await editor.boundingBox())?.height).toBeGreaterThanOrEqual(44)
      expect(await editor.evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16)
      await expect.poll(() => editor.evaluate(node => node === document.activeElement)).toBe(true)
      await editor.fill(`Touch ${name}`)
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        await terminalPage.screenshot({ path: join(screenshots, `terminal-${responsiveBrowserName}-${name}-rename.png`), animations: 'disabled' })
      }
      await editor.press('Enter')
      await expect.poll(async () => (await world.ctx.terminalController.list(SESSION))[0]?.title).toBe(`Touch ${name}`)
      await tab.focus()
      await tab.press('F2')
      await editor.fill('Cancelled keyboard rename')
      await editor.press('Escape')
      expect((await world.ctx.terminalController.list(SESSION))[0]?.title).toBe(`Touch ${name}`)
      const before = await world.ctx.terminalController.list(SESSION)
      expect(before).toHaveLength(1)
      await terminalPage.setViewportSize({ width: height, height: width })
      await expectViewportFit(terminalPage, screen)
      await screen.tap()
      await expect.poll(() => input.evaluate(node => node === document.activeElement)).toBe(true)
      expect((await world.ctx.terminalController.list(SESSION)).map(item => item.id)).toEqual(before.map(item => item.id))
      await input.fill(`printf '\nrotation-retained' >> ${proof}`)
      await input.press('Enter')
      await expect.poll(() => readFile(join(world.workspaceCwd, proof), 'utf8')).toContain('rotation-retained')
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        await terminalPage.screenshot({ path: join(screenshots, `terminal-${responsiveBrowserName}-${name}.png`), animations: 'disabled' })
      }
      await panel.getByRole('button', { name: 'Close', exact: true }).click()
      await expect.poll(() => world.ctx.terminalController.list(SESSION), { timeout: 15_000 }).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(terminalPage, `terminal-${responsiveBrowserName}-${name}`)
      throw error
    } finally { await terminalPage.close() }
  })

  it('keeps shell discovery explanations, exited processes and failed cleanup actionable', async () => {
    if (scaffold === undefined || browser === undefined) throw new Error('Terminal scaffold unavailable')
    const world = scaffold
    const target = await browser.newPage({ viewport: { width: 1680, height: 900 }, locale: 'en-US', hasTouch: true,
      isMobile: responsiveMobileEmulation, reducedMotion: 'reduce' })
    const tripwire = watchConsole(target)
    const discovery = vi.spyOn(world.ctx.terminalController, 'shells')
    const closing = vi.spyOn(world.ctx.terminalController, 'close')
    const listed = Promise.withResolvers<undefined>()
    try {
      await target.goto(world.authenticatedUrl, { waitUntil: 'load' })
      await target.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
      const choose = target.getByRole('button', { name: 'Choose shell', exact: true })
      const menu = target.getByRole('menu')
      const auditFeedback = async (state: string, feedback: Locator) => {
        await feedback.waitFor()
        expect(await feedback.evaluate(node => node.closest('button') === null)).toBe(true)
        await auditWorkflowState(target, 'terminal', state, menu, [feedback], async () => {
          expect(await feedback.evaluate((node) => {
            const element = node as HTMLElement
            return Math.max(element.scrollWidth - element.clientWidth, element.scrollHeight - element.clientHeight)
          })).toBe(0)
        })
      }
      discovery.mockImplementationOnce(async () => { await listed.promise; return [] })
      await choose.tap()
      await auditFeedback('shell-discovery-loading', menu.getByText('Loading shells…', { exact: true }))
      listed.resolve(undefined)
      await auditFeedback('shell-discovery-empty', menu.getByText('No shells available', { exact: true }))
      expect(await menu.getByRole('menuitem').count()).toBe(0)
      await target.keyboard.press('Escape')
      discovery.mockRejectedValueOnce(new RemoteError('terminal/forbidden', 'Fixture user has no terminal qualification', {}))
      await choose.tap()
      await auditFeedback('shell-discovery-forbidden', menu.getByRole('status'))
      expect(await menu.getByRole('menuitem').count()).toBe(0)
      await target.keyboard.press('Escape')
      discovery.mockRejectedValueOnce(new Error('Shell discovery temporarily unavailable'))
      await choose.tap()
      await auditFeedback('shell-discovery-failed', menu.getByRole('status'))
      await menu.getByRole('menuitem', { name: 'Retry', exact: true }).tap()
      await menu.getByRole('menuitem').first().waitFor()
      await auditWorkflowState(target, 'terminal', 'shell-discovery-ready', menu)
      await menu.getByRole('menuitem').first().tap()
      const input = target.getByRole('textbox', { name: 'Terminal', exact: true })
      await input.waitFor()
      const panel = target.locator('[data-sidebar-right-panel]')
      await expect.poll(() => panel.locator('[data-sidebar-terminal]').getByRole('status').count()).toBe(0)
      await input.fill('exit 0')
      await input.press('Enter')
      await panel.getByRole('status').filter({ hasText: 'Process exited (0)' }).waitFor()
      await auditWorkflowState(target, 'terminal', 'process-exited', panel,
        [panel.getByRole('button', { name: 'New terminal', exact: true })])
      closing.mockRejectedValueOnce(new Error('Host cleanup temporarily unavailable'))
      await panel.getByRole('button', { name: 'Close', exact: true }).tap()
      const failure = target.getByRole('alert').filter({ hasText: 'could not be ended' })
      const retry = failure.getByRole('button', { name: 'Retry', exact: true })
      await failure.waitFor()
      await auditWorkflowState(target, 'terminal', 'cleanup-failed', failure, [retry], async () => {
        const box = await retry.boundingBox()
        expect(box?.height).toBeGreaterThanOrEqual(44)
        expect(box?.width).toBeGreaterThanOrEqual(44)
      })
      await retry.tap()
      await failure.waitFor({ state: 'hidden' })
      await expect.poll(() => world.ctx.terminalController.list(SESSION)).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(target, `terminal-${responsiveBrowserName}-discovery-cleanup`)
      throw error
    } finally {
      listed.resolve(undefined)
      discovery.mockRestore(); closing.mockRestore()
      await target.close()
    }
  })

  it('retries composer terminal recovery after a failed list without replacing the retained PTY', async () => {
    if (scaffold === undefined || browser === undefined) throw new Error('Terminal scaffold unavailable')
    const world = scaffold
    const target = await newWorkflowPage(browser)
    const tripwire = watchConsole(target)
    let closeTerminal: (() => Promise<void>) | undefined
    try {
      await target.goto(world.authenticatedUrl, { waitUntil: 'load' })
      await target.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
      await target.locator('[data-sidebar-right-guide-entry="terminal"]').getByRole('button', { name: /New terminal/ }).click()
      const input = target.getByRole('textbox', { name: 'Terminal', exact: true })
      await input.waitFor()
      const [retained] = await world.ctx.terminalController.list(SESSION)
      const agent = world.ctx.agents.get(SESSION)
      if (retained === undefined || agent === undefined) throw new Error('The private terminal has no live owner')
      closeTerminal = () => world.ctx.terminalController.close(agent, retained.id)
      const proof = join(world.workspaceCwd, 'terminal-recovery-proof.txt')
      await input.fill('printf before > terminal-recovery-proof.txt')
      await input.press('Enter')
      await expect.poll(() => readFile(proof, 'utf8').catch(() => '')).toBe('before')
      let refuseLookup = true
      await target.route(url => url.pathname === '/api/terminal/list', async (route) => {
        const response = await route.fetch()
        if (!refuseLookup) { await route.fulfill({ response }); return }
        const body = await response.json() as Record<string, unknown>
        await route.fulfill({ response, json: { ...body, result: { ok: false, error: {
          code: 'internal', message: 'Retained terminal lookup temporarily unavailable', details: {},
        } } } })
      })
      await reloadRetainedTerminal(target, tripwire)
      const retry = target.getByRole('button', { name: 'Retry terminal recovery', exact: true })
      await retry.waitFor()
      expect(await retry.getAttribute('title')).toContain('Retained terminal lookup temporarily unavailable')
      await auditWorkflowState(target, 'terminal', 'composer-recovery-failed', target.locator('[data-composer-card]'), [retry])
      await compareWorkflowGolden(join(DIRECTORY, 'recovery.expected.md'), await retry.ariaSnapshot(), webSnapshotMode())
      refuseLookup = false
      const [recovered] = await Promise.all([
        target.waitForResponse(response => new URL(response.url()).pathname === '/api/terminal/list'),
        retry.click(),
      ])
      expect((await recovered.json() as { result: { ok: boolean } }).result.ok).toBe(true)
      await retry.waitFor({ state: 'hidden' })
      const openSidebar = target.getByRole('button', { name: 'Open right sidebar', exact: true })
      if (await openSidebar.isVisible()) await openSidebar.click()
      await input.waitFor()
      expect((await world.ctx.terminalController.list(SESSION)).map(info => info.id)).toEqual([retained.id])
      await input.fill('printf after >> terminal-recovery-proof.txt')
      await input.press('Enter')
      await expect.poll(() => readFile(proof, 'utf8')).toBe('beforeafter')
      await auditWorkflowState(target, 'terminal', 'composer-recovery-restored', target.locator('[data-sidebar-right-panel]'), [input])
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(target, 'terminal-composer-recovery'); throw error }
    finally { try { await closeTerminal?.() } finally { await target.close() } }
  })

  it('copies a real PTY output selection through the xterm copy handler with a desktop pointer', async () => {
    if (scaffold === undefined || browser === undefined) throw new Error('Terminal scaffold unavailable')
    const world = scaffold
    const target = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US', hasTouch: false })
    const tripwire = watchConsole(target)
    let closeTerminal: (() => Promise<void>) | undefined
    try {
      await target.goto(world.authenticatedUrl, { waitUntil: 'load' })
      await target.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
      await target.locator('[data-sidebar-right-guide-entry="terminal"]').getByRole('button', { name: /New terminal/ }).click()
      const input = target.getByRole('textbox', { name: 'Terminal', exact: true })
      await input.waitFor()
      const [retained] = await world.ctx.terminalController.list(SESSION)
      const agent = world.ctx.agents.get(SESSION)
      if (retained === undefined || agent === undefined) throw new Error('The private terminal has no live owner')
      closeTerminal = () => world.ctx.terminalController.close(agent, retained.id)
      const text = 'TERMINAL_COPY_0123456789'
      await input.fill(`printf '\\033[2J\\033[H${text}\\n'`)
      await input.press('Enter')
      const firstRow = target.locator('[data-sidebar-terminal] .xterm-rows > div').first()
      await expect.poll(() => firstRow.innerText()).toBe(text)
      const glyphs = await firstRow.evaluate((element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        const texts: Text[] = []
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if ((node.textContent?.length ?? 0) > 0) texts.push(node as Text)
        const first = texts[0], last = texts.at(-1)
        if (first === undefined || last === undefined) throw new Error('The rendered PTY row has no glyphs')
        const head = document.createRange(), tail = document.createRange()
        head.setStart(first, 0); head.setEnd(first, 1)
        tail.setStart(last, last.length - 1); tail.setEnd(last, last.length)
        const a = head.getBoundingClientRect(), b = tail.getBoundingClientRect()
        return { start: a.left + 0.1, end: b.right - 0.1, y: a.top + a.height / 2 }
      })
      await target.mouse.move(glyphs.start, glyphs.y)
      await target.mouse.down()
      try { await target.mouse.move(glyphs.end, glyphs.y, { steps: 8 }) }
      finally { await target.mouse.up() }
      // A browser clipboard event reads xterm's pointer selection into private event data.
      const copied = await input.evaluate((element) => {
        const data = new DataTransfer()
        const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data })
        element.dispatchEvent(event)
        return { text: data.getData('text/plain'), handled: event.defaultPrevented }
      })
      expect(copied).toEqual({ text, handled: true })
      await compareWorkflowGolden(join(DIRECTORY, 'copy.expected.md'), JSON.stringify(copied, null, 2), webSnapshotMode())
      const screenshots = process.env.DSH_MOBILE_SCREENSHOTS ?? process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        await target.screenshot({ path: join(screenshots, `terminal-${responsiveBrowserName}-desktop-pointer-selection.png`), animations: 'disabled' })
      }
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(target, 'terminal-pointer-copy'); throw error }
    finally { try { await closeTerminal?.() } finally { await target.close() } }
  })

  it('owns the terminal guide and input goldens', async () => { await assertFixtureInventory(DIRECTORY, ['guide.expected.md', 'input.expected.md', 'queued-input.expected.md', 'recovery.expected.md', 'copy.expected.md']) })
})
