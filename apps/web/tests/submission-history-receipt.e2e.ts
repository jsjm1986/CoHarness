/** Input admission survives lost downlink frames and a paged history repair. */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type WebSocketRoute } from 'playwright'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const ROOT = fileURLToPath(new URL('./expected/submission-history-receipt/', import.meta.url))
const MODE = webSnapshotMode()
const MARKER = 'RECEIPT_HISTORY_REPAIRED'
const PROMPT = 'Read each of the sixty lines in receipt-source.txt separately, then reply RECEIPT_HISTORY_REPAIRED. Do not change files.'

interface HistoryEvidence { beforeSeq: number | undefined; hasMore: boolean; containsReceipt: boolean }
let scaffold: WebScaffold | undefined
let browser: Browser | undefined

afterEach(async () => {
  try { await browser?.close() } finally { await scaffold?.close() }
  browser = undefined
  scaffold = undefined
})

it.skipIf(MODE === 'record')('unlocks accepted input when its receipt returns on an older history page', async () => {
  scaffold = await launchWebScaffold({
    replayFixture: join(ROOT, 'session.jsonl'), replayOverride: join(ROOT, 'replay.override.json'),
  })
  const runtime = scaffold
  const workspace = join(runtime.workspaceCwd, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'receipt-source.txt'), Array.from({ length: 60 }, (_, i) => `receipt line ${String(i + 1)}`).join('\n') + '\n')
  browser = await chromium.launch()
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'submission-history-receipt'))
  const sockets = new Set<WebSocketRoute>()
  let muted = false, dropped = 0, repairing = false
  let requestId: string | undefined
  let sessionId: string | undefined
  const history: Array<Promise<HistoryEvidence>> = []
  const users: SessionEvent<'user/message'>[] = []
  runtime.ctx.on('session/event', (_session, event) => {
    if (event.type === 'user/message' && event.data.source.kind === 'user') users.push(event)
  })
  // The real Host keeps running while its downlink packets are lost. HTTP
  // replies and the replacement connection carry only production responses.
  await page.routeWebSocket(/\/api\/events\.mux(?:\?|$)/, (socket) => {
    sockets.add(socket)
    const server = socket.connectToServer()
    server.onMessage((message) => {
      if (muted) dropped += 1
      else socket.send(message)
    })
  })
  page.on('request', (request) => {
    if (new URL(request.url()).pathname !== '/api/session.prompt') return
    const body = request.postDataJSON() as { payload: { sessionId: string; requestId?: string }; rpcId: string }
    sessionId = body.payload.sessionId
    requestId = body.payload.requestId ?? body.rpcId
  })
  page.on('response', (response) => {
    if (!repairing || new URL(response.url()).pathname !== '/api/session.history') return
    const request = response.request().postDataJSON() as { payload: { sessionId: string; beforeSeq?: number } }
    if (request.payload.sessionId !== sessionId) return
    const read = response.json().then((body: {
      result: { ok: boolean; value: { hasMore: boolean; records: readonly { event: SessionEvent }[] } }
    }) => {
      if (!body.result.ok) throw new Error('The real history repair was refused')
      return {
        beforeSeq: request.payload.beforeSeq,
        hasMore: body.result.value.hasMore,
        containsReceipt: body.result.value.records.some(({ event }) => event.type === 'user/message'
          && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === requestId),
      }
    })
    void read.catch(() => {
      // Promise.all(history) reports parsing failures after the repair settles.
    })
    history.push(read)
  })
  await page.goto(runtime.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, runtime.workspaceCwd)
  const input = page.locator('textarea').first()
  const settled = runtime.whenTurnSettled()
  muted = true
  await input.fill(PROMPT)
  await input.press('Enter')
  await settled
  expect(dropped).toBeGreaterThan(0)
  expect(users).toHaveLength(1)
  expect(await input.getAttribute('data-phase')).toBe('submitting')
  expect(await input.inputValue()).toBe(PROMPT)
  repairing = true
  muted = false
  await Promise.all([...sockets].map(socket => socket.close({ code: 1012, reason: 'Restore the interrupted test downlink' })))
  await page.getByText(MARKER, { exact: true }).waitFor({ timeout: 30_000 })
  await expect.poll(() => input.inputValue(), { timeout: 30_000 }).toBe('')
  expect(await input.getAttribute('data-phase')).toBe('plain')
  const pages = await Promise.all(history)
  expect(pages.find(page => page.beforeSeq === undefined)).toMatchObject({ hasMore: true, containsReceipt: false })
  expect(pages.some(page => page.beforeSeq !== undefined && page.containsReceipt)).toBe(true)
  expect(users).toHaveLength(1)
  const aria = await captureStableAria(page, '[data-composer-seat]', runtime.workspaceCwd)
  await compareOrRefreshGolden(join(ROOT, 'settled.expected.md'), aria + '\n\nAssistant reply\n' + MARKER + '\n', MODE)
})
