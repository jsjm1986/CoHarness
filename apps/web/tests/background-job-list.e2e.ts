// Web e2e scenario: the session-header background-job list over the real
// host. No model call is involved — a genuine `run_in_background` bash call
// registers with `ctx.jobs`, and the assertion chain is the whole delivery
// path: registry change feed → api-proxy `session/jobs` frame → the client's
// `jobsBySession` mirror → the header action.
import { responsiveBrowser } from './responsive-browser.ts'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page, Route } from 'playwright'

import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { JobId, type JobHandle, type JobOutcome } from '@deepseek-ai/dsh-jobs'
import {
  assertFixtureInventory, captureStableAria,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'
import { auditWorkflowState, compareWorkflowGolden, newWorkflowPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'

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

async function auditJobState(page: Page, state: string, surface: Locator,
  controls: readonly Locator[] = [], prepare?: () => Promise<void>): Promise<void> {
  await auditWorkflowState(page, 'jobs', state, surface, controls, prepare, async () => {
    const targets = await surface.locator('button:enabled').evaluateAll(elements => elements.flatMap((element) => {
      const box = element.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) return []
      return box.width >= 44 && box.height >= 44 ? []
        : [{ label: element.getAttribute('aria-label') ?? element.textContent, width: box.width, height: box.height }]
    }))
    expect(targets, 'Job touch actions have at least 44×44 CSS pixels').toEqual([])
  })
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
    browser = await responsiveBrowser.launch()
    page = await newWorkflowPage(browser)
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

    const started = (await scaffold.ctx.tools.execute({
      signal: new AbortController().signal,
      calls: [{
        type: 'tool-call',
        id: ToolCallId('background-job-list-e2e'),
        name: 'bash',
        arguments: JSON.stringify({ command: COMMAND, description: 'Hold a background slot open', run_in_background: true }),
      }],
      agent,
    })).results[0]!.result
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
    await compareWorkflowGolden(RUNNING_EXPECTED, snapshot, MODE)
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
    await compareWorkflowGolden(SETTLED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it.skipIf(!workflowMatrixEnabled)('keeps every job lifecycle, output and stop state reachable across touch viewports', async () => {
    const menu = page.getByRole('list', { name: 'Background jobs' })
    await menu.getByRole('button', { name: 'Clear', exact: true }).tap()
    const owned: Array<ReturnType<typeof Promise.withResolvers<JobOutcome>>> = []
    const start = (label: string) => {
      const settled = Promise.withResolvers<JobOutcome>()
      const handle = Promise.withResolvers<JobHandle>()
      const cancelled = Promise.withResolvers<undefined>()
      owned.push(settled)
      const id = scaffold.ctx.jobs.start({ kind: 'bash', label, owner: agent.id,
        run(job) { handle.resolve(job); return { done: settled.promise, cancel: () => { cancelled.resolve(undefined) } } },
      })
      return { id, handle: handle.promise, finish: settled.resolve, cancelled: cancelled.promise }
    }
    const label = 'Inspect retained output for the background execution'
    const running = start(label)
    const releaseKill = Promise.withResolvers<undefined>()
    const killArrived = Promise.withResolvers<undefined>()
    const killPattern = /\/api\/jobs\.kill(?:\?.*)?$/
    const outputPattern = /\/api\/jobs\.output(?:\?.*)?$/
    const refusal = { result: { ok: false, error: { code: 'job-not-found', message: 'Job is unavailable', details: { jobId: running.id } } } }
    const refuse = (route: Route) => {
      const request = route.request().postDataJSON() as { rpcId: string }
      return route.fulfill({ json: { type: 'server-response', rpcId: request.rpcId, ...refusal } })
    }
    try {
      await page.getByRole('button', { name: '1 background job running', exact: true }).tap()
      await auditJobState(page, 'running-collapsed', menu)
      await menu.getByRole('button', { name: `Show live output of ${label}`, exact: true }).tap()
      await auditJobState(page, 'running-empty-output', menu)
      ;(await running.handle).append('First output line\nLong output location /workspace/LongBackgroundTaskIdentifierWithoutSpaces0123456789\n')
      await menu.getByText('First output line', { exact: false }).waitFor()
      await auditJobState(page, 'running-output', menu)

      await page.route(outputPattern, refuse)
      await menu.getByRole('button', { name: `Hide live output of ${label}`, exact: true }).tap()
      await menu.getByRole('button', { name: `Show live output of ${label}`, exact: true }).tap()
      await menu.getByText(/live output stream interrupted/).waitFor()
      await auditJobState(page, 'output-refused', menu)
      await page.unroute(outputPattern)
      await menu.getByRole('button', { name: `Hide live output of ${label}`, exact: true }).tap()
      await menu.getByRole('button', { name: `Show live output of ${label}`, exact: true }).tap()
      await menu.getByText('First output line', { exact: false }).waitFor()

      const stop = menu.locator('button[data-kill-state]')
      await auditJobState(page, 'stop-confirmation', menu.filter({ has: page.locator('[data-kill-state="armed"]') }), [stop], async () => {
        if (await stop.getAttribute('data-kill-state') !== 'armed') await stop.tap()
      })
      await page.route(killPattern, refuse)
      await auditJobState(page, 'stop-refused', menu.filter({ has: page.locator('[data-kill-state="failed"]') }), [stop], async () => {
        if (await stop.getAttribute('data-kill-state') === 'failed') return
        if (await stop.getAttribute('data-kill-state') !== 'armed') await stop.tap()
        await stop.tap()
        await expect.poll(() => stop.getAttribute('data-kill-state')).toBe('failed')
      })
      await page.unroute(killPattern)
      await page.route(killPattern, async (route) => {
        killArrived.resolve(undefined)
        await releaseKill.promise
        await route.continue()
      })
      if (await stop.getAttribute('data-kill-state') !== 'armed') await stop.tap()
      await stop.tap()
      await killArrived.promise
      await auditJobState(page, 'stop-pending', menu.filter({ has: page.locator('[data-kill-state="pending"]') }), [stop])
      releaseKill.resolve(undefined)
      await running.cancelled
      await expect.poll(() => scaffold.ctx.jobs.list(agent.id).find(job => job.id === running.id)?.status).toBe('stopping')
      await expect.poll(() => stop.count()).toBe(0)
      await auditJobState(page, 'stopping', menu)
      running.finish({ status: 'killed', detail: 'Stopped after releasing the owned worker' })
      await menu.getByText('Stopped after releasing the owned worker', { exact: false }).waitFor()
      await auditJobState(page, 'killed-output', menu)

      const completed = start('Completed background execution')
      ;(await completed.handle).append('Completed output\n')
      completed.finish({ status: 'completed', detail: 'exit code: 0' })
      const failed = start('Failed background execution')
      ;(await failed.handle).append('Failure diagnostics\n', { channel: 'stderr' })
      failed.finish({ status: 'failed', detail: 'exit code: 2' })
      await expect.poll(() => scaffold.ctx.jobs.list(agent.id).filter(job => job.id === completed.id || job.id === failed.id).every(job => job.status !== 'running')).toBe(true)
      await menu.getByRole('button', { name: 'Show live output of Completed background execution', exact: true }).tap()
      await menu.getByText('Completed output', { exact: false }).waitFor()
      await auditJobState(page, 'completed-output', menu)
      await menu.getByRole('button', { name: 'Show live output of Failed background execution', exact: true }).tap()
      await menu.getByText('Failure diagnostics', { exact: false }).waitFor()
      await auditJobState(page, 'failed-output', menu)
      await menu.getByRole('button', { name: /3 finished/ }).tap()
      await auditJobState(page, 'finished-collapsed', menu)
      await menu.getByRole('button', { name: 'Clear', exact: true }).tap()
      await menu.waitFor({ state: 'hidden' })
      await auditJobState(page, 'cleared', page.locator('[class*="centerCol"]'))
    } finally {
      releaseKill.resolve(undefined)
      await page.unroute(killPattern)
      await page.unroute(outputPattern)
      for (const settled of owned) settled.resolve({ status: 'killed', detail: 'fixture teardown' })
      await Promise.all(owned.map(settled => settled.promise))
    }
  }, 300_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['running.expected.md', 'settled.expected.md'])
  })
})
