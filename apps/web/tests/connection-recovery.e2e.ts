/** Real WebSocket loss without replacing Client plugins or navigating the page. */
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { chromium, type WebSocketRoute } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

it.each([false, true])('retains the mounted application across WebSocket recovery with an active Session: %s', async (activeSession) => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  onTestFinished(() => scaffold.close())
  const draft = 'Unsent draft retained across connection recovery'
  if (activeSession) {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const seed = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v7.jsonl', import.meta.url))
    const sessionId = await seedSession(scaffold, await readFile(seed, 'utf8'), 'connection-recovery-session')
    await workspace.attachSession(sessionId)
  }
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-connection-recovery'))
  const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []
  let muxOpens = 0
  let sessionBaselines = 0
  // Both downlinks (mux + host) ride one generation; closing either settles the
  // generation and the client reopens both, so route the two paths together.
  await page.routeWebSocket('**/api/events.*', (client) => {
    const server = client.connectToServer()
    sockets.push({ client, server })
    if (new URL(client.url()).pathname.endsWith('/events.mux')) muxOpens++
    client.onMessage((message) => {
      server.send(message)
    })
    server.onMessage((message) => {
      if (typeof message === 'string') {
        const frame = JSON.parse(message) as { method?: string; payload?: { type?: string } }
        if (frame.method === 'session/subscribed') sessionBaselines++
      }
      client.send(message)
    })
  })
  const onboarding = page.locator('[class*="onboardingOverlay"]')
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  if (await onboarding.count() > 0) {
    await onboarding.getByRole('button').first().click()
    await onboarding.waitFor({ state: 'detached', timeout: 15_000 })
  }
  const composer = page.locator('textarea').last()
  if (activeSession) {
    await page.getByRole('treeitem').filter({ has: page.getByText('Use the read tool twice', { exact: true }) }).click({ timeout: 20_000 })
    await composer.fill(draft)
    await expect.poll(() => sessionBaselines).toBeGreaterThan(0)
  } else {
    await page.locator('textarea[placeholder="Choose a workspace to start"]').waitFor({ timeout: 20_000 })
  }
  await expect.poll(() => muxOpens).toBeGreaterThan(0)
  const root = await page.locator('[data-slot="root"]').elementHandle()
  expect(root).not.toBeNull()
  let navigations = 0
  page.on('framenavigated', () => { navigations++ })

  for (let attempt = 0; attempt < 3; attempt++) {
    const previousOpens = muxOpens
    const previousBaseline = sessionBaselines
    // Close every socket of the current generation (mux + host).
    const active = sockets.splice(0)
    await Promise.all(active.flatMap(socket => [
      socket.client.close({ code: 1012, reason: 'test connection loss' }),
      socket.server.close({ code: 1012, reason: 'test connection loss' }),
    ]))
    await expect.poll(() => muxOpens, { timeout: 20_000 }).toBeGreaterThan(previousOpens)
    if (activeSession) {
      await expect.poll(() => sessionBaselines, { timeout: 20_000 }).toBeGreaterThan(previousBaseline)
    }
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
    }))
    expect(await root.evaluate(element => element.isConnected)).toBe(true)
    expect(console.pageErrors).toEqual([])
    if (activeSession) expect(await composer.inputValue()).toBe(draft)
  }

  expect(navigations).toBe(0)
  if (!activeSession) {
    expect(await page.locator('textarea[placeholder="Choose a workspace to start"]').isVisible()).toBe(true)
  }
})
