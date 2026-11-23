/** Built Admin navigation, form ownership, and browser history on both computers. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { startAdminResponsiveFixture } from './admin-responsive-fixture.ts'
import { compareOrRefreshGolden, webSnapshotMode } from './expected.ts'

it('preserves cross-computer history when Back and Forward meet a draft', async () => {
  const fixture = await startAdminResponsiveFixture()
  onTestFinished(() => fixture.close())
  fixture.state.scope = 'organization'
  const browser = await chromium.launch({ executablePath: process.env.DSH_TEST_BROWSER_EXECUTABLE })
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  const login = await page.request.post(`${fixture.base}/login`, {
    form: { username: 'admin', password: 'fixture-password' }, headers: { origin: fixture.base }, maxRedirects: 0,
  })
  expect(login.status()).toBe(302)
  const userPath = `/admin/users/${fixture.adminId}`
  const suffix = '?from=history#quota'
  const center = `${fixture.base}${userPath}${suffix}`
  const remote = `${fixture.base}/admin/computers/${fixture.remoteNodeId}/users/${fixture.adminId}${suffix}`
  await page.route(url => url.pathname.startsWith('/admin/api/') && url.searchParams.get('dshNode') === fixture.remoteNodeId, async (route) => {
    const url = new URL(route.request().url())
    url.searchParams.delete('dshNode')
    await route.fulfill({ response: await route.fetch({ url: url.href }) })
  })
  const switchComputer = async (name: string | RegExp) => {
    await page.getByRole('button', { name: /^管理电脑：/u }).click()
    await page.getByRole('button', { name }).click()
  }
  await page.goto(center)
  await switchComputer(fixture.remoteName)
  await page.waitForURL(remote)
  await switchComputer(/中心电脑/u)
  await page.waitForURL(center)
  await page.goBack()
  await page.waitForURL(remote)

  const quotaMode = page.getByRole('group', { name: 'Token 额度', exact: true }).getByRole('combobox')
  await quotaMode.selectOption('custom')
  const draft = page.getByRole('textbox', { name: '每月 Token', exact: true })
  await draft.fill('98765')
  const entries = await page.evaluate(() => history.length)
  const guard = page.getByRole('dialog', { name: '保留当前编辑', exact: true })
  for (const delta of [-1, 1]) {
    await page.evaluate((step) => { history.go(step) }, delta)
    await guard.waitFor()
    await page.waitForURL(remote)
    expect(await draft.inputValue()).toBe('98765')
    expect(await page.evaluate(() => history.length)).toBe(entries)
    expect(await guard.getByRole('link', { name: '在新标签页打开' }).getAttribute('href')).toBe(userPath + suffix)
    if (delta === -1) {
      await compareOrRefreshGolden(fileURLToPath(new URL('./snapshots/admin-computer-history/guard.expected.md', import.meta.url)),
        await guard.ariaSnapshot(), webSnapshotMode())
    }
    await guard.getByRole('button', { name: '留在当前页面', exact: true }).click()
  }
  await quotaMode.selectOption('inherit')
  await page.goForward()
  await page.waitForURL(center)
})
