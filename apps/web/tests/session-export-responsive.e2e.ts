/** Session export UI and real ZIP downloads across compact and desktop header layouts. */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { unzipSync, strFromU8 } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { responsiveBrowser, responsiveBrowserName, responsiveMobileEmulation, responsiveViewports, expectViewportFit } from './responsive-browser.ts'
import { saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./snapshots/session-export-responsive/success.expected.md', import.meta.url))
const EXPORT = '**/api/session.export?*'

async function requestExport(page: Page): Promise<void> {
  const mobile = page.getByRole('button', { name: 'Export Session log', exact: true })
  const desktop = page.getByRole('button', { name: 'Session log', exact: true })
  await expect.poll(async () => await mobile.isVisible() || await desktop.isVisible()).toBe(true)
  if (await mobile.isVisible()) await mobile.click()
  else {
    await desktop.click()
    await page.getByRole('button', { name: 'Confirm download?', exact: true }).click()
  }
}

describe('web e2e: responsive Session export', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let session: SessionId
  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraInstallAnchors: [fileURLToPath(new URL('../../../packages/session-query/session-log-export/package.json', import.meta.url))],
      extraOverlayPath: fileURLToPath(new URL('./session-export-responsive.overlay.yml', import.meta.url)),
    })
    session = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'session-export-responsive-history')
    await (await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)).attachSession(session)
    browser = await responsiveBrowser.launch()
  })
  afterAll(async () => { try { await browser?.close() } finally { await scaffold?.close() } })

  it.each(responsiveViewports)('$name keeps preparing and completion reachable, rotates safely and downloads the actual Session', async ({ name, width, height }) => {
    const page = await browser.newPage({ viewport: { width, height }, locale: 'en-US', hasTouch: true,
      isMobile: responsiveMobileEmulation && width < 768, reducedMotion: 'reduce' })
    const tripwire = watchConsole(page)
    const release = Promise.withResolvers<undefined>()
    const operations = new Set<Promise<void>>()
    const routeErrors: unknown[] = []
    try {
      await page.route(EXPORT, (route) => {
        if (route.request().method() !== 'HEAD') return route.continue()
        const operation = (async () => {
          const response = await route.fetch()
          await release.promise
          await route.fulfill({ response })
        })()
        operations.add(operation)
        void operation.then(() => { operations.delete(operation) }, (error: unknown) => {
          operations.delete(operation)
          routeErrors.push(error)
        })
        return operation
      })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      const downloaded = page.waitForEvent('download').then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
      await requestExport(page)
      const preparing = page.getByRole('dialog', { name: 'Exporting Session', exact: true })
      await preparing.waitFor()
      await expectViewportFit(page, preparing, [preparing.getByRole('button', { name: 'Close', exact: true }).last()])
      await page.setViewportSize({ width: height, height: width })
      await expectViewportFit(page, preparing, [preparing.getByRole('button', { name: 'Close', exact: true }).last()])
      release.resolve(undefined)
      const outcome = await downloaded
      if (!outcome.ok) throw outcome.error
      const download = outcome.value
      expect(await download.failure()).toBeNull()
      expect(download.suggestedFilename()).toBe(`dsh-session-${session}.zip`)
      const path = await download.path()
      if (path === null) throw new Error('Session export has no downloaded archive')
      const entries = unzipSync(await readFile(path))
      expect(Object.entries(entries).some(([name, bytes]) => name.endsWith('.jsonl')
        && strFromU8(bytes).includes('Use the read tool twice in one assistant message:')
        && strFromU8(bytes).includes('DONE'))).toBe(true)
      const complete = page.getByRole('dialog', { name: 'Session download started', exact: true })
      await complete.waitFor()
      await expectViewportFit(page, complete, [complete.getByRole('button', { name: 'Close', exact: true }).last()])
      if (width === 390 && height === 844) await compareOrRefreshGolden(GOLDEN,
        await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
      await complete.getByRole('button', { name: 'Close', exact: true }).last().click()
      await complete.waitFor({ state: 'hidden' })
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, `session-export-${responsiveBrowserName}-${name}`)
      await writeFile(fileURLToPath(new URL(`../../../.artifacts/session-export-${responsiveBrowserName}-${name}.json`, import.meta.url)),
        JSON.stringify({ aria: await page.locator('body').ariaSnapshot(), pageErrors: tripwire.pageErrors,
          controls: await page.getByRole('button', { includeHidden: true }).filter({ hasText: 'Session log' }).evaluateAll(nodes => nodes.map(node => ({
            html: node.outerHTML, inert: node.closest('[inert]')?.outerHTML.slice(0, 300),
            hidden: node.closest('[aria-hidden="true"]')?.outerHTML.slice(0, 300),
          }))),
        }, null, 2) + '\n')
      throw error
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([...operations])
      await page.close()
      if (routeErrors.length > 0) throw new AggregateError(routeErrors, 'Session export fixture request failed')
    }
  })

  it('shows a failed export and lets the next real download succeed', async () => {
    const page = await browser.newPage({ viewport: { width: 320, height: 568 }, locale: 'en-US' })
    try {
      await page.route(EXPORT, route => route.fulfill({ status: 503, body: 'Unavailable' }))
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: 'Export Session log', exact: true }).waitFor()
      await requestExport(page)
      const failure = page.getByRole('dialog', { name: 'Session export failed', exact: true })
      await failure.waitFor()
      await expectViewportFit(page, failure, [failure.getByRole('button', { name: 'Close', exact: true }).last()])
      await failure.getByRole('button', { name: 'Close', exact: true }).last().click()
      await page.unroute(EXPORT)
      const downloaded = page.waitForEvent('download').then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
      await requestExport(page)
      const outcome = await downloaded
      if (!outcome.ok) throw outcome.error
      expect(await outcome.value.failure()).toBeNull()
      await page.getByRole('dialog', { name: 'Session download started', exact: true }).waitFor()
    } finally { await page.close() }
  })
})
