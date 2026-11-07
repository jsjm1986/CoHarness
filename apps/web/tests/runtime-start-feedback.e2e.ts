/** Real Gateway browser forms retain exact startup targets through external admission failures. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { runtimeStartFeedbackFixture } from '../../../gateway/tests/runtime-start-feedback-fixture.ts'
import { compareOrRefreshGolden, webSnapshotMode } from './expected.ts'

const EXPECTED = fileURLToPath(new URL('./expected/runtime-start-feedback/', import.meta.url))

it.each([
  ['personal', 'desktop-light'], ['project', 'desktop-light'],
  ['personal', 'mobile-dark'], ['project', 'mobile-dark'],
] as const)('retains the %s target through startup failure and keyboard retry in %s', async (kind, variant) => {
  const fixture = await runtimeStartFeedbackFixture(kind)
  const { origin, personalRuntimeId, selectedRuntimeId, ownerId, projectId } = fixture
  const cleanup: Array<() => unknown> = [() => fixture.close()]
  try {
    const browser = await chromium.launch()
    cleanup.push(() => browser.close())
    const mobile = variant === 'mobile-dark'
    const context = await browser.newContext({ locale: 'zh-CN', viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 1000 },
      colorScheme: mobile ? 'dark' : 'light', hasTouch: mobile, isMobile: mobile })
    const login = await context.request.post(`${origin}/login`, { form: { username: 'admin', password: 'fixture-password' },
      headers: { origin }, maxRedirects: 0 })
    expect(login.status()).toBe(302)
    await context.addCookies([{ name: 'hgw_scope', value: 'project:900', url: origin }])
    const other = await context.newPage()
    await other.goto(`${origin}/?dshRuntime=${personalRuntimeId}`)
    const otherBody = await other.locator('body').ariaSnapshot()
    const otherUrl = other.url()
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(error.message) })
    await page.goto(`${origin}/?dshRuntime=${selectedRuntimeId}`)
    expect(fixture.startCalls()).toHaveLength(0)
    const [response] = await Promise.all([
      page.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).pathname === '/account/runtime/start'),
      page.waitForEvent('domcontentloaded'),
      mobile ? page.getByRole('button', { name: '启动并打开', exact: true }).tap()
        : page.getByRole('button', { name: '启动并打开', exact: true }).click(),
    ])
    expect(response.status()).toBe(503)
    const action = `/account/runtime/start?dshRuntime=${selectedRuntimeId}`
    expect(page.url()).toBe(origin + action)
    expect(await page.getByRole('heading', { name: '工作台未能打开', exact: true }).count()).toBe(1)
    expect(await page.locator('form').getAttribute('action')).toBe(action)
    expect(await page.locator('input[name=kind]').inputValue()).toBe(kind)
    if (kind === 'project') expect(await page.locator('input[name=projectId]').inputValue()).toBe(String(projectId))
    const retry = page.getByRole('button', { name: '重试启动', exact: true })
    await retry.waitFor()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (webSnapshotMode() === 'refresh') await mkdir(EXPECTED, { recursive: true })
    await compareOrRefreshGolden(join(EXPECTED, 'failure.expected.md'), await page.locator('body').ariaSnapshot(), webSnapshotMode())
    const artifactDir = process.env.DSH_WEB_ARTIFACT_DIR
    if (artifactDir !== undefined) {
      await mkdir(artifactDir, { recursive: true })
      await page.screenshot({ path: join(artifactDir, `${kind}-${variant}.png`), fullPage: true })
    }
    expect(fixture.startCalls()).toHaveLength(1)
    await retry.focus()
    await Promise.all([page.waitForResponse(value => value.request().method() === 'POST'), page.waitForEvent('domcontentloaded'), page.keyboard.press('Enter')])
    await page.getByRole('button', { name: '重试启动', exact: true }).waitFor()
    expect(fixture.startCalls()).toHaveLength(2)
    for (const call of fixture.startCalls()) {
      expect(call).toMatchObject({ id: ownerId, runtimeId: selectedRuntimeId, intent: 'explicit' })
    }
    expect(await other.locator('body').ariaSnapshot()).toBe(otherBody)
    expect(other.url()).toBe(otherUrl)
    expect((await context.cookies()).find(cookie => cookie.name === 'hgw_scope')?.value).toBe('project:900')
    await page.getByRole('link', { name: '返回空间列表', exact: true }).click()
    await page.getByRole('heading', { name: '选择工作环境', exact: true }).waitFor()
    expect(fixture.startCalls()).toHaveLength(2)
    expect(errors).toEqual([])
  } finally {
    const failures: unknown[] = []
    for (const release of cleanup.reverse()) {
      try { await release() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Runtime startup browser fixture cleanup failed')
  }
})
