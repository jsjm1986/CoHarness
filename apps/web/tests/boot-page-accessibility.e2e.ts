/** Framework-free boot feedback remains readable before any client plugin activates. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cp, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { stampClientArtifact } from '../../../packages/client/modules/src/artifact-revision.ts'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/plugins/fixture-live-client', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/boot-page-accessibility/failure.expected.md', import.meta.url))

it('keeps an unactivated plugin report readable on a phone with reduced motion and forced colors', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-boot-accessibility-'))
  onTestFinished(() => rm(fixture, { recursive: true, force: true }))
  await cp(FIXTURE, fixture, { recursive: true })
  const pluginName = `@fixture/${'long-configuration-'.repeat(9)}client`
  await writeFile(join(fixture, 'package.json'), JSON.stringify({
    name: pluginName, version: '0.0.1', private: true, type: 'module', main: 'index.js',
    exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } },
  }))
  await writeFile(join(fixture, 'client.js'), stampClientArtifact(`
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pluginName)},
  factory() {
    return { inject: ['fixtureNeverProvided'], apply() {} }
  },
})
`, []))
  const scaffold = await launchWebScaffold({ extraInstallAnchors: [join(fixture, 'package.json')] })
  onTestFinished(() => scaffold.close())
  await scaffold.ctx.loader.create({ name: pluginName })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 390, height: 220 }, reducedMotion: 'reduce' })
  onTestFailed(() => saveFailureShot(page, 'web-e2e-boot-accessibility'))

  const pluginPattern = /\/plugins\/(?:combo\.js)?\?\?[^ ]*fixture\/long-configuration-/
  let releaseBundles = (): void => {}
  const released = new Promise<void>((resolve) => { releaseBundles = resolve })
  await page.route(pluginPattern, async (route) => { await released; await route.continue() })
  let navigation: ReturnType<typeof page.goto> | undefined
  try {
    navigation = page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    const spinner = page.locator('[data-dsh-boot-spinner]')
    await spinner.waitFor()
    expect(await spinner.evaluate(element => getComputedStyle(element).animationDuration)).toBe('6s')
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' })
    const arc = await spinner.evaluate((element) => {
      const arc = getComputedStyle(element, '::after')
      return { adjustment: arc.forcedColorAdjust, background: arc.backgroundImage }
    })
    expect(arc.adjustment).toBe('none')
    expect(arc.background).toContain('conic-gradient')
  } finally {
    releaseBundles()
    await navigation
    await page.unroute(pluginPattern)
  }

  const boot = page.locator('[data-dsh-boot]')
  await boot.getByText(`${pluginName}: pending`, { exact: false }).waitFor()
  await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[data-dsh-boot]', scaffold.workspaceCwd), webSnapshotMode())
  const layout = await boot.evaluate((element) => {
    const card = element.firstElementChild!
    return {
      viewport: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      contentWidth: element.scrollWidth,
      width: element.clientWidth,
      contentHeight: element.scrollHeight,
      height: element.clientHeight,
      firstTop: card.getBoundingClientRect().top,
    }
  })
  expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewport)
  expect(layout.contentWidth).toBe(layout.width)
  expect(layout.firstTop).toBeGreaterThanOrEqual(0)
  expect(layout.contentHeight).toBeGreaterThan(layout.height)
  await boot.evaluate((element) => { element.scrollTop = element.scrollHeight })
  expect(await boot.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
})
