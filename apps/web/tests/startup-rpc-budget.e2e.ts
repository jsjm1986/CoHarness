/** Cold-boot RPC budgets for the shared settings and workspace baselines; no model calls. */
import type { Browser, Request } from 'playwright'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

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
