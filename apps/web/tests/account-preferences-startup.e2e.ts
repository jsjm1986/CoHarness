/** Account preference adoption through the built Web composition and a held Gateway response; no model calls. */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Request, Route } from 'playwright'
import { chromium } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const EXPECTED_DIR = fileURLToPath(new URL('./expected/account-preferences-startup/', import.meta.url))
const MODE = webSnapshotMode()

const ACCOUNT_VIEW = {
  revision: 2,
  migrated: true,
  values: {
    locale: { preference: 'en' },
    'ui-theme': { preference: 'dark' },
    'ui-conversation': {
      busyEnter: 'queue', chatContentWidth: 748, chatFullWidth: false, chatFontSize: 14,
      transcriptView: 'detailed', performanceUsage: 'detailed', linkOpening: 'sidebar',
    },
  },
  overrides: { locale: { preference: 'en' }, 'ui-theme': { preference: 'dark' }, 'ui-conversation': {} },
}

it.skipIf(MODE === 'record')('shares the admitted account preference GET across the first connection reset', async () => {
  const scaffold = await launchWebScaffold({})
  let browser: Browser | undefined
  const failures: unknown[] = []
  const handlers = new Set<Promise<void>>()
  const releaseHandshake = Promise.withResolvers<undefined>()
  const releasePreferences = Promise.withResolvers<undefined>()
  let navigation: Promise<void> | undefined
  try {
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    await page.emulateMedia({ colorScheme: 'light' })
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'account-preferences-startup'))
    const origin = new URL(scaffold.authenticatedUrl).origin
    const accountRequests: Request[] = []
    const accountFailures = new Set<Request>()
    const settingsFinished = new Set<Request>()
    const writes: string[] = []
    let firstAccountRequest: Request | undefined
    let handshakeHeld = false
    let handshakeClaimed = false
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.origin !== origin) return
      if (url.pathname === '/account/api/preferences' && request.method() === 'GET') accountRequests.push(request)
      if (url.pathname === '/account/api/preferences' && request.method() !== 'GET') writes.push(request.method())
      if (['/api/session.create', '/api/session.prompt', '/api/session.selectModel'].includes(url.pathname)) {
        writes.push(url.pathname)
      }
    })
    page.on('requestfinished', (request) => {
      const url = new URL(request.url())
      if (url.origin === origin && url.pathname === '/api/settings.describe') settingsFinished.add(request)
    })
    page.on('requestfailed', (request) => {
      const url = new URL(request.url())
      if (url.origin === origin && url.pathname === '/account/api/preferences') accountFailures.add(request)
    })
    const ownedRoute = (operation: (route: Route) => Promise<void>) => async (route: Route): Promise<void> => {
      const pending = operation(route)
      handlers.add(pending)
      try { await pending } catch (error) {
        if (!accountFailures.has(route.request())) {
          failures.push(error)
          await route.abort().catch((abortError: unknown) => { failures.push(abortError) })
        }
      } finally { handlers.delete(pending) }
    }
    // The standalone Host has no Gateway preferences endpoint. Only that account response is synthetic.
    await page.route(
      url => url.origin === origin && url.pathname === '/account/api/preferences',
      ownedRoute(async (route) => {
        if (route.request().method() !== 'GET') {
          await route.fulfill({ status: 405, json: { error: 'read-only-account-fixture' } })
          return
        }
        firstAccountRequest ??= route.request()
        await releasePreferences.promise
        await route.fulfill({ json: ACCOUNT_VIEW })
      }),
    )
    await page.route(
      url => url.origin === origin && url.pathname === '/api/host.describe',
      ownedRoute(async (route) => {
        if (handshakeClaimed) { await route.continue(); return }
        handshakeClaimed = true
        const response = await route.fetch()
        handshakeHeld = true
        await releaseHandshake.promise
        await route.fulfill({ response })
      }),
    )
    navigation = page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' }).then(() => undefined, (error: unknown) => {
      failures.push(error)
    })
    await expect.poll(() => handshakeHeld && firstAccountRequest !== undefined, { timeout: 30_000 }).toBe(true)
    expect(accountRequests).toHaveLength(1)
    releaseHandshake.resolve(undefined)
    // Host settings keep their second baseline; its completion acknowledges the real initial reset.
    await expect.poll(() => settingsFinished.size >= 2, { timeout: 30_000 }).toBe(true)
    expect(settingsFinished.size).toBe(2)
    expect(accountRequests).toHaveLength(1)
    expect(accountFailures.size).toBe(0)
    releasePreferences.resolve(undefined)
    await navigation
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    const dark = dialog.getByRole('button', { name: 'Dark', exact: true })
    await expect.poll(() => dark.isEnabled()).toBe(true)
    await expect.poll(() => dark.getAttribute('aria-pressed')).toBe('true')
    expect(await dialog.getByRole('button', { name: 'Light', exact: true }).getAttribute('aria-pressed')).toBe('false')
    expect(await dialog.getByRole('button', { name: 'System', exact: true }).getAttribute('aria-pressed')).toBe('false')
    expect(await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
    expect(await dialog.getByRole('alert').count()).toBe(0)
    await expect.poll(() => dialog.getByRole('button', { name: 'Standard mode', exact: true }).isEnabled()).toBe(true)
    if (MODE === 'refresh') await mkdir(EXPECTED_DIR, { recursive: true })
    await compareOrRefreshGolden(join(EXPECTED_DIR, 'ready.expected.md'),
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
    await assertFixtureInventory(EXPECTED_DIR, ['ready.expected.md'])
    expect(accountRequests).toHaveLength(1)
    expect(accountFailures.size).toBe(0)
    expect(settingsFinished.size).toBe(2)
    expect(writes).toEqual([])
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    console.info('[account-preferences-startup]', JSON.stringify({
      accountGets: accountRequests.length, cancelled: accountFailures.size, hostSettingsDescribes: settingsFinished.size,
      firstAdmittedBeforeHandshake: firstAccountRequest !== undefined && handshakeHeld,
    }))
  } catch (error) {
    failures.push(error)
  } finally {
    releaseHandshake.resolve(undefined)
    releasePreferences.resolve(undefined)
    await Promise.allSettled([...handlers])
    if (navigation !== undefined) await navigation
    if (browser !== undefined) {
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          await page.unrouteAll({ behavior: 'wait' }).catch((error: unknown) => { failures.push(error) })
        }
      }
      await browser.close().catch((error: unknown) => { failures.push(error) })
    }
    await scaffold.close().catch((error: unknown) => { failures.push(error) })
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Account preference startup journey failed')
})
