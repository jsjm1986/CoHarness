/** Real Gateway browser forms retain exact startup targets through external admission failures. */
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { expect, it } from 'vitest'
import { runtimeStartFeedbackFixture } from '../../../gateway/tests/runtime-start-feedback-fixture.ts'
import { compareOrRefreshGolden, webSnapshotMode } from './expected.ts'
import { expectViewportFit, responsiveBrowser, responsiveBrowserName, responsiveMobileEmulation, responsiveViewports } from './responsive-browser.ts'
import { auditResponsiveControls } from './responsive-controls.ts'

const EXPECTED = fileURLToPath(new URL('./expected/runtime-start-feedback/', import.meta.url))
const matrix = process.env.DSH_FEATURE_MATRIX === '1'
const cases = (['personal', 'project'] as const).flatMap(kind => matrix
  ? responsiveViewports.map(viewport => ({ kind, variant: viewport.name, viewport, mobile: true, dark: viewport.width % 2 === 0 }))
  : [
    { kind, variant: 'desktop-light', viewport: { width: 1400, height: 1000 }, mobile: false, dark: false },
    { kind, variant: 'mobile-dark', viewport: { width: 390, height: 844 }, mobile: true, dark: true },
  ])

it.each(cases)('retains the $kind target through startup failure and keyboard retry in $variant', async ({ kind, variant, viewport, mobile, dark }) => {
  const fixture = await runtimeStartFeedbackFixture(kind)
  const { origin, personalRuntimeId, selectedRuntimeId, ownerId, projectId } = fixture
  const cleanup: Array<() => unknown> = [() => fixture.close()]
  const states: string[] = []
  let failure: string | undefined
  const audit = async (page: Page, state: string): Promise<void> => {
    if (!matrix) return
    await expectViewportFit(page, page.locator('body'))
    await auditResponsiveControls(page, page.locator('body'), `runtime-start/${kind}/${state}`)
    const directory = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
    if (directory !== undefined) {
      await mkdir(directory, { recursive: true })
      await page.screenshot({ path: join(directory, `${responsiveBrowserName}-runtime-${kind}-${variant}-${state}.png`), fullPage: true })
    }
    states.push(state)
  }
  try {
    const browser = await responsiveBrowser.launch()
    cleanup.push(() => browser.close())
    const context = await browser.newContext({ locale: 'zh-CN', viewport,
      colorScheme: dark ? 'dark' : 'light', hasTouch: mobile, isMobile: responsiveMobileEmulation && mobile })
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
    await audit(page, 'stopped')
    expect(fixture.startCalls()).toHaveLength(0)
    const action = `/account/runtime/start?dshRuntime=${selectedRuntimeId}`
    const target = origin + action
    const [response] = await Promise.all([
      page.waitForResponse(value => value.request().method() === 'POST' && value.url() === target),
      page.waitForURL(target),
      mobile ? page.getByRole('button', { name: '启动并打开', exact: true }).tap()
        : page.getByRole('button', { name: '启动并打开', exact: true }).click(),
    ])
    expect(response.status()).toBe(503)
    expect(page.url()).toBe(target)
    expect(await page.getByRole('heading', { name: '工作台未能打开', exact: true }).count()).toBe(1)
    expect(await page.locator('form').getAttribute('action')).toBe(action)
    expect(await page.locator('input[name=kind]').inputValue()).toBe(kind)
    if (kind === 'project') expect(await page.locator('input[name=projectId]').inputValue()).toBe(String(projectId))
    const retry = page.getByRole('button', { name: '重试启动', exact: true })
    await retry.waitFor()
    await audit(page, 'failed')
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
    const [retried] = await Promise.all([
      page.waitForResponse(value => value.request().method() === 'POST' && value.url() === target),
      page.waitForEvent('framenavigated', frame => frame === page.mainFrame() && frame.url() === target),
      page.keyboard.press('Enter'),
    ])
    expect(retried.status()).toBe(503)
    await page.waitForLoadState('domcontentloaded')
    await page.getByRole('button', { name: '重试启动', exact: true }).waitFor()
    await audit(page, 'retry-failed')
    expect(fixture.startCalls()).toHaveLength(2)
    for (const call of fixture.startCalls()) {
      expect(call).toMatchObject({ id: ownerId, runtimeId: selectedRuntimeId, intent: 'explicit' })
    }
    expect(await other.locator('body').ariaSnapshot()).toBe(otherBody)
    expect(other.url()).toBe(otherUrl)
    expect((await context.cookies()).find(cookie => cookie.name === 'hgw_scope')?.value).toBe('project:900')
    await page.getByRole('link', { name: '返回空间列表', exact: true }).click()
    await page.getByRole('heading', { name: '选择工作环境', exact: true }).waitFor()
    await audit(page, 'environments')
    expect(fixture.startCalls()).toHaveLength(2)
    expect(errors).toEqual([])
  } catch (error) {
    failure = String(error)
    throw error
  } finally {
    const failures: unknown[] = []
    for (const release of cleanup.reverse()) {
      try { await release() } catch (error) { failures.push(error) }
    }
    const receipts = process.env.DSH_FEATURE_COVERAGE_OUTPUT
    if (matrix && receipts !== undefined) {
      await mkdir(receipts, { recursive: true })
      await appendFile(join(receipts, `runtime-${responsiveBrowserName}.jsonl`), JSON.stringify({
        domain: 'gateway-runtime-start', kind, viewport, states,
        status: failure === undefined && failures.length === 0 ? 'passed' : 'failed',
        ...(failure === undefined ? {} : { error: failure }),
      }) + '\n')
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Runtime startup browser fixture cleanup failed')
  }
})
