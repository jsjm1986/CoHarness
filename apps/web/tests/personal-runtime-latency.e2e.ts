/** Interactive latency on two loopback Web profiles with an outbound 500 ms round-trip delay. */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { type Locator, type Page, type Response as BrowserResponse } from 'playwright'
import { expect, it } from 'vitest'
import { computerBrowser } from './computer-browser.ts'
import { clientSessionKey, type ClientRuntimeTarget } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { launchPersonalComputersFixture, personalTargets } from './personal-computers-fixture.ts'

const count = 50
const rootId = 'same-personal-session' as SessionId
const reply = fileURLToPath(new URL('./snapshots/lifecycle-chrome/session.jsonl', import.meta.url))
const p95 = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]!

type BrowserMarks = { start: number; input: number; ready: number; runtime: string }
interface CreateReceipt {
  result: {
    ok: boolean
    value?: {
      workspace?: { workspaceId: string; path: string }
      sessionId: string
      initialHistory?: { records: unknown[] }
    }
  }
}

interface PrepareStages { beforeRequest: number; network: number; afterResponse: number }
async function readied(page: Page, click: Locator, runtime: string, method: 'create' | 'history'):
Promise<{ draft: number; ready: number; stages: PrepareStages }> {
  // Observe the DOM from the actual click task. Driver polling must not inflate the local-edit sample.
  await page.evaluate(() => {
    Object.assign(window, { __dshLatency: undefined })
    document.addEventListener('click', () => {
      const marks: { start: number; input?: number; ready?: number; runtime?: string } = { start: performance.now() }
      Object.assign(window, { __dshLatency: marks })
      const measure = () => {
        const box = document.querySelector<HTMLElement>('[data-conversation-intent]')
        const field = box?.querySelector('textarea')
        if (marks.input === undefined && field && !field.disabled) {
          marks.input = performance.now()
          const target = box?.dataset.intentRuntime
          if (target !== undefined) marks.runtime = target
        }
        if (marks.input !== undefined && !box && document.querySelector('textarea:enabled')) {
          marks.ready = performance.now()
          observer.disconnect()
        }
      }
      const observer = new MutationObserver(measure)
      observer.observe(document.body, { subtree: true, childList: true, attributes: true })
      requestAnimationFrame(measure)
    }, { capture: true, once: true })
  })
  await click.click()
  await page.waitForFunction(() => (window as Window & { __dshLatency?: { ready?: number } }).__dshLatency?.ready !== undefined,
    undefined, { timeout: 10_000 })
  const result = await page.evaluate(({ method, runtime }) => {
    const mark = (window as Window & { __dshLatency?: BrowserMarks }).__dshLatency
    if (mark === undefined) throw new Error('Missing browser preparation timing')
    const entry = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).findLast((row) => {
      const url = new URL(row.name)
      return row.startTime >= mark.start && url.pathname === `/api/prepare/v1/session.${method}` && url.searchParams.get('dshRuntime') === runtime
    })
    if (!entry) throw new Error('Missing selected Runtime prepare receipt')
    return { ...mark, stages: { beforeRequest: entry.startTime - mark.start, network: entry.responseEnd - entry.startTime,
      afterResponse: Math.max(0, mark.ready - entry.responseEnd) } }
  }, { method, runtime })
  expect(result.runtime).toBe(runtime)
  return { draft: result.input - result.start, ready: result.ready - result.start, stages: result.stages }
}

it('admits fifty editable exact-target conversations under 500 ms round-trip latency', async () => {
  const fixture = await launchPersonalComputersFixture({ remoteReplay: { file: reply,
    children: Array.from({ length: count - 1 }, () => reply) } })
  const browser = await computerBrowser()
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 } })
  const ordinaryHistory = new Set<string>()
  const statusResponses: BrowserResponse[] = []
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/admit/v1/session.status') statusResponses.push(response)
  })
  page.on('request', (request) => {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/session.history') return
    const body = request.postDataJSON() as { payload: { sessionId: string } }
    ordinaryHistory.add(body.payload.sessionId)
  })
  const drafts: number[] = [], creates: number[] = [], opens: number[] = [], sends: number[] = []
  const submitted: {
    beforeRequest: number
    network: number
    browserQueue: number
    firstByte: number
    paint: number
    driver: number
    receipt: 'prompt' | 'status'
  }[] = []
  const preparedCreates: PrepareStages[] = [], openedStages: PrepareStages[] = []
  const receiptFile = process.env['DSH_BROWSER_LATENCY_RECEIPT']
  let phase = 'bootstrap', failed = false
  try {
    const coldStart = performance.now()
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded', timeout: 150_000 })
    const computer = page.getByRole('region', { name: 'Compute computer', exact: true })
    await computer.getByRole('button', { name: 'Compute computer', exact: true }).waitFor({ timeout: 150_000 })
    const coldUiMs = performance.now() - coldStart
    await computer.getByRole('button', { name: 'Compute computer', exact: true }).click()
    const workspace = computer.getByText('Compute work', { exact: true })
    await workspace.click()
    const prior = computer.getByText('Compute conversation', { exact: true })
    await prior.click()
    await page.locator('[data-conversation-intent]').waitFor({ state: 'hidden' })
    await page.evaluate(() => { performance.setResourceTimingBufferSize(5000); performance.clearResourceTimings() })
    fixture.setLatency(500)
    for (let i = 0; i < count; i++) {
      phase = 'create'
      const target = personalTargets[1]!.runtimeId
      const createAck = page.waitForResponse(r => new URL(r.url()).pathname === '/api/prepare/v1/session.create')
      void createAck.catch(() => { /* Failed click already identifies this sample as incomplete. */ })
      const created = await readied(page, i % 2 === 0 ? computer.getByRole('button', { name: 'New conversation', exact: true })
        : page.getByText('New Session', { exact: true }).first(), target, 'create')
      const native = await (await createAck).json() as CreateReceipt
      expect(native.result.ok).toBe(true)
      expect(native.result.value?.workspace?.path).toBe(fixture.worlds[1]!.workspaceCwd)
      expect(native.result.value?.initialHistory?.records).toBeInstanceOf(Array)
      expect(ordinaryHistory.has(native.result.value!.sessionId)).toBe(false)
      drafts.push(created.draft); creates.push(created.ready); preparedCreates.push(created.stages)
      const editor = page.locator('textarea:enabled').last()
      phase = 'submit'
      await editor.fill(`Latency receipt ${i + 1}`)
      const admission = page.waitForResponse(r => new URL(r.url()).pathname === '/api/admit/v1/session.prompt')
      void admission.catch(() => { /* Failed submission is already reported by the browser trace. */ })
      await page.evaluate(() => {
        document.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || !(event.target instanceof HTMLTextAreaElement)) return
          const editor = event.target
          const mark = { start: performance.now(), empty: 0 }
          Object.assign(window, { __dshSend: mark })
          function paint() {
            if (editor.value === '') mark.empty = performance.now()
            else requestAnimationFrame(paint)
          }
          requestAnimationFrame(paint)
        }, { once: true, capture: true })
      })
      const start = performance.now()
      await editor.press('Enter')
      const ack = await admission
      expect(ack.headers()['x-dsh-runtime-id']).toBe(target)
      const accepted = (await ack.json() as { result: { ok: boolean; value?: unknown; error?: { code: string } } }).result
      let receipt: 'prompt' | 'status' = 'prompt'
      if (accepted.ok) expect(accepted.value).toEqual({ accepted: true })
      else {
        expect(accepted.error?.code).toBe('prompt-durability-unavailable')
        const { sessionId, requestId } = (ack.request().postDataJSON() as { payload: { sessionId: string; requestId: string } }).payload
        const confirmation = () => statusResponses.find((response) => {
          const owner = new URL(response.url()).searchParams
          const body = response.request().postDataJSON() as { payload: { sessionId: string; requestId: string } }
          return body.payload.sessionId === sessionId && body.payload.requestId === requestId
            && owner.get('dshRuntime') === target && owner.get('dshTarget') === 'personal'
        })
        await expect.poll(() => Boolean(confirmation()), { timeout: 15_000 }).toBe(true)
        const status = confirmation()!
        expect(status.headers()['x-dsh-runtime-id']).toBe(target)
        expect((await status.json() as { result: unknown }).result).toMatchObject({ ok: true, value: { state: 'accepted' } })
        receipt = 'status'
      }
      await page.waitForFunction(() => Boolean((window as Window & { __dshSend?: { empty: number } }).__dshSend?.empty),
        undefined, { timeout: 10_000 })
      const stages = await page.evaluate(({ receipt, target }) => {
        const mark = (window as Window & { __dshSend?: { start: number; empty: number } }).__dshSend
        if (mark === undefined) throw new Error('Missing browser submission timing')
        const timings = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(row =>
          row.startTime >= mark.start && new URL(row.name).searchParams.get('dshRuntime') === target)
        const initial = timings.find(row => new URL(row.name).pathname === '/api/admit/v1/session.prompt')
        const timing = timings.findLast(row => new URL(row.name).pathname === `/api/admit/v1/session.${receipt}`)
        if (!timing || !initial) throw new Error('Missing browser admission timing')
        return { beforeRequest: initial.startTime - mark.start, network: timing.responseEnd - initial.startTime,
          browserQueue: initial.requestStart - initial.fetchStart, firstByte: initial.responseStart - initial.requestStart,
          paint: Math.max(0, mark.empty - timing.responseEnd) }
      }, { receipt, target })
      submitted.push({ ...stages, driver: performance.now() - start, receipt })
      sends.push(stages.beforeRequest + stages.network + stages.paint)
      phase = 'sidebar'
      await computer.getByText(`Latency receipt ${i + 1}`, { exact: true }).waitFor()
      const nextRows = computer.getByRole('button', { name: /show .* more sessions/i })
      if (await nextRows.isVisible()) await nextRows.click()
      phase = 'open'
      const opened = await readied(page, prior, target, 'history')
      drafts.push(opened.draft); opens.push(opened.ready); openedStages.push(opened.stages)
      if (receiptFile && opens.length % 5 === 0) await writeFile(`${receiptFile}.partial`,
        JSON.stringify({ expected: count, completed: opens.length, drafts, creates, opens, sends, submitted, preparedCreates, openedStages }) + '\n', { mode: 0o600 })
    }
    phase = 'gate'
    const accepted = submitted.map(sample => sample.beforeRequest + sample.network)
    const evidence = { version: 2, samples: count, delayMs: 500, coldUiMs, p95: { editable: p95(drafts),
      create: p95(creates), open: p95(opens), send: p95(accepted), sentVisible: p95(sends),
      driverSend: p95(submitted.map(row => row.driver)) },
    drafts, creates, opens, accepted, sends, submitted, preparedCreates, openedStages }
    console.info('Multi-computer browser latency', JSON.stringify(evidence))
    if (receiptFile) await writeFile(receiptFile, JSON.stringify(evidence) + '\n', { mode: 0o600 })
    expect(evidence.p95.editable).toBeLessThanOrEqual(150)
    for (const ms of [evidence.p95.create, evidence.p95.open, evidence.p95.send]) expect(ms).toBeLessThanOrEqual(2000)
    for (const unused of personalTargets.slice(2)) {
      expect(fixture.calls.has(unused.runtimeId)).toBe(false)
      expect(fixture.passive.has(unused.runtimeId)).toBe(false)
    }
  } catch (error) {
    failed = true
    console.error('Latency sampling failed', { phase, completed: opens.length, cause: error instanceof Error ? error.name : 'unknown' },
      fixture.receipts.slice(-4).map(row => ({
        method: row.path.startsWith('/account/api/drafts/') ? 'draft' : row.path, durationMs: row.responseAt - row.requestAt, status: row.status,
      })))
    throw error
  }
  finally {
    try { await browser.close() } finally {
      try { await fixture.close() } catch (cleanupError) {
        if (!failed) throw cleanupError
        console.error('Fixture cleanup also failed', cleanupError instanceof Error ? cleanupError.name : 'unknown')
      }
    }
  }
}, 900_000)

it('opens, edits and sends in a verified workbench pane while its sibling takes ten seconds', async () => {
  const fixture = await launchPersonalComputersFixture({ workbench: true, localReplay: { file: reply, children: [] } })
  const browser = await computerBrowser()
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 } })
  const slow = personalTargets[1]!, fast = personalTargets[0]!
  const ids = [fast, slow].map(target => clientSessionKey(target as ClientRuntimeTarget, rootId))
  const held = Promise.withResolvers<undefined>()
  let releaseAt = 0
  try {
    await page.addInitScript(({ ids, runtime }) => {
      const key = `dsh.conversation.workbenches.tab.v1.account%3A7.${runtime}`
      sessionStorage.setItem(key, JSON.stringify({ version: 3, mode: 'workbench', activeId: 'speed', workbenches: [
        { id: 'speed', name: 'Two computers', paneIds: ids, activePaneId: ids[0], paneRatios: [1, 1], updatedAt: 1 }] }))
    }, { ids, runtime: fast.runtimeId })
    await page.route('**/api/prepare/v1/session.history?**', async (route) => {
      if (new URL(route.request().url()).searchParams.get('dshRuntime') !== slow.runtimeId) return route.continue()
      const response = await route.fetch()
      held.resolve(undefined)
      await new Promise<void>(resolve => setTimeout(resolve, 10_000))
      releaseAt = performance.now()
      await route.fulfill({ response })
    })
    await page.goto(fixture.url, { waitUntil: 'load' })
    try { await expect.poll(() => fixture.receipts.some(row => row.path === '/api/prepare/v1/session.history' && row.runtimeId === slow.runtimeId), { timeout: 12_000 }).toBe(true) }
    catch (error) {
      console.error('Workbench preparation did not reach the held request', { responseCount: fixture.receipts.length })
      throw error
    }
    await held.promise
    const first = page.locator(`[data-session-pane="${ids[0]}"]`)
    const editor = first.locator('textarea:enabled')
    await editor.fill('Fast pane sends before its sibling opens')
    const [accepted] = await Promise.all([
      page.waitForResponse(row => new URL(row.url()).pathname === '/api/admit/v1/session.prompt'),
      editor.press('Enter'),
    ])
    expect(accepted.headers()['x-dsh-runtime-id']).toBe(fast.runtimeId)
    expect((accepted.request().postDataJSON() as { payload: { sessionId: string } }).payload.sessionId).toBe(rootId)
    expect((await accepted.json() as { result: unknown }).result).toEqual({ ok: true, value: { accepted: true } })
    expect(releaseAt).toBe(0)
    await expect.poll(() => editor.inputValue()).toBe('')
    await editor.fill('Fast pane remains interactive')
    const second = page.locator(`[data-session-pane="${ids[1]}"]`)
    expect(await second.locator('textarea').count()).toBe(0)
    await second.locator('textarea:enabled').waitFor({ timeout: 20_000 })
    expect(releaseAt).toBeGreaterThan(0)
    expect(await first.locator('textarea:enabled').inputValue()).toBe('Fast pane remains interactive')
  } finally { await browser.close(); await fixture.close() }
}, 90_000)
