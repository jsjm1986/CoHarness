/** Release-change SSE frames exercise the real page gate, confirmation and reload handoff. */
import type { Browser, Page, Route } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { responsiveBrowser } from './responsive-browser.ts'
import { auditWorkflowState, newWorkflowPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

/** Send one Host graph over the EventSource transport without reaching into the client module registry. */
async function deliverGraph(waiting: Route[], graph: WebBootGraph): Promise<void> {
  await expect.poll(() => waiting.length, { message: 'The release fixture is waiting for an EventSource connection' }).toBeGreaterThan(0)
  const route = waiting.shift()
  if (route === undefined) throw new Error('The release EventSource connection disappeared')
  await route.fulfill({ status: 200, contentType: 'text/event-stream',
    headers: { 'cache-control': 'no-store' }, body: `retry: 50\ndata: ${JSON.stringify({ type: 'graph', graph })}\n\n` })
}

/** Keep the real modal open across the viewport matrix and confirm its safe initial decision. */
async function inspectPrompt(page: Page, state: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Service version changed', exact: true })
  await dialog.waitFor()
  const later = dialog.getByRole('button', { name: 'Not now', exact: true }).last()
  const reload = dialog.getByRole('button', { name: 'Reload to load the new version', exact: true })
  await expect.poll(() => later.evaluate(element => element === document.activeElement)).toBe(true)
  await auditWorkflowState(page, 'host-release', state, dialog, [later, reload])
}

it.skipIf(!workflowMatrixEnabled)('keeps drafts on Later, announces subsequent releases and hands Reload to browser navigation', async () => {
  const owned: { world?: WebScaffold; browser?: Browser; page?: Page } = {}
  onTestFinished(async () => {
    try { await owned.page?.close() }
    finally { try { await owned.browser?.close() } finally { await owned.world?.close() } }
  })
  const world = owned.world = await launchWebScaffold()
  const browser = owned.browser = await responsiveBrowser.launch()
  const page = owned.page = await newWorkflowPage(browser)
  const waiting: Route[] = []
  const tripwire = watchConsole(page)
  const endpoint = '**/plugins/events'
  try {
    await page.route(endpoint, (route) => { waiting.push(route) })
    await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, world.workspaceCwd)
    const input = page.locator('textarea:enabled:not([readonly])').last()
    await input.waitFor()
    const draft = 'Keep this unsent draft when a Host release changes'
    await input.fill(draft)
    const base = world.ctx.clientModules.graph()
    const first = { ...base, release: {
      version: 'next-development-release-with-a-long-identifying-suffix-2026.11.17',
      commit: '1234567890abcdef1234567890abcdef12345678',
    } }
    await deliverGraph(waiting, first)
    await inspectPrompt(page, 'version-transition')
    const dialog = page.getByRole('dialog', { name: 'Service version changed', exact: true })
    expect(await dialog.innerText()).toContain(first.release.version)
    await dialog.getByRole('button', { name: 'Not now', exact: true }).last().click()
    await dialog.waitFor({ state: 'hidden' })
    expect(await input.inputValue()).toBe(draft)
    // Reconnection to the dismissed release stays quiet; a different commit is a new decision.
    await deliverGraph(waiting, first)
    await expect.poll(() => waiting.length).toBeGreaterThan(0)
    expect(await dialog.isVisible()).toBe(false)
    const second = { ...first, release: { ...first.release, commit: 'abcdef1234567890abcdef1234567890abcdef12' } }
    await deliverGraph(waiting, second)
    await inspectPrompt(page, 'commit-transition')
    expect(await dialog.innerText()).toContain(first.release.commit)
    expect(await dialog.innerText()).toContain(second.release.commit)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    expect(await input.inputValue()).toBe(draft)
    const { release: _release, ...unpublished } = base
    await deliverGraph(waiting, unpublished)
    await inspectPrompt(page, 'unknown-release')
    expect(await dialog.getByText('Unknown', { exact: true }).count()).toBeGreaterThan(0)
    // Keep the announced release live until the user requests navigation.
    await Promise.all([
      page.waitForEvent('framenavigated', frame => frame === page.mainFrame()),
      dialog.getByRole('button', { name: 'Reload to load the new version', exact: true }).click(),
    ])
    await page.unroute(endpoint)
    await page.locator('textarea').first().waitFor()
    await dialog.waitFor({ state: 'hidden' })
    expect(await page.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type)).toBe('reload')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings.filter(message => !message.includes('Host release changed'))).toEqual([])
  } catch (error) { await saveFailureShot(page, 'host-release-responsive'); throw error }
}, 180_000)
