/** Real opt-in plugin pages remain usable across phone, landscape and tablet sizes. */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, expandTurnProcesses, launchWebScaffold, seedSession, selectedSessionFixture, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { completionBarrier, REPO_ROOT, saveFailureShot } from './support.ts'
import { expectViewportFit, responsiveBrowser, responsiveBrowserName, responsiveViewports } from './responsive-browser.ts'

const run = promisify(execFile)
const experimental = join(REPO_ROOT, 'packages/experimental')

describe('web e2e: opt-in plugin responsive pages', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let scratch: string
  let translationServer: Server
  let translationFailure = false
  let translationGate: Promise<void> | undefined
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-experimental-responsive-'))
    const overlay = join(scratch, 'plugins.patch.yml')
    translationServer = createServer((request, response) => {
      request.resume()
      const reply = () => {
        response.writeHead(translationFailure ? 503 : 200, { 'content-type': 'application/json' })
        response.end(translationFailure ? '{}' : JSON.stringify(request.url?.startsWith('/google')
          ? [[['Translated reasoning remains readable on every screen.']]]
          : [{ translations: [{ text: 'Translated reasoning remains readable on every screen.' }] }]))
      }
      if (translationGate) void translationGate.then(reply)
      else reply()
    })
    await new Promise<void>(resolve => translationServer.listen(0, '127.0.0.1', resolve))
    const address = translationServer.address()
    if (address === null || typeof address === 'string') throw new Error('Translation fixture did not bind TCP')
    const translationOrigin = `http://127.0.0.1:${address.port}`
    const plugins = ['forge', 'forge-session', 'worktree', 'client-ui-forge', 'session-inspector']
    await writeFile(overlay, '- insert:\n' + plugins.map(name =>
      `    - id: responsive-${name}\n      name: '@deepseek-ai/dsh-experimental-${name}'\n`).join('')
      + `- id: translator\n  config:\n    googleEndpoint: '${translationOrigin}/google'\n    bingEndpoint: '${translationOrigin}/bing'\n`)
    const bundles = ['agent-team-profile', 'cot-translation-bundle']
    scaffold = await launchWebScaffold({
      workbench: true,
      extraInstallAnchors: [...bundles, ...plugins].map(name => join(experimental, name, 'package.json')),
      extraOverlayPath: [...bundles.map(name => join(experimental, name, 'cordis.patch.yml')), overlay],
    })
    await run('git', ['init', '-b', 'main'], { cwd: scaffold.workspaceCwd })
    await run('git', ['-c', 'user.name=Responsive fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--allow-empty', '-m', 'Initial fixture'], { cwd: scaffold.workspaceCwd })
    await writeFile(join(scaffold.workspaceCwd, 'responsive-preview.txt'), 'A local change that remains readable on every viewport.\n')
    await seedSession(scaffold, await readFile(await selectedSessionFixture(
      join(REPO_ROOT, 'snapshots/web/fresh-round-trip/session.v7.jsonl'),
    ), 'utf8'), 'experimental-responsive')
    browser = await responsiveBrowser.launch()
  }, 120_000)
  afterAll(async () => {
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally {
        try {
          if (translationServer) {
            await new Promise<void>((resolve, reject) => translationServer.close((error) => {
              if (error) reject(error)
              else resolve()
            }))
          }
        }
        finally { if (scratch) await rm(scratch, { recursive: true, force: true }) }
      }
    }
  })

  async function open(): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, hasTouch: true,
      ...(responsiveBrowserName === 'firefox' ? {} : { isMobile: true }), locale: 'en-US' })
    onTestFailed(() => saveFailureShot(page, `experimental-responsive-${responsiveBrowserName}`))
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('treeitem').first().click()
    await page.getByRole('treeitem').nth(1).click()
    return page
  }

  it('keeps Team overview and translation preferences reachable at every viewport', async () => {
    const page = await open()
    try {
      const team = page.getByRole('button', { name: 'Agent Team', exact: true })
      await team.click()
      const panel = page.locator('[data-team-panel]')
      await panel.waitFor()
      for (const viewport of responsiveViewports) {
        await page.setViewportSize(viewport)
        await expectViewportFit(page, panel, [panel.getByRole('button', { name: 'Close', exact: true })])
      }
      await page.keyboard.press('Escape')
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.getByRole('navigation', { name: 'Panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
      await page.getByRole('button', { name: 'More', exact: true }).click()
      const translation = page.getByText('Machine translation of reasoning', { exact: true })
      await translation.first().click()
      const detail = page.locator('[data-plugin-detail="@deepseek-ai/dsh-experimental-cot-translation-bundle"]')
      await detail.waitFor()
      await page.getByLabel('Translation service', { exact: true }).waitFor()
      for (const viewport of responsiveViewports) {
        await page.setViewportSize(viewport)
        await expectViewportFit(page, detail)
        const controls = detail.locator('input:not([type="checkbox"]), select')
        for (const control of await controls.all()) {
          if (!await control.isVisible()) continue
          expect(await control.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16)
        }
      }
      await page.setViewportSize({ width: 390, height: 844 })
      const language = detail.getByLabel('Target language', { exact: true })
      const save = detail.getByRole('button', { name: 'Save', exact: true })
      await language.fill('invalid language')
      await expect.poll(() => language.getAttribute('aria-invalid')).toBe('true')
      expect(await save.isDisabled()).toBe(true)
      await language.fill('ja')
      await save.click()
      await expect.poll(() => scaffold.ctx.settings.describe().find(entry => entry.ns === 'cot-translation')?.value)
        .toMatchObject({ provider: 'bing', targetLanguage: 'ja' })
      await expect.poll(() => save.isDisabled()).toBe(true)
      await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/experimental-responsive/translation-settings.expected.md'),
        await captureStableAria(page, '[data-plugin-detail]', scaffold.workspaceCwd), webSnapshotMode())
      await page.route(/\/api\/settings\.mutate(?:\?.*)?$/, route => route.abort('failed'), { times: 1 })
      await language.fill('zh')
      await save.click()
      const failure = detail.getByText('The deployment did not accept these values; they were left for you to correct.', { exact: true })
      await failure.waitFor()
      expect(await language.inputValue()).toBe('zh')
      for (const viewport of responsiveViewports) {
        await page.setViewportSize(viewport)
        await expectViewportFit(page, detail)
      }
      await save.click()
      await failure.waitFor({ state: 'hidden' })
      await expect.poll(() => save.isDisabled()).toBe(true)
      if (process.env.DSH_MOBILE_SCREENSHOTS) {
        await mkdir(process.env.DSH_MOBILE_SCREENSHOTS, { recursive: true })
        await page.screenshot({ path: join(process.env.DSH_MOBILE_SCREENSHOTS, `experimental-${responsiveBrowserName}.png`) })
      }
    } catch (error) {
      await saveFailureShot(page, `experimental-responsive-${responsiveBrowserName}`)
      console.log(await page.locator('body').ariaSnapshot())
      throw error
    } finally { await page.close() }
  })

  it('keeps original reasoning, failed translation and retry controls usable at every viewport', async () => {
    const page = await open()
    translationFailure = true
    const pending = completionBarrier()
    translationGate = pending.promise
    try {
      await expandTurnProcesses(page)
      for (const title of await page.locator('[data-step-process] [data-process-activity][aria-expanded="false"]').all()) await title.click()
      await page.getByRole('button', { name: /^Thinking / }).last().click()
      const body = page.locator('[data-cot-translation]').first()
      await body.waitFor()
      await expect.poll(() => body.getAttribute('data-translation-state')).toBe('pending')
      for (const viewport of responsiveViewports) {
        await page.setViewportSize(viewport)
        await expectViewportFit(page, body)
      }
      translationGate = undefined
      pending.resolve()
      await expect.poll(() => body.getAttribute('data-translation-state')).toBe('failed')
      for (const viewport of responsiveViewports) {
        await page.setViewportSize(viewport)
        await expectViewportFit(page, body, [body.getByRole('button', { name: 'Retry', exact: true })])
      }
      translationFailure = false
      await body.getByRole('button', { name: 'Retry', exact: true }).click()
      await expect.poll(() => body.getAttribute('data-translation-state')).toBe('ready')
      expect(await body.textContent()).toContain('Translated reasoning remains readable on every screen.')
      for (const viewport of responsiveViewports) {
        await page.setViewportSize(viewport)
        await expectViewportFit(page, body, [body.getByRole('button', { name: 'View original', exact: true })])
      }
      await body.getByRole('button', { name: 'View original', exact: true }).click()
      expect(await body.getAttribute('data-translation-view')).toBe('original')
      await body.getByRole('button', { name: 'View translation', exact: true }).click()
      expect(await body.getAttribute('data-translation-view')).toBe('translated')
      expect(await page.locator('[data-slot-error]').count()).toBe(0)
    } finally { translationFailure = false; translationGate = undefined; pending.resolve(); await page.close() }
  })
})
