// Web e2e scenario: the session-header background-job list over the real
// host. No model call is involved — a genuine `run_in_background` bash call
// registers with `ctx.jobs`, and the assertion chain is the whole delivery
// path: registry change feed → api-proxy `session/jobs` frame → the client's
// `jobsBySession` mirror → the header action.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { JobId } from '@deepseek-ai/dsh-jobs'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./snapshots/fresh-round-trip/session.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/background-job-list', import.meta.url))
const RUNNING_EXPECTED = join(SNAPSHOT_DIR, 'running.expected.md')
const SETTLED_EXPECTED = join(SNAPSHOT_DIR, 'settled.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'background-job-list-web-e2e'
// Long enough that the running assertions never race the process exiting on
// their own; the test kills it explicitly to reach the settled state.
const COMMAND = 'sleep 45'

/**
 * Wait for the Host to publish the live Agent that opening a session resumes.
 * @param scaffold - the booted web scaffold.
 * @param sessionId - the opened session's identity.
 * @returns the registered Agent instance.
 */
async function liveAgent(scaffold: WebScaffold, sessionId: SessionId): Promise<Agent> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const found = scaffold.ctx.agents.get(sessionId)
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error(`opening session "${sessionId}" published no live Agent`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

describe.skipIf(MODE === 'record')('web e2e: background job list', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let agent: Agent
  let jobId: JobId

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()

    // Opening the session drives the Host's ordinary Agent resolution; the
    // job owner must be that exact live instance, never a second one.
    // `expect.poll` is test-scoped, so this hook polls by hand.
    agent = await liveAgent(scaffold, SessionId(SEED_ID))
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows a running background job in the session header without a refresh', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-background-job-running'))
    // Point assertion, not a poll: `expect.poll` retries until a predicate
    // holds, so polling for zero passes at t=0 and proves nothing. The
    // "renders nothing without a task" branch is owned by the component suite.
    const trigger = page.getByRole('button', { name: '1 background job running' })
    expect(await trigger.count()).toBe(0)

    const started = await scaffold.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('background-job-list-e2e'),
      name: 'bash',
      arguments: { command: COMMAND, description: 'Hold a background slot open', run_in_background: true },
      agent,
    })
    const reported = started.content.map(block => block.type === 'text' ? block.text : '').join('')
    const matched = /\bbash-[0-9a-f]{16}\b/.exec(reported)
    if (matched === null) throw new Error(`background bash reported no job id: ${reported}`)
    jobId = JobId(matched[0])

    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    const row = page.getByRole('list', { name: 'Background jobs' }).getByRole('listitem').first()
    await row.waitFor({ timeout: 10_000 })
    await expect.poll(() => row.textContent()).toContain(COMMAND)

    const snapshot = await captureStableAria(page, '[class*="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(RUNNING_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('flips the open list to the cancelled outcome when the registry settles it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-background-job-settled'))
    expect(scaffold.ctx.jobs.kill(jobId, agent.id, 'web e2e cancellation')).toBe('requested')

    // The trigger drops its live count once the task leaves running/stopping,
    // which is also the proof that settlement reached the browser unprompted.
    // Exact match: the live label is a superstring of the idle one, so a
    // substring match would resolve while the job still runs.
    const idle = page.getByRole('button', { name: '1 background job', exact: true })
    await idle.waitFor({ timeout: 20_000 })

    const snapshot = await captureStableAria(page, '[class*="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(SETTLED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps the open list above the expanded right sidebar and in the header Tab order', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-background-job-right-sidebar'))
    const trigger = page.getByRole('button', { name: '1 background job', exact: true })
    if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.click()
    await page.getByRole('button', { name: 'Open right sidebar' }).click()
    const sidebar = page.locator('[data-rightbar-col]')
    // A toggle holds data-animating on the frame until its tracks settle.
    await expect.poll(() => sidebar.evaluate(column => column.parentElement?.hasAttribute('data-animating'))).toBe(false)
    await trigger.click()
    const list = page.getByRole('list', { name: 'Background jobs' })
    await list.waitFor({ timeout: 10_000 })
    // The list crosses into the sidebar column, so the hit test below covers it.
    const [menuBox, sidebarBox] = await Promise.all([list.boundingBox(), sidebar.boundingBox()])
    if (menuBox === null || sidebarBox === null) throw new Error('job list geometry is unavailable')
    expect(menuBox.x + menuBox.width).toBeGreaterThan(sidebarBox.x)
    // Every corner of the list hit-tests to the list itself; the inset clears its rounded corners.
    const covered = await list.evaluate((menu) => {
      const rect = menu.getBoundingClientRect()
      const inset = 20
      const points: Array<[number, number]> = [
        [rect.left + inset, rect.top + inset], [rect.right - inset, rect.top + inset],
        [rect.left + inset, rect.bottom - inset], [rect.right - inset, rect.bottom - inset],
      ]
      return points.filter(([x, y]) => !menu.contains(document.elementFromPoint(x, y)))
    })
    expect(covered).toEqual([])

    // Keyboard order matches the in-place list: the trigger leads into the
    // list, and Tab off its last control reaches the control after the trigger.
    const after = await trigger.evaluate((node) => {
      const all = [...document.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')]
      const outside = all.filter(el => el.closest('[aria-label="Background jobs"]') === null && el.tabIndex >= 0)
      return outside[outside.indexOf(node as HTMLElement) + 1]?.outerHTML.slice(0, 120)
    })
    expect(after).toMatch(/^<button/)
    await trigger.focus()
    await page.keyboard.press('Tab')
    expect(await list.evaluate(menu => menu.contains(document.activeElement))).toBe(true)
    const controls = await list.evaluate(menu => menu.querySelectorAll('button:not(:disabled)').length)
    for (let i = 1; i < controls; i += 1) await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))).toBe(after)
    await trigger.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Escape')
    await list.waitFor({ state: 'detached', timeout: 10_000 })
    expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true)
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['running.expected.md', 'settled.expected.md'])
  })
})
