/** Browser navigation through the real conversation, scoped Sidebar, and a loopback HTTP page. */
import { createServer, type Server } from 'node:http'
import type {} from '@deepseek-ai/dsh-workspace'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))

describe('web e2e: Session-owned Browser', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let server: Server | undefined
  let target: string
  let page: Page

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(request.url === '/second'
        ? '<h1>Second local page</h1>'
        : '<h1>First local page</h1><a href="/second">Continue inside frame</a>')
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => { server!.removeListener('error', reject); resolve() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Browser test HTTP listener did not bind')
    target = `http://127.0.0.1:${address.port}/first`
    scaffold = await launchWebScaffold({})
    const source = (await readFile(SEED, 'utf8')).replace('"text":"DONE"', `"text":${JSON.stringify(`[Local preview](${target})`)}`)
    const history = await seedSession(scaffold, source, 'sidebar-browser-history')
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(history)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() }
    finally {
      try { await scaffold?.close() }
      finally {
        if (server?.listening) {
          const closed = new Promise<void>((resolve, reject) => { server!.close((error) => { if (error) reject(error); else resolve() }) })
          server.closeAllConnections()
          await closed
        }
      }
    }
  })

  it('opens a message link, reports unobservable navigation, and restores sandbox after reload', async () => {
    if (scaffold === undefined) throw new Error('Web scaffold is unavailable')
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-browser'))
    const tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.getByRole('link', { name: 'Local preview', exact: true }).click()
    const panel = page.locator('[data-sidebar-right-panel]')
    const iframe = panel.locator('[data-sidebar-browser-frame]')
    const frame = page.frameLocator('[data-sidebar-browser-frame]')
    await frame.getByRole('heading', { name: 'First local page' }).waitFor()
    expect(await iframe.getAttribute('sandbox')).toContain('allow-scripts')
    expect(await iframe.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(await panel.getByText('Localhost and loopback addresses refer to your machine, not the Gateway or SSH host.', { exact: true }).count()).toBe(1)
    expect(await page.locator('[data-slot-error]').count()).toBe(0)
    await frame.getByRole('link', { name: 'Continue inside frame' }).click()
    await frame.getByRole('heading', { name: 'Second local page' }).waitFor()
    await panel.getByText('URL changed', { exact: true }).waitFor()
    expect(await panel.getByRole('button', { name: 'Back', exact: true }).isEnabled()).toBe(false)
    expect(await panel.getByRole('button', { name: 'Open in system browser', exact: true }).isEnabled()).toBe(false)
    await panel.getByRole('button', { name: 'Reload', exact: true }).click()
    await frame.getByRole('heading', { name: 'First local page' }).waitFor()
    await panel.getByRole('textbox', { name: 'Enter an HTTP(S) address' }).fill(scaffold.baseUrl)
    await panel.getByRole('button', { name: 'Go', exact: true }).click()
    await panel.getByRole('alert').waitFor()
    expect(await iframe.getAttribute('src')).toBe(target)
    await panel.getByRole('button', { name: 'Disable sandbox restrictions', exact: true }).click()
    await expect.poll(() => iframe.getAttribute('sandbox')).toBeNull()
    await frame.getByRole('heading', { name: 'First local page' }).waitFor()
    await page.reload({ waitUntil: 'load' })
    await page.frameLocator('[data-sidebar-browser-frame]').getByRole('heading', { name: 'First local page' }).waitFor()
    expect(await iframe.getAttribute('sandbox')).toContain('allow-scripts')
    expect(await panel.getByRole('button', { name: 'Disable sandbox restrictions', exact: true }).count()).toBe(1)
    expect(await panel.count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
