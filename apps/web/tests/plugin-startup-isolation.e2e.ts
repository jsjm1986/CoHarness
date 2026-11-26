/** The served profile opens and sends while optional scripts fail or wait for transport. */
import { randomUUID } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import type {} from '@deepseek-ai/dsh-workspace'
import { stampClientArtifact } from '../../../packages/client/modules/src/artifact-revision.ts'
import {
  activateAdminControl, adminAndroidEndpoint, connectAdminAndroid, dismissAdminAndroidKeyboard, tapAndroidImeKey,
} from './admin-android-browser.ts'
import { compareOrRefreshGolden, launchWebScaffold, seedSession, webSnapshotMode } from './scaffold.ts'
import { responsiveBrowser, responsiveMobileEmulation } from './responsive-browser.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const PLUGIN = '@fixture/startup-isolation'
const INVENTORY = '@deepseek-ai/dsh-client-ui-settings-plugin-inventory'
const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'
const REPLAY = fileURLToPath(new URL('./snapshots/lifecycle-chrome/session.jsonl', import.meta.url))
const HISTORY = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixtures/plugins/fixture-live-client', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/plugin-startup-isolation/', import.meta.url))

function requestsPlugin(url: URL, plugin: string): boolean {
  const [resources = ''] = url.search.slice(2).split('&', 1)
  return url.pathname.endsWith('/plugins/combo.js')
    && resources.split(',').includes(`${plugin}/client.js`)
}

const scenarios = ['healthy', 'optional-failure', 'optional-pending', 'required-failure'] as const
const layouts = adminAndroidEndpoint === undefined ? ['desktop', 'touch-landscape'] as const : ['android'] as const
const imeSendPoint = process.env.DSH_ANDROID_IME_SEND_POINT

it.skipIf(MODE === 'record').each(scenarios.flatMap(scenario => layouts.map(layout => [scenario, layout] as const)))(
  'serves the Web client under %s on %s',
  async (scenario, layout) => {
    const required = scenario === 'required-failure'
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-startup-'))
    onTestFinished(() => rm(fixture, { recursive: true, force: true }))
    await cp(FIXTURE, fixture, { recursive: true })
    const anchor = join(fixture, 'package.json')
    await writeFile(anchor, JSON.stringify({
      name: PLUGIN, version: '0.0.1', private: true, type: 'module', main: 'index.js',
      exports: { '.': './index.js', './client': './client.js' },
      dsh: { client: { platform: 'web', ...(required ? {} : { optional: true }) } },
    }))
    await writeFile(join(fixture, 'client.js'), stampClientArtifact(`
window.__ModuleLoader__.load({
  id: ${JSON.stringify(PLUGIN)},
  factory() {
    return { apply(ctx) {
      ctx.effect(() => {
        const root = document.documentElement
        root.dataset.fixtureStartupActive = ''
        return () => { delete root.dataset.fixtureStartupActive }
      })
    } }
  },
})
`, []))

    const scaffold = await launchWebScaffold({
      extraInstallAnchors: [anchor],
      ...(required ? {} : { replayFixture: REPLAY }),
      ...(adminAndroidEndpoint === undefined ? {} : { remoteAuthority: `dsh-startup-${randomUUID()}.localhost` }),
    })
    onTestFinished(() => scaffold.close())
    const pluginEntry = await scaffold.ctx.loader.create({ name: PLUGIN })
    const sessionId = await seedSession(scaffold, await readFile(HISTORY, 'utf8'), 'plugin-startup-history')
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(sessionId)

    const connection = adminAndroidEndpoint === undefined
      ? await responsiveBrowser.launch().then(browser => ({ browser, close: () => browser.close() }))
      : await connectAdminAndroid(scaffold.baseUrl)
    onTestFinished(() => connection.close())
    const page = layout === 'android'
      ? await connection.browser.contexts()[0]!.newPage()
      : layout === 'touch-landscape'
        ? await connection.browser.newPage({ viewport: { width: 872, height: 230 }, isMobile: responsiveMobileEmulation, hasTouch: true, locale: 'en-US' })
        : await newEnglishPage(connection.browser)
    onTestFinished(() => page.close())
    await page.bringToFront()
    const unstall = Promise.withResolvers<undefined>()
    const intercepted = new Set<string>()
    const optional = [PLUGIN, INVENTORY]
    if (scenario !== 'healthy') {
      const blocked = scenario === 'optional-failure' ? optional : [PLUGIN]
      await page.route(url => blocked.some(id => requestsPlugin(url, id)), async (route) => {
        intercepted.add(route.request().url())
        if (!required) await unstall.promise
        await route.fulfill({ status: 503, body: 'Isolated plugin load failure' })
      })
    }

    const composer = page.locator('textarea:visible')
    const send = page.getByRole('button', { name: /^(Send message|发送消息)$/u })
    try {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
      if (required) {
        const failure = page.locator('[data-dsh-boot]').getByText('Failed to load plugins', { exact: true })
        await failure.waitFor()
        expect(intercepted.size).toBeGreaterThan(0)
        expect(await composer.count()).toBe(0)
        expect(await send.count()).toBe(0)
        await compareOrRefreshGolden(join(EXPECTED, 'required-failure.expected.md'), [
          await failure.textContent(),
          `Available message inputs: ${String(await composer.count())}`,
          `Available send controls: ${String(await send.count())}`,
        ].join('\n'), MODE)
        return
      }

      await composer.waitFor()
      const descriptors = await page.evaluate(names => names.map((name) => {
        const graph = (window as Window & { __DSH_BOOT__?: WebBootGraph }).__DSH_BOOT__
        if (graph === undefined) throw new Error('The served page has no Web boot graph')
        const batch = graph.batches.find(entry => entry.entries.includes(name))
        return {
          row: graph.entries.find(entry => entry.id === name),
          batch,
          preloaded: Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="preload"]'))
            .some(link => batch !== undefined && link.href === new URL(batch.url, location.href).href),
        }
      }), optional)
      for (const [index, { row, batch, preloaded }] of descriptors.entries()) {
        expect(row).toMatchObject({ optional: true })
        expect(batch?.entries).toEqual([optional[index]])
        expect(preloaded).toBe(false)
      }

      const activated = page.locator('html[data-fixture-startup-active]')
      if (scenario === 'optional-failure') {
        const failedResponses = Promise.all(optional.map(id => page.waitForResponse(response =>
          requestsPlugin(new URL(response.url()), id) && response.status() === 503)))
        unstall.resolve(undefined)
        await failedResponses
        const pluginUrls = descriptors.flatMap(({ batch, row }) => [batch!.url, row!.url])
          .map(url => new URL(url, page.url()).href)
        expect([...intercepted].every(url => pluginUrls.includes(url))).toBe(true)
      } else if (scenario === 'optional-pending') {
        await expect.poll(() => intercepted.size).toBeGreaterThan(0)
      } else {
        await activated.waitFor({ state: 'attached' })
      }

      const history = page.getByText('DONE', { exact: true })
      await history.waitFor()

      const touch = layout !== 'desktop'
      const android = layout === 'android'
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(touch)
      const focused = () => composer.evaluate(input => input === document.activeElement)
      const visibleHeight = () => page.evaluate(() => visualViewport?.height ?? innerHeight)
      if (android) {
        await dismissAdminAndroidKeyboard()
        await expect.poll(() => page.evaluate(() => (visualViewport?.height ?? innerHeight) >= innerHeight - 1)).toBe(true)
      }
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      expect(await focused(), 'Composer focus after Session restoration').toBe(!touch)
      const heightBeforeTouch = await visibleHeight()
      await activateAdminControl(composer)
      await expect.poll(focused).toBe(true)
      const nativeKey = android ? imeSendPoint : undefined
      const keyboardOpen = async () => (await visibleHeight()) < heightBeforeTouch - 80
      if (android) await expect.poll(keyboardOpen).toBe(true)
      const hint = await composer.getAttribute('enterkeyhint')
      if (nativeKey !== undefined || layout === 'touch-landscape') expect(hint).toBe('send')
      if (layout === 'desktop' || android && await page.evaluate(() => screen.height > screen.width)) expect(hint).toBeNull()

      await page.keyboard.insertText('Draft line')
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.insertText('第二行')
      await expect.poll(() => composer.inputValue()).toBe('Draft line\n第二行')
      await composer.evaluate((input) => { (input as HTMLTextAreaElement).select() })
      await page.keyboard.insertText(PROMPT)
      await expect.poll(() => composer.inputValue()).toBe(PROMPT)

      const revealConversation = async () => {
        await dismissAdminAndroidKeyboard()
        await expect.poll(() => page.evaluate(() =>
          visualViewport === null || (visualViewport.height >= innerHeight - 1 && visualViewport.offsetTop <= 1),
        )).toBe(true)
      }
      if (android && nativeKey === undefined) {
        await revealConversation()
        expect(await composer.inputValue()).toBe(PROMPT)
      }
      if (nativeKey !== undefined) expect(await keyboardOpen()).toBe(true)
      const [, settled] = await Promise.all([
        nativeKey !== undefined ? tapAndroidImeKey(nativeKey)
          : layout === 'touch-landscape' ? page.keyboard.press('Enter') : activateAdminControl(send),
        scaffold.whenTurnSettled(),
      ])
      expect(settled).toBe(sessionId)
      if (nativeKey !== undefined && await keyboardOpen()) await revealConversation()
      const answer = page.getByText('LIGHTHOUSE', { exact: true })
      await answer.waitFor()
      expect(await page.locator('[data-dsh-boot]').count()).toBe(0)
      expect(await activated.count()).toBe(scenario === 'healthy' ? 1 : 0)
      if (scenario === 'optional-pending') {
        const pending = [...intercepted]
        const pendingScripts = () => page.evaluate(urls =>
          Array.from(document.scripts).filter(script => urls.includes(script.src)).length, pending)
        expect(await pendingScripts()).toBeGreaterThan(0)
        scaffold.ctx.loader.remove(pluginEntry)
        await expect.poll(pendingScripts).toBe(0)
        expect(await composer.isEnabled()).toBe(true)
      }
      await compareOrRefreshGolden(join(EXPECTED, 'conversation.expected.md'), [
        `Opened history: ${await history.textContent()}`,
        `Sent message: ${await page.getByText(PROMPT, { exact: true }).textContent()}`,
        `Assistant reply: ${await answer.textContent()}`,
      ].join('\n'), MODE)
    } catch (error) {
      await saveFailureShot(page, `web-e2e-plugin-startup-${scenario}-${layout}`)
      throw error
    } finally {
      unstall.resolve(undefined)
    }
  },
)
