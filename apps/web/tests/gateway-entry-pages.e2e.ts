/** Gateway HTML rendered over loopback HTTP in real browsers; server/proxy suites own authorization and Runtime transitions. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, firefox, webkit, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { environmentsPage, loginPage, passwordPage, runtimeStartFailurePage, stoppedPage, waitingPage,
  type GatePageLanguage, type RuntimeStartFailureReason } from '../../../gateway/src/html.ts'
import type { RuntimeCatalogPage, RuntimeId, RuntimeNodeId } from '../../../gateway/src/runtime-catalog.ts'
import { activateAdminControl, adminAndroidEndpoint, connectAdminAndroid, screenshotAdminPage } from './admin-android-browser.ts'
import { auditAdminTouchTargets, selectedAdminSizes } from './admin-responsive-state.ts'
import { auditResponsiveControls } from './responsive-controls.ts'

const viewports = adminAndroidEndpoint !== undefined ? [[0, 0] as const]
  : selectedAdminSizes
const engines = process.env.DSH_ADMIN_ENGINES?.split(',') ?? ['chromium', 'webkit', 'firefox']
const runtimeId = '33000000-0000-4000-8000-000000000033' as RuntimeId
const nodeId = '10000000-0000-4000-8000-000000000001' as RuntimeNodeId
const environment: RuntimeCatalogPage = { items: [{ id: runtimeId,
  owner: { kind: 'project', id: 1, name: 'OrganizationProjectWithVeryLongUnbrokenIdentifier012345678901234567890123456789' },
  node: { id: nodeId, name: 'ComputerWithVeryLongUnbrokenIdentifier012345678901234567890123456789', status: 'active', lastHeartbeatAt: null },
  routing: 'local', observedState: 'stopped', generation: 0 }], nextCursor: null }
const failures: RuntimeStartFailureReason[] = ['busy', 'account', 'denied', 'unavailable', 'changed', 'invalid', 'unknown']
const scenarios = ['login', 'login-error', 'password', 'password-error', 'starting', 'stopped',
  ...failures.map(reason => `failure-${reason}`), 'environments', 'environments-empty', 'environments-more']

function render(path: string, language: GatePageLanguage): string {
  switch (path) {
    case 'login': return loginPage('', language)
    case 'login-error': return loginPage(language === 'zh' ? '用户名或密码错误' : 'Incorrect username or password.', language)
    case 'password': return passwordPage('', language)
    case 'password-error': return passwordPage(language === 'zh' ? '密码至少 8 位' : 'Password must be at least 8 characters.', language)
    case 'starting': return waitingPage(language)
    case 'stopped': return stoppedPage({ kind: 'project', id: 1, runtimeId }, language)
    case 'environments': return environmentsPage(environment, language, true)
    case 'environments-empty': return environmentsPage({ items: [], nextCursor: null }, language, true)
    case 'environments-more': return environmentsPage({ ...environment, nextCursor: 'fixture-cursor' as RuntimeCatalogPage['nextCursor'] }, language, true)
    default: {
      const reason = failures.find(value => path === `failure-${value}`)
      if (reason === undefined) throw new Error(`Unknown HTML scenario: ${path}`)
      return runtimeStartFailurePage(reason, reason === 'busy' || reason === 'unavailable'
        ? { kind: 'project', projectId: 1, action: `/account/runtime/start?dshRuntime=${runtimeId}` } : null, language)
    }
  }
}

const launchers: Readonly<Record<string, typeof chromium>> = adminAndroidEndpoint === undefined
  ? { chromium, webkit, firefox } : { android: chromium }
for (const [engine, launcher] of Object.entries(launchers)) {
  if (adminAndroidEndpoint === undefined && !engines.includes(engine)) continue
  describe(`Gateway entry HTML (${engine})`, () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://fixture')
      const path = url.pathname.slice(1)
      if (!scenarios.includes(path)) { response.writeHead(404); response.end(); return }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(render(path, url.searchParams.get('lang') === 'en' ? 'en' : 'zh'))
    })
    let browser: Browser, base: string
    let android: Awaited<ReturnType<typeof connectAdminAndroid>> | undefined
    const results: Array<{ page: string; viewport: string; language: string; status: 'passed' | 'failed'; checks: string[]; error?: string }> = []
    beforeAll(async () => {
      await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      if (adminAndroidEndpoint === undefined) browser = await launcher.launch(engine === 'firefox'
        ? { firefoxUserPrefs: { 'network.proxy.type': 0 } } : {})
      else { android = await connectAdminAndroid(base); browser = android.browser }
    })
    afterAll(async () => {
      if (android === undefined) await browser?.close(); else await android.close()
      server.closeAllConnections()
      await new Promise<void>((done, reject) => server.close((error) => { if (error) reject(error); else done() }))
      if (process.env.DSH_ADMIN_COVERAGE_OUTPUT !== undefined) {
        await mkdir(process.env.DSH_ADMIN_COVERAGE_OUTPUT, { recursive: true })
        await writeFile(join(process.env.DSH_ADMIN_COVERAGE_OUTPUT, `gateway-${engine}.json`), JSON.stringify(results, null, 2) + '\n')
      }
    })
    for (const scenario of scenarios) it(`${scenario}: readable and operable at every viewport`, async () => {
      for (const [emulatedWidth, emulatedHeight] of viewports) for (const language of ['zh', 'en'] as const) {
        const context = adminAndroidEndpoint !== undefined ? browser.contexts()[0]
          : await browser.newContext({ viewport: { width: emulatedWidth, height: emulatedHeight },
            hasTouch: emulatedWidth < 1024, isMobile: engine !== 'firefox' && emulatedWidth < 1024,
            reducedMotion: 'reduce', colorScheme: emulatedWidth % 2 === 0 ? 'dark' : 'light' })
        if (context === undefined) throw new Error('Android CDP did not expose its active browser context')
        const page = await context.newPage()
        if (adminAndroidEndpoint !== undefined) { await page.bringToFront(); await page.emulateMedia({ reducedMotion: 'reduce' }) }
        let viewportLabel = `${emulatedWidth}x${emulatedHeight}`
        const checks: string[] = []
        try {
          await page.goto(`${base}/${scenario}?lang=${language}`)
          await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThan(0)
          const { width, height } = adminAndroidEndpoint === undefined ? { width: emulatedWidth, height: emulatedHeight }
            : await page.evaluate(() => ({ width: screen.width, height: innerHeight }))
          viewportLabel = `${width}x${height}`
          if (width === 390) await page.addStyleTag({ content: 'body *{line-height:1.5!important;letter-spacing:.12em!important;'
            + 'word-spacing:.16em!important}p{margin-bottom:2em!important}' })
          const measured = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
            inputs: [...document.querySelectorAll<HTMLInputElement>('input:not([type="hidden"])')].map(input => ({
              width: input.getBoundingClientRect().width, height: input.getBoundingClientRect().height,
              fontSize: parseFloat(getComputedStyle(input).fontSize), labels: input.labels?.length ?? 0,
            })), buttons: [...document.querySelectorAll('button')].map(button => button.getBoundingClientRect().height),
            animations: document.getAnimations().filter(animation => animation.playState === 'running').length }))
          expect(measured.scrollWidth, `${scenario} ${width} ${language}: overflow`).toBeLessThanOrEqual(width + 1)
          expect(Math.abs(measured.width - width)).toBeLessThanOrEqual(1)
          expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1)
          expect(measured.animations, 'reduced motion leaves a static busy indicator').toBe(0)
          if (adminAndroidEndpoint === undefined) await auditResponsiveControls(page, page.locator('body'), scenario)
          await auditAdminTouchTargets(page, page.locator('body'))
          for (const input of measured.inputs) {
            expect(input.height).toBeGreaterThanOrEqual(44)
            expect(input.fontSize).toBeGreaterThanOrEqual(16)
            expect(input.labels).toBeGreaterThan(0)
          }
          for (const button of measured.buttons) expect(button).toBeGreaterThanOrEqual(44)
          checks.push('no-overflow', 'named-heading', 'touch-targets', 'reduced-motion')
          if (scenario.startsWith('login') || scenario.startsWith('password')) {
            const input = page.locator('input:not([type="hidden"])').first()
            await activateAdminControl(input)
            await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
            await input.fill(scenario.startsWith('login') ? 'admin' : 'long-enough-password')
            if (scenario.endsWith('error')) expect(await input.getAttribute('aria-describedby')).toBe('auth-error')
            checks.push('input-focus', 'label-association')
          }
          if (process.env.DSH_ADMIN_LAYOUT_SCREENSHOTS !== undefined
            && (adminAndroidEndpoint !== undefined || [390, 844, 1280].includes(width))) {
            await mkdir(process.env.DSH_ADMIN_LAYOUT_SCREENSHOTS, { recursive: true })
            await screenshotAdminPage(page, join(process.env.DSH_ADMIN_LAYOUT_SCREENSHOTS, `${engine}-gateway-${scenario}-${width}-${language}.png`))
          }
          results.push({ page: scenario, viewport: viewportLabel, language, status: 'passed', checks })
        } catch (error) {
          results.push({ page: scenario, viewport: viewportLabel, language, status: 'failed', checks, error: String(error) })
          throw error
        } finally { if (adminAndroidEndpoint === undefined) await context.close(); else await page.close() }
      }
    })
  })
}
