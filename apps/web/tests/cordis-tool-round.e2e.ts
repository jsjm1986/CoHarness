/** Historical Cordis cards render without recreating dynamic Plugin execution. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  assertFixtureInventory, captureStableAria, collapseTurnProcesses, compareOrRefreshGolden,
  expandTurnProcesses, launchWebScaffold, realizeSeedFixture, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/cordis-tool-round/', import.meta.url))
// The raw released v3 recording comes from upstream alpha.2; the Session format catalog migrates it.
const FIXTURE = fileURLToPath(new URL('./snapshots/cordis-tool-round/session.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/cordis-tool-round/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'cordis-history-web-e2e'

function toolRecords(events: readonly SessionEvent[]) {
  return events.filter(event => event.type === 'tool/call' || event.type === 'tool/result')
    .map(event => ({ type: event.type, data: event.data }))
}

describe.skipIf(MODE === 'record')('web e2e: historical Cordis cards remain readable', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let expectedEvents: SessionEvent[]

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ cordisTools: true })
    const source = await readFile(FIXTURE, 'utf8')
    expectedEvents = parseSessionLog(realizeSeedFixture(scaffold, source, SEED_ID))
    await seedSession(scaffold, source, SEED_ID, 'standard')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const group = page.getByRole('treeitem').first()
    await group.waitFor({ timeout: 15_000 })
    await group.click()
    const session = page.getByRole('treeitem').nth(1)
    await session.waitFor({ timeout: 10_000 })
    await session.click()
    await page.getByText('CORDIS_UI_DONE', { exact: true }).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('preserves recorded calls and results without restoring tools or runtime effects', async () => {
    const persisted = await scaffold.ctx.sessionPersistence.inspect(SessionId(SEED_ID))
    expect(toolRecords(persisted.events)).toEqual(toolRecords(expectedEvents))
    const names = scaffold.ctx.tools.schemas().map(tool => tool.name)
    for (const retired of ['cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine']) {
      expect(names).not.toContain(retired)
    }
    expect(await scaffold.ctx.dynamicCordisRunner.inventory()).toEqual([])
    expect(await page.locator('[data-snapshot-probe]').count()).toBe(0)
  })

  it('renders recorded source and lifecycle outcomes in their owned cards', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-cordis-history'))
    await expandTurnProcesses(page)
    const define = page.locator('[data-tool="cordis_define"]').first()
    await define.waitFor({ timeout: 10_000 })
    await define.locator('[aria-expanded]').first().click()
    await define.getByRole('tab', { name: 'Host' }).click()
    await expect.poll(() => define.textContent()).toContain('snapshot-noop')
    await define.getByRole('tab', { name: 'Client' }).click()
    await expect.poll(() => define.textContent()).toContain('data-snapshot-probe')
    const stop = page.locator('[data-tool="cordis_stop"]').first()
    await expect.poll(() => stop.getAttribute('data-state')).toBe('ok')
    expect(await page.locator('[data-snapshot-probe]').count()).toBe(0)
    await collapseTurnProcesses(page)
  })

  it('matches the historical conversation aria golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-cordis-history-aria'))
    await page.locator('[data-conversation-scroll]').evaluate((host) => { host.scrollTop = host.scrollHeight })
    await page.mouse.move(0, 0)
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl', 'ui.expected.md'])
  })
})
