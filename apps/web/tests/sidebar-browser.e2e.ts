/** Browser navigation through the real conversation, scoped Sidebar, and a loopback HTTP page. */
import { responsiveBrowser, responsiveBrowserName, responsiveMobileEmulation, responsiveViewports, expectViewportFit } from './responsive-browser.ts'
import { createServer, type Server } from 'node:http'
import type {} from '@deepseek-ai/dsh-workspace'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser } from 'playwright'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'
import { auditResponsiveControl } from './responsive-controls.ts'
import { captureTextContrast, expectTextContrast } from './text-contrast.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))

describe('web e2e: Session-owned Browser', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let server: Server | undefined
  let target: string

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
    browser = await responsiveBrowser.launch()
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

  it.each(responsiveViewports)('$name opens a message link, reports unobservable navigation, and restores sandbox after reload', async ({ name, width, height }) => {
    if (scaffold === undefined) throw new Error('Web scaffold is unavailable')
    const page = await browser!.newPage({ viewport: { width, height }, locale: 'en-US', hasTouch: true, isMobile: responsiveMobileEmulation && width < 768, reducedMotion: 'reduce' })
    try {
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      const panel = page.locator('[data-sidebar-right-panel]')
      await page.getByRole('button', { name: 'Open right sidebar', exact: true }).tap()
      await page.locator('[data-sidebar-right-guide-entry="browser"]').tap()
      await panel.getByText('Enter an HTTP(S) address to start browsing', { exact: true }).waitFor()
      await expectViewportFit(page, panel, [panel.getByRole('textbox', { name: 'Enter an HTTP(S) address' }),
        panel.getByRole('button', { name: 'Go', exact: true })])
      await panel.getByRole('button', { name: 'Close', exact: true }).tap()
      await expect.poll(() => panel.getAttribute('aria-hidden')).toBe('true')
      await page.getByRole('link', { name: 'Local preview', exact: true }).tap()
      const iframe = panel.locator('[data-sidebar-browser-frame]')
      const frame = page.frameLocator('[data-sidebar-browser-frame]')
      await frame.getByRole('heading', { name: 'First local page' }).waitFor()
      expect(await iframe.getAttribute('sandbox')).toContain('allow-scripts')
      expect(await iframe.getAttribute('referrerpolicy')).toBe('no-referrer')
      await panel.getByRole('textbox', { name: 'Enter an HTTP(S) address' }).focus()
      await expectViewportFit(page, panel, [panel.getByRole('textbox', { name: 'Enter an HTTP(S) address' }), panel.getByRole('button', { name: 'Go', exact: true }), panel.getByRole('button', { name: 'Reload', exact: true })])
      for (const label of ['Back', 'Forward', 'Reload', 'Go', 'Open in system browser', 'Disable sandbox restrictions']) {
        const control = panel.getByRole('button', { name: label, exact: true })
        const box = await control.boundingBox()
        expect(box?.width).toBeGreaterThanOrEqual(44)
        expect(box?.height).toBeGreaterThanOrEqual(44)
      }
      expect(await panel.getByRole('textbox', { name: 'Enter an HTTP(S) address' })
        .evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16)
      expect(await panel.getByText('Localhost and loopback addresses refer to your machine, not the Gateway or SSH host.', { exact: true }).count()).toBe(1)
      expect(await page.locator('[data-slot-error]').count()).toBe(0)
      const addressField = panel.getByRole('textbox', { name: 'Enter an HTTP(S) address' })
      await addressField.fill(target.replace('/first', '/second'))
      await panel.getByRole('button', { name: 'Go', exact: true }).tap()
      await frame.getByRole('heading', { name: 'Second local page' }).waitFor()
      await panel.getByRole('button', { name: 'Back', exact: true }).tap()
      await frame.getByRole('heading', { name: 'First local page' }).waitFor()
      await panel.getByRole('button', { name: 'Forward', exact: true }).tap()
      await frame.getByRole('heading', { name: 'Second local page' }).waitFor()
      await panel.getByRole('button', { name: 'Back', exact: true }).tap()
      await frame.getByRole('heading', { name: 'First local page' }).waitFor()
      const [external] = await Promise.all([
        page.context().waitForEvent('page'),
        panel.getByRole('button', { name: 'Open in system browser', exact: true }).tap(),
      ])
      await external.getByRole('heading', { name: 'First local page' }).waitFor()
      expect(external.url()).toBe(target)
      await external.close()
      await panel.getByRole('button', { name: 'Collapse right sidebar', exact: true }).tap()
      await page.getByRole('button', { name: 'Open right sidebar', exact: true }).tap()
      await frame.getByRole('heading', { name: 'First local page' }).waitFor()
      await expect.poll(async () => {
        const bounds = await iframe.boundingBox()
        return bounds !== null && bounds.x >= -1 && bounds.x + bounds.width <= width + 1
      }).toBe(true)
      await auditResponsiveControl(page, iframe, 'browser-readable-frame', 'center')
      const firstHeading = frame.getByRole('heading', { name: 'First local page' })
      const headingBox = await firstHeading.boundingBox()
      const frameBox = await iframe.boundingBox()
      expect(headingBox).not.toBeNull()
      expect(frameBox).not.toBeNull()
      expect(headingBox!.y).toBeGreaterThanOrEqual(frameBox!.y)
      expect(headingBox!.y + headingBox!.height).toBeLessThanOrEqual(frameBox!.y + frameBox!.height)
      await frame.getByRole('link', { name: 'Continue inside frame' }).tap()
      await frame.getByRole('heading', { name: 'Second local page' }).waitFor()
      await panel.getByText('URL changed', { exact: true }).waitFor()
      expect(await panel.getByRole('button', { name: 'Back', exact: true }).isEnabled()).toBe(false)
      expect(await panel.getByRole('button', { name: 'Open in system browser', exact: true }).isEnabled()).toBe(false)
      await panel.getByRole('button', { name: 'Reload', exact: true }).click()
      await frame.getByRole('heading', { name: 'First local page' }).waitFor()
      await panel.getByRole('textbox', { name: 'Enter an HTTP(S) address' }).fill(scaffold.baseUrl)
      await panel.getByRole('button', { name: 'Go', exact: true }).click()
      const rejectedAddress = panel.getByRole('alert')
      await rejectedAddress.waitFor()
      expect(await iframe.getAttribute('src')).toBe(target)
      const rejectionContrast = await captureTextContrast(page, [
        { label: 'address-refusal', text: rejectedAddress },
      ], `browser-address-refused-${name}`)
      await panel.getByRole('button', { name: 'Disable sandbox restrictions', exact: true }).click()
      await expect.poll(() => iframe.getAttribute('sandbox')).toBeNull()
      await frame.getByRole('heading', { name: 'First local page' }).waitFor()
      const sandboxWarning = panel.getByRole('status').filter({ hasText: 'Sandbox restrictions are disabled;' })
      await sandboxWarning.waitFor()
      const sandboxContrast = await captureTextContrast(page, [
        { label: 'sandbox-warning', text: sandboxWarning },
      ], `browser-sandbox-disabled-${name}`)
      const failedUrl = target.replace('/first', '/unavailable')
      await page.route(failedUrl, route => route.abort('connectionfailed'), { times: 1 })
      await addressField.fill(failedUrl)
      const [failedRequest] = await Promise.all([
        page.waitForEvent('requestfailed', request => request.url() === failedUrl),
        panel.getByRole('button', { name: 'Go', exact: true }).click(),
      ])
      expect(failedRequest.failure()).not.toBeNull()
      expect(await addressField.inputValue()).toBe(failedUrl)
      expect(await iframe.getAttribute('src')).toBe(failedUrl)
      await expectViewportFit(page, panel, [addressField, panel.getByRole('button', { name: 'Reload', exact: true })])
      await auditResponsiveControl(page, iframe, 'browser-network-failed-frame', 'center')
      const failedScreenshots = process.env.DSH_MOBILE_SCREENSHOTS
      if (failedScreenshots !== undefined) {
        await mkdir(failedScreenshots, { recursive: true })
        await page.screenshot({ path: join(failedScreenshots, `browser-network-failed-${responsiveBrowserName}-${name}.png`), animations: 'disabled' })
      }
      // Browsers suppress iframe error events; the failed transport does not imply an application error banner.
      await panel.getByRole('button', { name: 'Reload', exact: true }).click()
      await frame.getByRole('heading', { name: 'First local page' }).waitFor()
      await addressField.fill(target)
      await panel.getByRole('button', { name: 'Go', exact: true }).click()
      await frame.getByRole('heading', { name: 'First local page' }).waitFor()
      await page.reload({ waitUntil: 'load' })
      // A restored checkpoint is offered, never auto-loaded: the page surfaces
      // the last location and the user restores it explicitly.
      await panel.getByText('Previously opened', { exact: true }).waitFor()
      await panel.getByText(target, { exact: true }).waitFor()
      await panel.getByRole('button', { name: 'Restore page', exact: true }).click()
      await page.frameLocator('[data-sidebar-browser-frame]').getByRole('heading', { name: 'First local page' }).waitFor()
      expect(await iframe.getAttribute('sandbox')).toContain('allow-scripts')
      expect(await panel.getByRole('button', { name: 'Disable sandbox restrictions', exact: true }).count()).toBe(1)
      expect(await panel.count()).toBe(1)
      expect(tripwire.pageErrors).toEqual([])
      await auditResponsiveControl(page, iframe, 'browser-restored-readable-frame', 'center')
      const screenshots = process.env.DSH_MOBILE_SCREENSHOTS
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        await page.screenshot({ path: join(screenshots, `browser-${responsiveBrowserName}-${name}.png`), animations: 'disabled' })
      }
      expectTextContrast(rejectionContrast)
      expectTextContrast(sandboxContrast)
    } catch (error) {
      await saveFailureShot(page, `browser-${responsiveBrowserName}-${name}`)
      throw error
    } finally { await page.close() }
  }, 60_000)
})
