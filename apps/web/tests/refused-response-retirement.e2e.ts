/** A refused send reports its error before response cleanup and preserves the editable draft. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

interface RefusalProbe {
  requests: number
  cancelled: boolean
  released: boolean
  release(): void
}

const FIXTURE = fileURLToPath(new URL('./snapshots/plan-narrow-viewport/session.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/refused-response-retirement/draft.expected.md', import.meta.url))
const DRAFT = 'Keep this draft after the refused send'

it('keeps the draft and removes an unadmitted echo while HTTP refusal cleanup is pending', async () => {
  const scaffold = await launchWebScaffold({ replayFixture: FIXTURE, replayProvidersOnly: true })
  onTestFinished(() => scaffold.close())
  const events: SessionEvent[] = []
  scaffold.ctx.on('session/event', (_session, event) => { events.push(event) })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-refused-response-retirement'))
  await page.addInitScript(() => {
    const original = globalThis.fetch.bind(globalThis)
    let release: () => void = () => {}
    const acknowledgement = new Promise<void>((resolve) => { release = resolve })
    const probe: RefusalProbe = {
      requests: 0, cancelled: false, released: false,
      release() { probe.released = true; release() },
    }
    ;(window as typeof window & { __refusalProbe?: RefusalProbe }).__refusalProbe = probe
    globalThis.fetch = async (input, init) => {
      const address = input instanceof Request ? input.url : String(input)
      if (new URL(address, location.href).pathname === '/api/session.prompt') {
        probe.requests++
        return new Response(new ReadableStream<Uint8Array>({
          cancel() { probe.cancelled = true; return acknowledgement },
        }), { status: 503, headers: { 'content-type': 'application/json' } })
      }
      return original(input, init)
    }
  })
  try {
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const input = page.locator('textarea:enabled').first()
    await input.fill(DRAFT)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(() => page.evaluate(() =>
      (window as typeof window & { __refusalProbe?: RefusalProbe }).__refusalProbe?.cancelled,
    )).toBe(true)
    const failure = page.getByRole('alert').filter({ hasText: 'HTTP 503' })
    await failure.waitFor({ timeout: 15_000 })
    expect(await input.inputValue()).toBe(DRAFT)
    await expect.poll(() => page.locator('[data-chat-flow]').getByText(DRAFT, { exact: true }).count()).toBe(0)
    expect(events.some(event => event.type === 'user/message' || event.type === 'turn/start')).toBe(false)
    expect(await page.evaluate(() => {
      const probe = (window as typeof window & { __refusalProbe?: RefusalProbe }).__refusalProbe
      return { requests: probe?.requests, released: probe?.released }
    })).toEqual({ requests: 1, released: false })
    await saveFailureShot(page, 'web-e2e-refused-response-retirement-before-release')
    // The retained composer is the stable end state after the transient error announcement.
    await failure.waitFor({ state: 'detached', timeout: 15_000 })
    await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, 'body', scaffold.workspaceCwd), webSnapshotMode())
    expect(console.pageErrors).toEqual([])
  } finally {
    if (!page.isClosed()) {
      await page.evaluate(() => {
        (window as typeof window & { __refusalProbe?: RefusalProbe }).__refusalProbe?.release()
      })
    }
  }
})
