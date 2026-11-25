/** Opt-in measurements through an existing, authorized Web UI. No server or Runtime is launched here. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { launchComputerBrowser, type Browser, type BrowserContext, type Locator, type Page, type BrowserResponse, type BrowserRequest } from '../../apps/web/tests/computer-browser.ts'
import { armPreparationClock, type PreparationMarks } from '../../apps/web/tests/browser-latency-clock.ts'
import { clientSessionKey } from '../../packages/host/apiproxy/src/api/client-session.ts'
import type { ClientRuntimeId } from '../../packages/host/apiproxy/src/api/client-session.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { authenticationCookie, MeasurementError, object, privateText, measurementPlan, type ExistingLatencyConfig } from './config.ts'
import { assertDurableReceiptRequest, assertReadyRuntime, assertRenameReceipt, assertRequestTarget, correlatedRpcValue, failure, operationId, resourceOperation, summarize, type LatencySample } from './report.ts'
import { boundedJson } from './read.ts'

function sessionKey(config: Pick<ExistingLatencyConfig, 'runtimeId'>, id: string): string {
  return clientSessionKey({ kind: 'personal', runtimeId: config.runtimeId as ClientRuntimeId }, id as SessionId)
}
function attribute(name: string, value: string): string { return `[${name}=${JSON.stringify(value)}]` }

/** Wait for the target computer group or its ungrouped single-computer workspace.
 * @param page - owned browser page with the authenticated QA context.
 * @param config - exact computer name, workspace identity and unchanged browser wait limit.
 */
export async function waitForInitialDirectory(page: Pick<Page, 'getByRole' | 'locator'>,
  config: Pick<ExistingLatencyConfig, 'computerName' | 'workspaceId' | 'timeoutMs'>): Promise<void> {
  await page.getByRole('region', { name: config.computerName, exact: true })
    .or(page.locator(attribute('data-row-key', `workspace:${config.workspaceId}`))).first()
    .waitFor({ state: 'visible', timeout: config.timeoutMs })
}

/** Reveal the exact history row through its workspace controls before arming click measurements.
 * @param page - owned browser page; only directory expansion, pagination and scrolling are performed.
 * @param config - exact Runtime, workspace and dedicated history with the existing setup deadline.
 * @returns the verified, actionable history row; absence or stalled pagination fails within that deadline.
 */
export async function revealHistoryRow(page: Page,
  config: Pick<ExistingLatencyConfig, 'runtimeId' | 'workspaceId' | 'historySessionId' | 'historyTitle' | 'language' | 'timeoutMs'>): Promise<Locator> {
  const deadline = performance.now() + config.timeoutMs
  const remaining = (): number => {
    const value = deadline - performance.now()
    if (value <= 0) throw new MeasurementError('history-row-setup-timeout')
    return value
  }
  const workspaceKey = `workspace:${config.workspaceId}`
  const workspace = page.locator(attribute('data-row-key', workspaceKey))
  await workspace.waitFor({ state: 'visible', timeout: remaining() })
  if (await workspace.getAttribute('aria-expanded', { timeout: remaining() }) !== 'true') await workspace.click({ timeout: remaining() })
  // SessionTree's tree is inside its body, inside one Runtime's directory and paging controls.
  const directory = workspace.locator('xpath=ancestor::*[@role="tree"][1]/../..')
  const row = directory.locator(attribute('data-row-key', `session:${sessionKey(config, config.historySessionId)}`))
  const overflow = directory.locator(`${attribute('data-row-key', `overflow:${config.workspaceId}`)}[aria-expanded="false"]`).filter({ visible: true })
  const moreLabel = config.language === 'en' ? 'More workspaces and conversations' : '更多工作区与对话'
  const more = directory.locator(':scope > button').and(directory.getByRole('button', { name: moreLabel, exact: true })).filter({ visible: true })
  for (;;) {
    await row.or(overflow).or(more).first().waitFor({ state: 'visible', timeout: remaining() })
    if (await row.count() !== 0) {
      await row.scrollIntoViewIfNeeded({ timeout: remaining() })
      await row.click({ trial: true, timeout: remaining() })
      if (!(await row.innerText({ timeout: remaining() })).includes(config.historyTitle)) throw new MeasurementError('dedicated-history-title-mismatch')
      return row
    }
    const before = await directory.locator('[data-row-key]').evaluateAll(rows => rows.map(item => item.getAttribute('data-row-key')))
    const paging = await overflow.count() === 0
    const control = paging ? more : overflow
    await control.scrollIntoViewIfNeeded({ timeout: remaining() })
    await control.click({ timeout: remaining() })
    await page.waitForFunction(({ workspaceKey, before, paging, moreLabel }) => {
      const workspace = [...document.querySelectorAll('[data-row-key]')].find(item => item.getAttribute('data-row-key') === workspaceKey)
      const directory = workspace?.closest('[role="tree"]')?.parentElement?.parentElement
      if (!directory) return false
      const after = [...directory.querySelectorAll('[data-row-key]')].map(item => item.getAttribute('data-row-key'))
      return after.length !== before.length || after.some((key, index) => key !== before[index])
        || paging && ![...directory.children].some(item => item.tagName === 'BUTTON' && item.textContent === moreLabel)
    }, { workspaceKey, before, paging, moreLabel }, { timeout: remaining() })
  }
}

function payload(response: BrowserResponse): Record<string, unknown> { return object(object(response.request().postDataJSON()).payload) }
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/u.test(value)) throw new MeasurementError('invalid-operation-identity')
  return value
}
async function privateParent(file: string): Promise<void> {
  const parent = dirname(file), stat = await lstat(parent)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0
    || await realpath(parent) !== parent) throw new MeasurementError('canonical-private-output-parent-required')
}
async function append(handle: FileHandle, value: unknown): Promise<void> { await handle.appendFile(JSON.stringify(value) + '\n'); await handle.sync() }

/** Preserve a validated durable prompt receipt before observing later browser endpoints.
 * @param receipts - this run's private append-only output.
 * @param sample - action metadata after exact receipt validation.
 * @param observe - read the browser clock and wait for visible settlement; failure still stops the run.
 */
export async function observeAcceptedPrompt(receipts: FileHandle, sample: LatencySample, observe: () => Promise<void>): Promise<void> {
  const { index, sessionId, requestId, receipt, operationId, httpStatus } = sample
  await append(receipts, { kind: 'checkpoint', checkpoint: 'durable-send-accepted', operation: 'durable-send',
    index, sessionId, requestId, receipt, operationId, httpStatus })
  await observe()
}

/** Collect the final browser marks whether or not the measured action succeeds.
 * Preserves an earlier measurement error when the browser can no longer evaluate final marks.
 * @param measure - operation whose result is being measured.
 * @param collect - remove observers and read any marks still available.
 * @returns the measured result.
 */
export async function withFinalBrowserClock<T>(measure: () => Promise<T>, collect: () => Promise<void>): Promise<T> {
  let failed = false
  try {
    return await measure()
  } catch (error) {
    failed = true
    throw error
  } finally {
    if (failed) {
      try { await collect() } catch { /* Preserve the earlier measurement failure when final browser marks cannot be read. */ }
    } else {
      await collect()
    }
  }
}

/** Narrow event-source interface shared by Playwright Page and unit-test harnesses. */
export interface ResourceTraceTarget {
  on(event: 'request' | 'requestfailed', listener: (request: BrowserRequest) => void): unknown
  on(event: 'response', listener: (response: BrowserResponse) => void): unknown
}

/** Per-pathname count, HTTP status breakdown, and maximum duration for initial-open API traffic. */
export interface InitialRpcBucket {
  count: number
  statuses: Record<string, number>
  maxMs?: number
}

/** Pathname-only API telemetry split between cold page boot and history-row setup. */
export interface InitialRpcSummary {
  boot: Record<string, InitialRpcBucket>
  setup: Record<string, InitialRpcBucket>
}

const BOOT_RPC_STAGES = new Set(['initial-navigation', 'initial-computer-directory'])
const SETUP_RPC_STAGES = new Set(['initial-workspace-selection', 'initial-history-row', 'initial-history-click', 'initial-history-content'])

/**
 * Observe bounded, content-free resource traces and initial API pathname telemetry on a browser page.
 * @param page - Playwright page or test double emitting request lifecycle events.
 * @param config - exact target coordinates used to classify bootstrap, script and Workspace file calls.
 * @param currentStage - returns the runner's current stage label when each request starts.
 * @param tracedRequests - shared per-request map so response and failure events update the same trace record.
 * @param requestTrace - fallback resolver for `/api/prepare/v1/*` and `/api/admit/v1/*` failure records.
 * @returns bounded `resourceTraces` list (at most 32) and pathname-only `initialRpcSummary` (at most 64 paths per phase).
 */
export function attachResourceTraceObservers(
  page: ResourceTraceTarget,
  config: Pick<ExistingLatencyConfig, 'origin' | 'runtimeId' | 'nodeId'>,
  currentStage: () => string,
  tracedRequests: WeakMap<BrowserRequest, Record<string, unknown>> = new WeakMap(),
  requestTrace: (request: BrowserRequest) => Record<string, unknown> | undefined = request => tracedRequests.get(request),
): { resourceTraces: Array<Record<string, unknown>>; initialRpcSummary: InitialRpcSummary } {
  const resourceTraces: Array<Record<string, unknown>> = []
  const initialRpcSummary: InitialRpcSummary = { boot: {}, setup: {} }
  const rpcStarts = new WeakMap<BrowserRequest, { bucket: InitialRpcBucket; started: number }>()
  page.on('request', (request) => {
    const stage = currentStage()
    const phase = BOOT_RPC_STAGES.has(stage) ? 'boot' : SETUP_RPC_STAGES.has(stage) ? 'setup' : undefined
    if (phase !== undefined) {
      try {
        const url = new URL(request.url())
        if (url.origin === config.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/account/api/'))) {
          const table = initialRpcSummary[phase]
          const path = url.pathname
          if (Object.hasOwn(table, path) || Object.keys(table).length < 64) {
            const bucket = table[path] ?? (table[path] = { count: 0, statuses: {} })
            bucket.count += 1
            rpcStarts.set(request, { bucket, started: performance.now() })
          }
        }
      } catch { /* Malformed request URLs are ignored by pathname counters. */ }
    }
    if (resourceTraces.length >= 32) return
    let operation: ReturnType<typeof resourceOperation>
    try {
      operation = resourceOperation(request.method(), request.url(), request.headers().referer, config)
    } catch {
      /* Malformed request URLs are ignored by resource traces. */
      return
    }
    if (operation === undefined) return
    const trace: Record<string, unknown> = { stage, operation }
    resourceTraces.push(trace)
    tracedRequests.set(request, trace)
  })
  page.on('response', (response) => {
    const request = response.request()
    const rpc = rpcStarts.get(request)
    if (rpc !== undefined) {
      const code = String(response.status())
      rpc.bucket.statuses[code] = (rpc.bucket.statuses[code] ?? 0) + 1
      const elapsed = Math.round(Math.max(0, performance.now() - rpc.started) * 100) / 100
      rpc.bucket.maxMs = rpc.bucket.maxMs === undefined ? elapsed : Math.max(rpc.bucket.maxMs, elapsed)
    }
    const trace = tracedRequests.get(request)
    if (trace === undefined) return
    trace.status = response.status()
    const id = operationId(response.headers()['x-dsh-operation-id'], request.headers()['x-dsh-operation-id'])
    if (id !== undefined) trace.operationId = id
  })
  page.on('requestfailed', (request) => {
    const rpc = rpcStarts.get(request)
    if (rpc !== undefined) rpc.bucket.statuses.failed = (rpc.bucket.statuses.failed ?? 0) + 1
    const trace = requestTrace(request)
    if (!trace) return
    const errorText = request.failure()?.errorText
    trace.failure = errorText && /^net::ERR_[A-Z0-9_]+$/u.test(errorText) ? errorText : 'browser-request-failed'
  })
  return { resourceTraces, initialRpcSummary }
}

async function readBootMarks(page: Page): Promise<Array<{ name: string; startTime: number }>> {
  return page.evaluate(() => performance.getEntriesByType('mark')
    .filter(entry => entry.name.startsWith('dsh:boot:'))
    .map(entry => ({ name: entry.name, startTime: Math.round(entry.startTime * 100) / 100 })))
}

async function ready(config: ExistingLatencyConfig, cookie: { name: string; value: string }): Promise<void> {
  const url = new URL('/account/api/runtimes', config.origin)
  url.searchParams.set('ids', config.runtimeId)
  const response = await fetch(url, { headers: { cookie: `${cookie.name}=${cookie.value}`, 'x-dsh-expected-principal-id': String(config.accountId) },
    redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs) })
  if (!response.ok) throw new MeasurementError(`runtime-directory-http-${response.status}`)
  assertReadyRuntime(await boundedJson(response, 1024 * 1024), config)
}

async function accepted(response: BrowserResponse, config: ExistingLatencyConfig, sample: LatencySample): Promise<Record<string, unknown>> {
  assertRequestTarget(response.url(), response.request().headers()['x-dsh-expected-principal-id'], config)
  sample.httpStatus = response.status()
  const headers = response.headers()
  const operation = operationId(headers['x-dsh-operation-id'], response.request().headers()['x-dsh-operation-id'])
  if (operation === undefined) delete sample.operationId
  else sample.operationId = operation
  if (!response.ok()) throw new MeasurementError(`http-${response.status()}`)
  if (headers['x-dsh-runtime-id'] !== config.runtimeId) throw new MeasurementError('response-runtime-mismatch')
  const duration = headers['x-dsh-host-duration-ms']
  if (duration !== undefined && Number.isFinite(Number(duration)) && Number(duration) >= 0) sample.hostDurationMs = Number(duration)
  return correlatedRpcValue(await response.json(), response.request().postDataJSON())
}

async function preparation(page: Page, config: ExistingLatencyConfig, click: Locator, method: 'create' | 'history', sample: LatencySample) {
  await armPreparationClock(page, method === 'history' ? { sessionKey: sessionKey(config, config.historySessionId), marker: config.historyMarker } : undefined)
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/prepare/v1/session.${method}`,
    { timeout: config.timeoutMs })
  void responsePromise.catch(() => { /* The attempt records the failure; this parallel waiter owns no retry. */ })
  const observe = (request: BrowserRequest) => {
    if (new URL(request.url()).pathname !== `/api/prepare/v1/session.${method}`) return
    sample.requests = (sample.requests ?? 0) + 1
    const body = object(object(request.postDataJSON()).payload)
    if (typeof body.sessionId === 'string' && /^[A-Za-z0-9_-]{1,160}$/u.test(body.sessionId)) sample.sessionId = body.sessionId
    const operation = operationId(undefined, request.headers()['x-dsh-operation-id'])
    if (operation !== undefined && sample.operationId === undefined) sample.operationId = operation
  }
  page.on('request', observe)
  const driver = performance.now()
  return await withFinalBrowserClock(async () => {
    await click.click()
    const response = await responsePromise
    const attemptedSession = payload(response).sessionId
    if (attemptedSession !== undefined) sample.sessionId = id(attemptedSession)
    const value = await accepted(response, config, sample)
    const original = method === 'create' ? id(value.sessionId) : id(payload(response).sessionId)
    sample.sessionId = original
    if (method === 'create') {
      const workspace = object(value.workspace)
      if (workspace.workspaceId !== config.workspaceId || workspace.path !== config.workspacePath
        || !Array.isArray(object(value.initialHistory).records)) {
        throw new MeasurementError('created-workspace-mismatch')
      }
    } else if (original !== config.historySessionId) throw new MeasurementError('history-session-mismatch')
    await page.waitForFunction(({ key, marker }) => {
      const chat = [...document.querySelectorAll<HTMLElement>('[data-conversation-session]')].find(row => row.dataset.conversationSession === key)
      const mark = (window as Window & { __dshLatency?: { ready?: number } }).__dshLatency
      return mark?.ready !== undefined && chat !== undefined && (marker === null || chat.textContent.includes(marker))
    }, { key: sessionKey(config, original), marker: method === 'history' ? config.historyMarker : null }, { timeout: config.timeoutMs })
    const timing = await page.evaluate(({ path, runtime }) => {
      const mark = (window as Window & { __dshLatency?: PreparationMarks }).__dshLatency
      const row = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).findLast(entry =>
        mark !== undefined && entry.startTime >= mark.start && new URL(entry.name).pathname === path && new URL(entry.name).searchParams.get('dshRuntime') === runtime)
      return { mark, row: row && { start: row.startTime, end: row.responseEnd } }
    }, { path: `/api/prepare/v1/session.${method}`, runtime: config.runtimeId })
    if (timing.mark?.runtime !== config.runtimeId || timing.mark.input === undefined || timing.mark.ready === undefined || !timing.row) {
      throw new MeasurementError('missing-browser-preparation-clock')
    }
    sample.editableMs = timing.mark.input - timing.mark.start
    sample.readyMs = timing.mark.ready - timing.mark.start
    sample.beforeRequestMs = timing.row.start - timing.mark.start
    sample.transportMs = timing.row.end - timing.row.start
    sample.afterResponseMs = Math.max(0, timing.mark.ready - timing.row.end)
    return original
  }, async () => {
    page.off('request', observe)
    sample.driverMs = performance.now() - driver
    const mark = await page.evaluate(() => {
      const state = window as Window & { __dshLatency?: PreparationMarks; __dshLatencyStop?: () => void }
      state.__dshLatencyStop?.()
      return state.__dshLatency
    })
    if (mark?.input !== undefined) sample.editableMs = mark.input - mark.start
  })
}

interface RenameSessionRequest {
  origin: string
  runtime: string
  node: string
  account: number
  session: string
  title: string
  rpcId: string
  timeoutMs: number
}

interface RenameSessionBrowser {
  evaluate(
    run: (request: RenameSessionRequest) => Promise<{ status: number; body: unknown }>,
    request: RenameSessionRequest,
  ): Promise<{ status: number; body: unknown }>
}

/** Name an already confirmed test Session through its exact ordinary RPC target.
 * @param page - owned browser page with the authenticated QA context.
 * @param config - explicit account, node and Runtime coordinates.
 * @param sessionId - Session created by this measurement run.
 * @param title - synthetic title expected in the correlated title-event receipt.
 */
export async function renameTestSession(
  page: RenameSessionBrowser, config: ExistingLatencyConfig, sessionId: string, title: string,
): Promise<void> {
  const rpcId = randomUUID()
  const response = await page.evaluate(async ({ origin, runtime, node, account, session, title, rpcId, timeoutMs }) => {
    const url = new URL('/api/session.rename', origin)
    url.search = new URLSearchParams({ dshRuntime: runtime, dshNode: node, dshTarget: 'personal' }).toString()
    const response = await fetch(url, { method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-dsh-expected-principal-id': String(account) }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'session.rename', payload: { sessionId: session, title } }) })
    const body: unknown = await response.json()
    return { status: response.status, body }
  }, { origin: config.origin, runtime: config.runtimeId, node: config.nodeId, account: config.accountId, session: sessionId,
    title, rpcId, timeoutMs: config.timeoutMs })
  if (response.status !== 200) throw new MeasurementError('test-session-naming-failed')
  assertRenameReceipt(response.body, rpcId, title)
}

async function send(page: Page, config: ExistingLatencyConfig, receipts: FileHandle,
  sample: LatencySample, sessionId: string, text: string): Promise<void> {
  const chat = page.locator(attribute('data-conversation-session', sessionKey(config, sessionId)))
  const selected = await chat.locator('[data-model-trigger]').innerText()
  if (!selected.includes(config.testModelLabel)) throw new MeasurementError('controlled-test-model-not-selected')
  const editor = chat.locator('textarea:enabled')
  await editor.fill(text)
  await page.evaluate(({ key, sendLabel, stopLabel }) => {
    const state = window as Window & { __qaSend?: { start: number; first?: number; complete?: number }; __qaSendStop?: () => void }
    state.__qaSendStop?.()
    delete state.__qaSend
    let observer: MutationObserver | undefined
    const started = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.target instanceof HTMLTextAreaElement)) return
      document.removeEventListener('keydown', started, true)
      const mark: { start: number; first?: number; complete?: number } = { start: performance.now() }
      state.__qaSend = mark
      const root = [...document.querySelectorAll<HTMLElement>('[data-conversation-session]')].find(el => el.dataset.conversationSession === key)
      const measure = () => {
        const response = root?.querySelector<HTMLElement>('[data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"])')
        if (response?.textContent.trim() && mark.first === undefined) requestAnimationFrame(() => {
          mark.first ??= performance.now()
          measure()
        })
        const buttons = [...(root?.querySelectorAll('button') ?? [])]
        if (mark.first !== undefined && response?.textContent.includes('CANDIDATE_QA_ACCEPTED')
          && buttons.some(button => button.getAttribute('aria-label') === sendLabel)
          && !buttons.some(button => button.getAttribute('aria-label') === stopLabel)) {
          mark.complete ??= performance.now()
          observer?.disconnect()
        }
      }
      observer = new MutationObserver(measure)
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
      requestAnimationFrame(measure)
    }
    document.addEventListener('keydown', started, { capture: true })
    state.__qaSendStop = () => { observer?.disconnect(); document.removeEventListener('keydown', started, true) }
  }, { key: sessionKey(config, sessionId), sendLabel: config.language === 'en' ? 'Send message' : '发送消息',
    stopLabel: config.language === 'en' ? 'Stop generating' : '停止生成' })
  const responses: BrowserResponse[] = []
  const sent = (request: BrowserRequest) => {
    const path = new URL(request.url()).pathname
    if (path !== '/api/admit/v1/session.prompt' && path !== '/api/admit/v1/session.status') return
    const body = object(object(request.postDataJSON()).payload)
    if (body.sessionId !== sessionId || (sample.requestId !== undefined && sample.requestId !== body.requestId)) return
    sample.requests = (sample.requests ?? 0) + 1
    if (typeof body.requestId === 'string' && /^[A-Za-z0-9_-]{1,160}$/u.test(body.requestId)) sample.requestId = body.requestId
    const operation = operationId(undefined, request.headers()['x-dsh-operation-id'])
    if (operation !== undefined && sample.operationId === undefined) sample.operationId = operation
  }
  const observed = (response: BrowserResponse) => {
    if (['/api/admit/v1/session.prompt', '/api/admit/v1/session.status'].includes(new URL(response.url()).pathname)) {
      responses.push(response)
    }
  }
  page.on('request', sent)
  page.on('response', observed)
  const prompt = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admit/v1/session.prompt', { timeout: config.timeoutMs })
  void prompt.catch(() => { /* The failed attempt is retained without resubmission. */ })
  const driver = performance.now()
  await withFinalBrowserClock(async () => {
    await editor.press('Enter')
    const response = await prompt
    const request = payload(response)
    if (request.sessionId !== sessionId) throw new MeasurementError('prompt-session-mismatch')
    sample.requestId = id(request.requestId)
    assertDurableReceiptRequest(response.url(), response.request().postDataJSON(), sessionId, sample.requestId)
    let receipt = response
    sample.receipt = 'prompt'
    try {
      const value = await accepted(response, config, sample)
      if (value.accepted !== true) throw new MeasurementError('prompt-not-accepted')
    } catch (error) {
      if (!(error instanceof MeasurementError) || error.code !== 'prompt-durability-unavailable') throw error
      const deadline = performance.now() + config.timeoutMs
      let confirmation: BrowserResponse | undefined
      while (performance.now() < deadline) {
        confirmation = responses.find(row => new URL(row.url()).pathname === '/api/admit/v1/session.status'
          && payload(row).sessionId === sessionId && payload(row).requestId === request.requestId)
        if (confirmation) break
        await delay(25)
      }
      if (!confirmation) throw Object.assign(new Error('receipt deadline'), { name: 'TimeoutError' })
      assertDurableReceiptRequest(confirmation.url(), confirmation.request().postDataJSON(), sessionId, sample.requestId)
      if ((await accepted(confirmation, config, sample)).state !== 'accepted') throw new MeasurementError('prompt-outcome-unconfirmed')
      receipt = confirmation
      sample.receipt = 'status'
    }
    const submissionDriverMs = performance.now() - driver
    sample.driverMs = submissionDriverMs
    await observeAcceptedPrompt(receipts, sample, async () => {
      const clockReadStarted = performance.now()
      await receipt.finished()
      const timing = await page.evaluate(({ receiptPath, runtime }) => {
        const mark = (window as Window & { __qaSend?: { start: number } }).__qaSend
        const all = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(row => mark !== undefined
          && row.startTime >= mark.start && new URL(row.name).searchParams.get('dshRuntime') === runtime)
        const first = all.find(row => new URL(row.name).pathname === '/api/admit/v1/session.prompt')
        const last = all.findLast(row => new URL(row.name).pathname === receiptPath)
        return { start: mark?.start, first: first?.startTime, end: last?.responseEnd }
      }, { receiptPath: new URL(receipt.url()).pathname, runtime: config.runtimeId })
      if (timing.start === undefined || timing.first === undefined || timing.end === undefined) throw new MeasurementError('missing-browser-receipt-clock')
      sample.durableReceiptMs = timing.end - timing.start
      sample.beforeRequestMs = timing.first - timing.start
      sample.transportMs = timing.end - timing.first
      sample.driverMs = submissionDriverMs + performance.now() - clockReadStarted
      sample.outcome = 'ok'
      try {
        await page.waitForFunction(() => (window as Window & { __qaSend?: { complete?: number } }).__qaSend?.complete !== undefined,
          undefined, { timeout: config.settleTimeoutMs })
        sample.completion = 'complete'
      } catch (error) { sample.completion = failure(error).outcome; throw new MeasurementError('accepted-turn-not-settled') }
    })
  }, async () => {
    page.off('request', sent)
    page.off('response', observed)
    try {
      const mark = await page.evaluate(() => {
        const state = window as Window & { __qaSend?: { start: number; first?: number; complete?: number }; __qaSendStop?: () => void }
        state.__qaSendStop?.()
        return state.__qaSend
      })
      if (mark?.first !== undefined) sample.firstVisibleAnswerMs = mark.first - mark.start
      if (mark?.complete !== undefined) sample.completionMs = mark.complete - mark.start
    } finally {
      sample.driverMs ??= performance.now() - driver
    }
  })
}

/** Execute only against an explicitly configured ready QA allocation. Each failure stops subsequent mutations.
 * @param config - private, parsed workload; the CLI must require explicit --execute.
 * @returns summary; raw receipts remain in the owner-private, exclusively created JSONL file.
 */
export async function measureDeployment(config: ExistingLatencyConfig): Promise<unknown> {
  const cookie = authenticationCookie(await privateText(config.authenticationFile))
  await privateParent(config.outputFile)
  await privateParent(config.authenticationFile)
  const lockKey = createHash('sha256').update(config.runtimeId).digest('hex').slice(0, 24)
  const lockPath = join(dirname(config.authenticationFile), `.latency-${lockKey}.lock`)
  const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let output: FileHandle | undefined, browser: Browser | undefined, context: BrowserContext | undefined, observedPage: Page | undefined
  const samples: LatencySample[] = []
  const runId = randomUUID(), created = new Set<string>()
  let stopped: ReturnType<typeof failure> | undefined, violation: string | undefined, promptSession: string | undefined
  let stage = 'private-receipt-setup'
  let diagnostics: unknown
  let bootMarks: Array<{ name: string; startTime: number }> | undefined
  const requestTraces: Array<Record<string, unknown>> = []
  let resourceTraces: Array<Record<string, unknown>> = []
  let initialRpcSummary: InitialRpcSummary = { boot: {}, setup: {} }
  const tracedRequests = new WeakMap<BrowserRequest, Record<string, unknown>>()
  const requestTrace = (request: BrowserRequest): Record<string, unknown> | undefined => {
    const prior = tracedRequests.get(request)
    if (prior) return prior
    if (requestTraces.length >= 32) return
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/prepare/v1/') && !url.pathname.startsWith('/api/admit/v1/')) return
    const coordinate = (key: string): string | null => {
      const value = url.searchParams.get(key)
      return value === null || /^[A-Za-z0-9:_-]{1,160}$/u.test(value) ? value : 'invalid-coordinate'
    }
    let payloadFields: string[] = []
    try {
      payloadFields = Object.keys(object(object(request.postDataJSON()).payload))
        .filter(key => /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)).sort()
    }
    catch { /* Malformed request diagnostics contain no body; the route guard reports the validation failure. */ }
    const principal = request.headers()['x-dsh-expected-principal-id']
    const trace: Record<string, unknown> = { stage, pathname: url.pathname, dshRuntime: coordinate('dshRuntime'),
      dshNode: coordinate('dshNode'), dshTarget: coordinate('dshTarget'),
      expectedPrincipalId: principal === undefined ? null : /^\d+$/u.test(principal) ? principal : 'invalid-principal', payloadFields, route: 'pending' }
    requestTraces.push(trace)
    tracedRequests.set(request, trace)
    return trace
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, runId }) + '\n')
    const receipts = await open(config.outputFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    output = receipts
    await append(output, { kind: 'plan', ...measurementPlan(config), execute: true, runId, startedAt: new Date().toISOString(),
      endpoints: { editable: 'browser-click-to-editable-target', ready: 'browser-click-to-ready-authorized-view',
        durableReceipt: 'browser-input-to-received-positive-durable-receipt', firstVisibleAnswer: 'browser-input-to-visible-response-text',
        serverCommitTimestamp: 'not-observed', modelFirstTokenTimestamp: 'not-observed', driver: 'Playwright-command-and-wait-overhead-included' } })
    stage = 'runtime-preflight'
    await ready(config, cookie)
    stage = 'browser-start'
    browser = await launchComputerBrowser(config.browser)
    context = await browser.newContext({ locale: config.language === 'en' ? 'en-US' : 'zh-CN', viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' })
    // tsx preserves nested function names with this helper when Playwright serializes a callback.
    await context.addInitScript({ content: 'Object.defineProperty(globalThis, "__name", { configurable: true, value: (fn, name) => Object.defineProperty(fn, "name", { value: name, configurable: true }) });' })
    await context.addCookies([{ ...cookie, url: config.origin, httpOnly: true, sameSite: 'Lax', secure: config.origin.startsWith('https:') }])
    const page = await context.newPage()
    observedPage = page
    page.setDefaultTimeout(config.timeoutMs)
    const observedResources = attachResourceTraceObservers(page, config, () => stage, tracedRequests, requestTrace)
    resourceTraces = observedResources.resourceTraces
    initialRpcSummary = observedResources.initialRpcSummary
    const closeOnInterrupt = () => {
      stopped = { error: 'operator-interrupted', outcome: 'failed' }
      void context?.close().catch(() => { /* The outer finally records cleanup failure and joins the owned connection. */ })
    }
    process.once('SIGINT', closeOnInterrupt)
    process.once('SIGTERM', closeOnInterrupt)
    try {
      await page.route('**/api/**', async (route) => {
        const request = route.request(), url = new URL(request.url())
        if (url.pathname.startsWith('/api/prepare/v1/') || url.pathname.startsWith('/api/admit/v1/')) {
          const trace = requestTrace(request)
          try {
            assertRequestTarget(request.url(), request.headers()['x-dsh-expected-principal-id'], config)
            const body = object(object(request.postDataJSON()).payload)
            if (url.pathname.endsWith('/session.create') && body.workspaceId !== config.workspaceId) throw new MeasurementError('create-workspace-mismatch')
            if (url.pathname.endsWith('/session.create') && (body.sessionId === config.historySessionId || created.has(String(body.sessionId)))) {
              throw new MeasurementError('create-reused-a-test-session')
            }
            if (url.pathname.endsWith('/session.history') && body.sessionId !== config.historySessionId && !created.has(String(body.sessionId))) {
              throw new MeasurementError('history-outside-test-sessions')
            }
            if (url.pathname.startsWith('/api/admit/') && !created.has(String(body.sessionId))) throw new MeasurementError('prompt-outside-test-sessions')
            if (url.pathname === '/api/admit/v1/session.prompt' && body.sessionId !== promptSession) throw new MeasurementError('prompt-outside-current-attempt')
          } catch (error) {
            violation = failure(error).error
            if (trace) { trace.route = 'abort'; trace.violation = violation }
            await route.abort('blockedbyclient')
            return
          }
          if (trace) trace.route = 'continue'
        }
        await route.continue()
      })
      const url = new URL('/', config.origin)
      url.search = new URLSearchParams({ dshRuntime: config.runtimeId, dshNode: config.nodeId, dshTarget: 'personal' }).toString()
      stage = 'initial-navigation'
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs })
      stage = 'initial-computer-directory'
      await waitForInitialDirectory(page, config)
      const computer = page.getByRole('region', { name: config.computerName, exact: true })
      if (await computer.count() === 1) {
        const heading = computer.getByRole('button', { name: config.computerName, exact: true })
        if (await heading.getAttribute('aria-expanded') !== 'true') await heading.click()
      }
      stage = 'initial-workspace-selection'
      const workspace = page.locator(attribute('data-row-key', `workspace:${config.workspaceId}`))
      await workspace.waitFor()
      if (await workspace.getAttribute('aria-expanded') !== 'true') await workspace.click()
      stage = 'initial-history-row'
      const prior = await revealHistoryRow(page, config)
      stage = 'initial-history-click'
      await prior.click()
      stage = 'initial-history-content'
      const priorChat = page.locator(attribute('data-conversation-session', sessionKey(config, config.historySessionId)))
      await priorChat.getByText(config.historyMarker, { exact: false }).first().waitFor()
      if (await priorChat.locator('textarea:enabled').inputValue() !== '') throw new MeasurementError('test-history-has-draft')
      if (await priorChat.getByRole('button', { name: config.language === 'en' ? 'Stop generating' : '停止生成', exact: true }).count()) {
        throw new MeasurementError('test-history-running')
      }
      if (violation) throw new MeasurementError(violation)
      bootMarks = await readBootMarks(page)
      await page.evaluate(() =>{  performance.setResourceTimingBufferSize(10000) })
      const attempt = async (sample: LatencySample, action: () => Promise<void>) => {
        try {
          await action()
          if (violation) throw new MeasurementError(violation)
          await ready(config, cookie)
          sample.outcome = 'ok'
        }
        catch (error) {
          const cause = violation ? new MeasurementError(violation) : error
          if (sample.durableReceiptMs === undefined) Object.assign(sample, failure(cause))
          stopped = failure(cause)
          throw cause
        } finally { samples.push(sample); await append(receipts, { kind: 'sample', ...sample }) }
      }
      for (let index = 1; index <= config.samples; index++) {
        stage = 'iteration-runtime-preflight'
        await ready(config, cookie)
        await delay(config.intervalMs)
        await page.evaluate(() =>{  performance.clearResourceTimings() })
        let sessionId = ''
        const create: LatencySample = { index, operation: 'hot-create', outcome: 'failed' }
        stage = 'hot-create'
        await attempt(create, async () => {
          sessionId = await preparation(page, config, workspace.getByRole('button', { name: config.language === 'en' ? /^New session in /u : /^在“.*”中新建会话$/u }), 'create', create)
          if (sessionId === config.historySessionId || created.has(sessionId)) throw new MeasurementError('create-reused-a-test-session')
          created.add(sessionId)
        })
        const title = `${config.testPrefix}_${runId.slice(0, 8)}_${index}`
        stage = 'name-created-session'
        await renameTestSession(page, config, sessionId, title)
        await delay(config.intervalMs)
        const prompt: LatencySample = { index, operation: 'durable-send', outcome: 'failed', sessionId }
        stage = 'durable-send'
        promptSession = sessionId
        try {
          await attempt(prompt, () => send(page, config, receipts, prompt, sessionId, `${title}: Reply only CANDIDATE_QA_ACCEPTED. Do not use tools.`))
        } finally { promptSession = undefined }
        await delay(config.intervalMs)
        const opened: LatencySample = { index, operation: 'hot-open', outcome: 'failed', sessionId: config.historySessionId }
        stage = 'history-row-setup'
        await attempt(opened, async () => {
          const history = await revealHistoryRow(page, config)
          stage = 'hot-open'
          await preparation(page, config, history, 'history', opened)
        })
      }
    } finally {
      process.removeListener('SIGINT', closeOnInterrupt)
      process.removeListener('SIGTERM', closeOnInterrupt)
    }
  } catch (error) {
    if (violation) stopped = failure(new MeasurementError(violation))
    else stopped ??= failure(error)
    if (observedPage && !observedPage.isClosed()) {
      if (bootMarks === undefined) {
        try { bootMarks = await readBootMarks(observedPage) }
        catch { /* A closed or unavailable page contributes no boot marks; the operation failure remains recorded. */ }
      }
      try {
        diagnostics = await observedPage.evaluate(({ workspaceId, historyKey }) => {
          const rows = [...document.querySelectorAll<HTMLElement>('[data-row-key]')]
          const workspace = rows.find(row => row.dataset.rowKey === `workspace:${workspaceId}`)
          const history = rows.find(row => row.dataset.rowKey === `session:${historyKey}`)
          return { workspacePresent: workspace !== undefined, workspaceExpanded: workspace?.getAttribute('aria-expanded'),
            historyPresent: history !== undefined, historyVisible: history ? history.getBoundingClientRect().height > 0 : false,
            renderedSessionIds: rows.flatMap(row => row.dataset.rowKey?.startsWith('session:') ? [row.dataset.rowKey] : [])
              .slice(0, 25),
            renderedWorkspaceCount: rows.filter(row => row.dataset.rowKey?.startsWith('workspace:')).length,
            pendingViews: document.querySelectorAll('[data-conversation-intent]').length,
            conversationViews: document.querySelectorAll('[data-conversation-session]').length }
        }, { workspaceId: config.workspaceId, historyKey: sessionKey(config, config.historySessionId) })
      } catch { /* A closed or unavailable page contributes no DOM diagnostics; the operation failure remains recorded. */ }
    }
  }
  finally {
    try { await context?.close() } catch { stopped ??= { error: 'browser-context-cleanup-failed', outcome: 'failed' } }
    try { await browser?.close() } catch { stopped ??= { error: 'browser-connection-cleanup-failed', outcome: 'failed' } }
    try {
      if (output) await append(output, {
        kind: 'summary', runId, finishedAt: new Date().toISOString(), stopped: stopped ? { ...stopped, stage } : null,
        violation: violation ?? null, requestTraces, resourceTraces, bootMarks: bootMarks ?? null, initialRpcSummary,
        diagnostics, confirmedCreatedSessionIds: [...created],
        result: summarize(samples, config.samples),
      })
    } finally {
      try { await output?.close() }
      finally { try { await lock.close() } finally { await unlink(lockPath) } }
    }
  }
  return {
    runId, complete: stopped === undefined, stopped: stopped ? { ...stopped, stage } : null,
    result: summarize(samples, config.samples),
  }
}
