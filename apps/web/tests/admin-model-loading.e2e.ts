/** Verify catalog preloading and filtered registration reads through the served Admin. */
import { completionBarrier } from './support.ts'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import type { ModelRegistrationReport } from '../../../gateway/admin-ui/src/api.ts'
import { activateAdminControl, adminAndroidEndpoint, connectAdminAndroid, dismissAdminAndroidKeyboard } from './admin-android-browser.ts'
import { startAdminResponsiveFixture } from './admin-responsive-fixture.ts'
import { responsiveBrowser } from './responsive-browser.ts'
import { compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'

const MODE = webSnapshotMode()
const EXPECTED = fileURLToPath(new URL('./expected/admin-model-view-drafts/model-loading.expected.md', import.meta.url))
const LATEST = 'latest-query'
const PREVIOUS = 'previous-query'

it.skipIf(MODE === 'record')('preloads model details from catalog readiness and keeps the latest registration filter', async () => {
  const onDevice = adminAndroidEndpoint !== undefined
  const fixture = await startAdminResponsiveFixture(onDevice ? `dsh-admin-model-${randomUUID().slice(0, 8)}.localhost` : undefined)
  onTestFinished(() => fixture.close())
  const connection = onDevice ? await connectAdminAndroid(fixture.base)
    : await responsiveBrowser.launch().then(browser => ({ browser, close: () => browser.close() }))
  onTestFinished(() => connection.close())
  const context = onDevice ? connection.browser.contexts()[0] : await connection.browser.newContext({
    locale: 'zh-CN', viewport: { width: 1400, height: 900 },
  })
  if (context === undefined) throw new Error('Android CDP did not expose an active browser context')
  const page = await context.newPage()
  onTestFinished(() => page.close())
  await page.bringToFront()

  const releaseModels = completionBarrier()
  const releaseRegistrations = completionBarrier()
  const earlierSettled = completionBarrier()
  let modelsPending = false, earlierPending = false, userReads = 0
  let detailsStatus: number | undefined
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/admin/api/users') userReads++
  })
  page.on('response', (response) => {
    if (/\/assets\/ModelsDetails-[^/]+\.js$/u.test(new URL(response.url()).pathname)) detailsStatus = response.status()
  })
  await page.route(url => url.pathname === '/admin/api/models', async (route) => {
    modelsPending = true
    await releaseModels.promise
    modelsPending = false
    await route.continue()
  })
  const report = (provider: string): ModelRegistrationReport => ({
    summary: { providerCount: 1, modelCount: 1, eventCount: 1, createdCount: 1, modifiedCount: 0, deletedCount: 0 },
    rows: [{
      eventId: provider, userId: fixture.adminId, occurredAt: Date.parse('2026-11-18T00:00:00Z'),
      receivedAt: Date.parse('2026-11-18T00:00:00Z'), provider, model: 'chat',
      action: 'model-created', scope: 'personal',
    }],
  })
  await page.route(url => url.pathname === '/admin/api/model-registrations', async (route) => {
    if (new URL(route.request().url()).searchParams.get('provider') === LATEST) {
      await route.fulfill({ json: report(LATEST) })
      return
    }
    earlierPending = true
    await releaseRegistrations.promise
    try {
      await route.fulfill({ json: report(PREVIOUS) })
    } catch (error) {
      if (route.request().failure() === null) throw error
    } finally { earlierSettled.resolve() }
  })

  try {
    if (onDevice) {
      await page.goto(`${fixture.base}/login?returnTo=%2Fadmin%2Fmodels`, { waitUntil: 'domcontentloaded' })
      const form = page.locator('form').filter({ has: page.locator('input[name="password"]') })
      await form.locator('input[name="username"]').fill('admin')
      await form.locator('input[name="password"]').fill('fixture-password')
      await Promise.all([
        page.waitForURL(`${fixture.base}/admin/models`, { waitUntil: 'domcontentloaded' }),
        form.evaluate((element) =>{  (element as HTMLFormElement).requestSubmit() }),
      ])
    } else {
      const login = await context.request.post(`${fixture.base}/login`, {
        form: { username: 'admin', password: 'fixture-password' },
        headers: { origin: fixture.base }, maxRedirects: 0,
      })
      expect(login.status()).toBe(302)
      await page.goto(`${fixture.base}/admin/models`, { waitUntil: 'domcontentloaded' })
    }
    await page.getByText('组织 Provider 与模型', { exact: true }).waitFor()
    await expect.poll(() => detailsStatus, { timeout: 10_000 }).toBe(200)
    expect(modelsPending).toBe(true)
    expect(userReads).toBe(0)
    releaseModels.resolve()

    await activateAdminControl(page.getByRole('button', { name: '个人登记', exact: true }))
    const filter = page.getByRole('textbox', { name: '筛选 Provider', exact: true })
    await filter.waitFor()
    await expect.poll(() => earlierPending && userReads === 1).toBe(true)
    await filter.fill(LATEST)
    if (onDevice && await page.evaluate(() => screen.width > screen.height)) {
      await filter.press('Enter')
    } else {
      if (onDevice) {
        await filter.evaluate((element) => { if (element instanceof HTMLElement) element.blur() })
        await dismissAdminAndroidKeyboard()
        await expect.poll(() => page.evaluate(() => visualViewport === null
          || visualViewport.height >= innerHeight - 1 && visualViewport.offsetTop <= 1)).toBe(true)
      }
      await activateAdminControl(page.getByRole('button', { name: '应用筛选', exact: true }))
    }
    const entries = page.locator('tr, article.mobileItem')
    const row = entries.filter({ hasText: LATEST }).filter({ visible: true })
    await row.waitFor()
    releaseRegistrations.resolve()
    await earlierSettled.promise
    expect(await entries.filter({ hasText: PREVIOUS }).count()).toBe(0)
    expect(await filter.inputValue()).toBe(LATEST)
    expect(errors).toEqual([])
    const registration = new RegExp(`(${LATEST})(?:\\s+|/)(chat)`, 'u').exec(await row.innerText())
    expect(registration).not.toBeNull()
    await compareOrRefreshGolden(EXPECTED, [
      `Prepared model details: HTTP ${detailsStatus}`,
      `User directory requests after opening the tab: ${userReads}`,
      `Applied Provider filter: ${await filter.inputValue()}`,
      `Visible registration: ${registration![1]}/${registration![2]}`,
    ].join('\n'), MODE)
  } finally {
    releaseModels.resolve()
    releaseRegistrations.resolve()
  }
})
