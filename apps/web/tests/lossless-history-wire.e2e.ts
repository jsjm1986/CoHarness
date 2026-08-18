// Web e2e scenario: the shipped Loader/Web composition must preserve one
// lossless logical history while the Fetch carrier splits a large packed
// response into byte-targeted physical pages. The seed stays below the API's
// 50-message logical limit, so every extra page comes from the default
// 131072-byte carrier target rather than maxMessages.
import { fileURLToPath } from 'node:url'
import type { Browser, Page, Response as PlaywrightResponse } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { DEFAULT_HISTORY_PAGE_TARGET_BYTES, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/lossless-history-wire', import.meta.url))
const INITIAL_EXPECTED = fileURLToPath(new URL('./snapshots/lossless-history-wire/initial.expected.md', import.meta.url))
const EXPANDED_EXPECTED = fileURLToPath(new URL('./snapshots/lossless-history-wire/expanded.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'lossless-history-wire-web-e2e'
const LARGE_TURNS = 6
const DELTA_REPETITIONS = 1_600
const FULL_COUNTS = '8 turns · 9 steps'
const TOOL_CALL_ID = 'lossless-history-wire-bash'
const TOOL_DESCRIPTION = 'Verify packed history carrier'
const TOOL_OUTPUT = 'WIRE_TOOL_OUTPUT'
const INTERRUPTED_REASONING = 'WIRE_INTERRUPTED_REASONING'
const INTERRUPTED_TEXT = 'WIRE_INTERRUPTED_TEXT'
const USER_MARKERS = Array.from(
  { length: LARGE_TURNS },
  (_, index) => `WIRE_USER_${String(index + 1).padStart(2, '0')}`,
)
const ASSISTANT_MARKERS = Array.from(
  { length: LARGE_TURNS },
  (_, index) => `WIRE_ASSISTANT_${String(index + 1).padStart(2, '0')}`,
)
const REASONING_MARKERS = Array.from(
  { length: LARGE_TURNS },
  (_, index) => `WIRE_REASONING_${String(index + 1).padStart(2, '0')}`,
)
const TOOL_USER_MARKER = 'WIRE_USER_TOOL'
const TOOL_CALL_MARKER = 'WIRE_ASSISTANT_TOOL_CALL'
const TOOL_DONE_MARKER = 'WIRE_ASSISTANT_TOOL_DONE'
const INTERRUPTED_USER_MARKER = 'WIRE_USER_INTERRUPTED'
const MESSAGE_MARKERS = [
  ...USER_MARKERS,
  ...ASSISTANT_MARKERS,
  TOOL_USER_MARKER,
  TOOL_CALL_MARKER,
  TOOL_DONE_MARKER,
  INTERRUPTED_USER_MARKER,
]

interface SeedEvidence {
  jsonl: string
  eventCount: number
  appendMessageCount: number
  reasoningDeltaEvents: number
  textDeltaEvents: number
}

interface WirePageEvidence {
  beforeSeq?: number
  bytes: number
  recordCount: number
  packedRecordCount: number
  hasMore: boolean
  hasProjections: boolean
}

interface StableUiEvidence {
  stats: string
  tool: string
  settledFooter: string
  interruptedTextCount: number
  interruptedReasoningCount: number
  stoppedCount: number
}

const usage = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 300,
  cacheWriteTokens: 0,
}

/** Build a deterministic, valid log with large packable Unicode delta runs. */
function buildSeed(): SeedEvidence {
  const lines = [JSON.stringify({
    type: 'session',
    version: 0,
    id: '{{sessionId}}',
    createdAt: 1786665600000,
    cwd: '{{cwd}}/workspace',
  })]
  let seq = 0
  let time = 1786665600000
  let messageNumber = 0
  let appendMessageCount = 0
  let reasoningDeltaEvents = 0
  let textDeltaEvents = 0

  const messageId = (): string =>
    `00000000-0000-4000-8000-${String(++messageNumber).padStart(12, '0')}`

  const at = (event: Record<string, unknown>): number => {
    const assigned = seq++
    lines.push(JSON.stringify({ ...event, seq: assigned, time: time++ }))
    return assigned
  }

  const appendUser = (marker: string): void => {
    appendMessageCount += 1
    at({
      type: 'user/message',
      data: {
        id: messageId(),
        role: 'user',
        content: [{ type: 'text', text: marker }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    })
  }

  const appendAssistant = (
    turn: number,
    step: number,
    assistantMarker: string,
    reasoningMarker: string,
    repetitions: number,
    tool?: { id: string; name: string; arguments: string },
  ): void => {
    const sourceEventSeqs: number[] = []
    const chunk = (value: Record<string, unknown>): void => {
      sourceEventSeqs.push(at({
        type: 'assistant/chunk',
        data: { turn, step, chunk: value },
      }))
    }

    chunk({ type: 'block-start', index: 0, blockType: 'reasoning' })
    const reasoningParts = [repetitions === 0 ? reasoningMarker : `${reasoningMarker}\n`]
    chunk({ type: 'reasoning-delta', index: 0, text: reasoningParts[0] })
    reasoningDeltaEvents += 1
    for (let index = 0; index < repetitions; index++) {
      reasoningParts.push('推')
      chunk({ type: 'reasoning-delta', index: 0, text: '推' })
      reasoningDeltaEvents += 1
    }
    const reasoningText = reasoningParts.join('')
    chunk({
      type: 'block-end',
      index: 0,
      block: { type: 'reasoning', text: reasoningText },
    })

    chunk({ type: 'block-start', index: 1, blockType: 'text' })
    const textParts = repetitions === 0 ? [assistantMarker] : [`${assistantMarker}\n<!--`]
    chunk({ type: 'text-delta', index: 1, text: textParts[0] })
    textDeltaEvents += 1
    for (let index = 0; index < repetitions; index++) {
      textParts.push('文')
      chunk({ type: 'text-delta', index: 1, text: '文' })
      textDeltaEvents += 1
    }
    if (repetitions > 0) {
      textParts.push('-->')
      chunk({ type: 'text-delta', index: 1, text: '-->' })
      textDeltaEvents += 1
    }
    const assistantText = textParts.join('')
    chunk({
      type: 'block-end',
      index: 1,
      block: { type: 'text', text: assistantText },
    })

    const content: Record<string, unknown>[] = [
      { type: 'reasoning', text: reasoningText },
      { type: 'text', text: assistantText },
    ]
    if (tool !== undefined) {
      chunk({ type: 'block-start', index: 2, blockType: 'tool-call' })
      chunk({
        type: 'tool-call-delta',
        index: 2,
        id: tool.id,
        name: tool.name,
        argumentsDelta: tool.arguments,
      })
      const toolBlock = {
        type: 'tool-call',
        id: tool.id,
        name: tool.name,
        arguments: tool.arguments,
      }
      chunk({ type: 'block-end', index: 2, block: toolBlock })
      content.push(toolBlock)
    }
    chunk({ type: 'usage', usage })
    chunk({ type: 'finish', reason: { kind: tool === undefined ? 'stop' : 'tool-calls' } })

    appendMessageCount += 1
    at({
      type: 'assistant/message',
      data: {
        turn,
        step,
        message: {
          id: messageId(),
          role: 'assistant',
          content,
          source: { kind: 'model', provider: 'snapshot', model: 'snapshot-replier' },
        },
        usage,
      },
      sourceEventSeqs,
      surfaceOp: 'append',
    })
  }

  for (let turn = 1; turn <= LARGE_TURNS; turn++) {
    at({ type: 'turn/start', data: { turn } })
    appendUser(USER_MARKERS[turn - 1] as string)
    at({ type: 'step/start', data: { turn, step: 1 } })
    appendAssistant(
      turn,
      1,
      ASSISTANT_MARKERS[turn - 1] as string,
      REASONING_MARKERS[turn - 1] as string,
      DELTA_REPETITIONS,
    )
    at({ type: 'step/end', data: { turn, step: 1 } })
    at({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }

  const toolTurn = LARGE_TURNS + 1
  const toolArguments = JSON.stringify({
    command: `printf '${TOOL_OUTPUT}\\n'`,
    description: TOOL_DESCRIPTION,
  })
  at({ type: 'turn/start', data: { turn: toolTurn } })
  appendUser(TOOL_USER_MARKER)
  at({ type: 'step/start', data: { turn: toolTurn, step: 1 } })
  appendAssistant(
    toolTurn,
    1,
    TOOL_CALL_MARKER,
    'WIRE_REASONING_TOOL_CALL',
    0,
    { id: TOOL_CALL_ID, name: 'bash', arguments: toolArguments },
  )
  const toolCallSeq = at({
    type: 'tool/call',
    data: {
      turn: toolTurn,
      step: 1,
      callId: TOOL_CALL_ID,
      name: 'bash',
      arguments: toolArguments,
    },
  })
  at({
    type: 'tool/result',
    data: {
      turn: toolTurn,
      step: 1,
      message: {
        id: messageId(),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: TOOL_CALL_ID,
          content: [{ type: 'text', text: TOOL_OUTPUT }],
          isError: false,
        }],
        source: { kind: 'tool', callId: TOOL_CALL_ID },
      },
    },
    sourceEventSeqs: [toolCallSeq],
    surfaceOp: 'append',
  })
  at({ type: 'step/end', data: { turn: toolTurn, step: 1 } })
  at({ type: 'step/start', data: { turn: toolTurn, step: 2 } })
  appendAssistant(toolTurn, 2, TOOL_DONE_MARKER, 'WIRE_REASONING_TOOL_DONE', 0)
  at({ type: 'step/end', data: { turn: toolTurn, step: 2 } })
  at({ type: 'turn/end', data: { turn: toolTurn, reason: { kind: 'completed' } } })

  const interruptedTurn = LARGE_TURNS + 2
  at({ type: 'turn/start', data: { turn: interruptedTurn } })
  appendUser(INTERRUPTED_USER_MARKER)
  at({ type: 'step/start', data: { turn: interruptedTurn, step: 1 } })
  at({
    type: 'assistant/chunk',
    data: {
      turn: interruptedTurn,
      step: 1,
      chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
    },
  })
  at({
    type: 'assistant/chunk',
    data: {
      turn: interruptedTurn,
      step: 1,
      chunk: { type: 'reasoning-delta', index: 0, text: `${INTERRUPTED_REASONING}\n` },
    },
  })
  reasoningDeltaEvents += 1
  for (let index = 0; index < 64; index++) {
    at({
      type: 'assistant/chunk',
      data: {
        turn: interruptedTurn,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: '断' },
      },
    })
    reasoningDeltaEvents += 1
  }
  at({
    type: 'assistant/chunk',
    data: {
      turn: interruptedTurn,
      step: 1,
      chunk: { type: 'block-start', index: 1, blockType: 'text' },
    },
  })
  at({
    type: 'assistant/chunk',
    data: {
      turn: interruptedTurn,
      step: 1,
      chunk: { type: 'text-delta', index: 1, text: `${INTERRUPTED_TEXT}\n<!--` },
    },
  })
  textDeltaEvents += 1
  for (let index = 0; index < 64; index++) {
    at({
      type: 'assistant/chunk',
      data: {
        turn: interruptedTurn,
        step: 1,
        chunk: { type: 'text-delta', index: 1, text: '未' },
      },
    })
    textDeltaEvents += 1
  }
  at({
    type: 'assistant/chunk',
    data: {
      turn: interruptedTurn,
      step: 1,
      chunk: { type: 'text-delta', index: 1, text: '-->' },
    },
  })
  textDeltaEvents += 1
  at({ type: 'step/end', data: { turn: interruptedTurn, step: 1 } })
  at({ type: 'turn/end', data: { turn: interruptedTurn, reason: { kind: 'aborted' } } })

  return {
    jsonl: `${lines.join('\n')}\n`,
    eventCount: seq,
    appendMessageCount,
    reasoningDeltaEvents,
    textDeltaEvents,
  }
}

function parseWirePage(text: string, beforeSeq?: number): WirePageEvidence {
  const body = JSON.parse(text) as {
    result?: {
      ok?: boolean
      value?: {
        records?: unknown[]
        events?: unknown
        hasMore?: boolean
        projections?: unknown
      }
    }
  }
  if (body.result?.ok !== true || !Array.isArray(body.result.value?.records)) {
    throw new Error('history response did not carry a successful physical records page')
  }
  if (body.result.value.events !== undefined || typeof body.result.value.hasMore !== 'boolean') {
    throw new Error('history response leaked logical events or omitted hasMore')
  }
  return {
    ...(beforeSeq === undefined ? {} : { beforeSeq }),
    bytes: new TextEncoder().encode(text).byteLength,
    recordCount: body.result.value.records.length,
    packedRecordCount: body.result.value.records.filter(record =>
      typeof record === 'object' && record !== null && 'chunks' in record).length,
    hasMore: body.result.value.hasMore,
    hasProjections: body.result.value.projections !== undefined,
  }
}

function observeHistoryPages(page: Page, reads: Array<Promise<WirePageEvidence>>): void {
  page.on('response', (response: PlaywrightResponse) => {
    if (!response.url().endsWith('/api/session.history')) return
    const request = response.request()
    let envelope: { method?: string; payload?: { sessionId?: string; beforeSeq?: number } }
    try {
      envelope = request.postDataJSON() as typeof envelope
    } catch {
      return
    }
    if (envelope.method !== 'session.history' || envelope.payload?.sessionId !== SEED_ID) return
    reads.push(response.body().then(buffer =>
      parseWirePage(buffer.toString('utf8'), envelope.payload?.beforeSeq)))
  })
}

async function markerCount(page: Page): Promise<number> {
  const counts = await Promise.all(MESSAGE_MARKERS.map(marker =>
    page.getByText(marker, { exact: true }).count()))
  return counts.reduce((total, count) => total + count, 0)
}

async function scrollToHistoryStart(page: Page): Promise<void> {
  const scroller = page.locator('[data-conversation-scroll]').first()
  await scroller.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll'))
  })
  await expect.poll(() => scroller.evaluate(element => element.scrollTop), {
    timeout: 5_000,
    message: 'conversation scrollport did not reach the history boundary',
  }).toBeLessThanOrEqual(1)
}

async function stableUiEvidence(page: Page, scaffold: WebScaffold): Promise<StableUiEvidence> {
  const stats = page.getByText(FULL_COUNTS, { exact: false }).locator('..')
  const tails = page.locator('[data-chat-flow-kind="turn-tail"]')
  const tailCount = await tails.count()
  if (tailCount < 2) throw new Error('expected settled and interrupted turn tails')
  return {
    stats: (await stats.textContent()) ?? '',
    tool: await captureStableAria(page, '[data-sample="bash"]', scaffold.workspaceCwd),
    settledFooter: (await tails.nth(tailCount - 2).textContent()) ?? '',
    interruptedTextCount: await page.getByText(INTERRUPTED_TEXT, { exact: true }).count(),
    interruptedReasoningCount: await page.getByRole('button', {
      name: new RegExp(`^Think ${INTERRUPTED_REASONING}`),
    }).count(),
    stoppedCount: await page.getByText('Stopped', { exact: true }).count(),
  }
}

const seed = buildSeed()

describe('web e2e: lossless history wire pagination', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let initialUi: StableUiEvidence
  let loadOlderOperations = 0
  const historyReads: Array<Promise<WirePageEvidence>> = []

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('lossless-history-wire is a keyless assembled snapshot')
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, seed.jsonl, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    observeHistoryPages(page, historyReads)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('exposes one full logical history and a default-target physical tail page', async () => {
    expect(DEFAULT_HISTORY_PAGE_TARGET_BYTES).toBe(131_072)
    expect(seed.appendMessageCount).toBe(MESSAGE_MARKERS.length)
    expect(seed.appendMessageCount).toBeLessThan(50)
    expect(seed.reasoningDeltaEvents).toBeGreaterThan(9_000)
    expect(seed.textDeltaEvents).toBeGreaterThan(9_000)

    const logical = await scaffold.ctx.apiProxy.sessions.history({
      rpcId: RpcId('lossless-history-logical'),
      payload: { sessionId: SessionId(SEED_ID) },
    })
    expect(logical.result.ok).toBe(true)
    if (!logical.result.ok) throw new Error(logical.result.error.message)
    expect(logical.result.value.hasMore).toBe(false)
    expect(logical.result.value.events).toHaveLength(seed.eventCount)
    expect(logical.result.value.events.map(({ event }) => event.seq))
      .toEqual(Array.from({ length: seed.eventCount }, (_, index) => index))
    expect(logical.result.value.events.filter(({ event }) =>
      (event.type === 'user/message' || event.type === 'assistant/message')
      && event.surfaceOp === 'append')).toHaveLength(seed.appendMessageCount)

    const response = await fetch(`${scaffold.baseUrl}/api/session.history`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'lossless-history-physical-tail',
        method: 'session.history',
        payload: { sessionId: SEED_ID },
      }),
    })
    expect(response.ok).toBe(true)
    const physical = parseWirePage(await response.text())
    expect(physical.bytes).toBeLessThanOrEqual(DEFAULT_HISTORY_PAGE_TARGET_BYTES)
    expect(physical.recordCount).toBeGreaterThan(0)
    expect(physical.packedRecordCount).toBeGreaterThan(0)
    expect(physical.hasMore).toBe(true)
    expect(physical.hasProjections).toBe(true)
  }, 60_000)

  it('renders the newest complete content and interrupted tail before expansion', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-lossless-history-initial'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()

    await expect.poll(() => page.getByText(TOOL_DONE_MARKER, { exact: true }).count(), {
      timeout: 30_000,
    }).toBe(1)
    await expect.poll(() => page.getByText(INTERRUPTED_TEXT, { exact: true }).count(), {
      timeout: 15_000,
    }).toBe(1)
    expect(await page.getByText(USER_MARKERS[0] as string, { exact: true }).count()).toBe(0)
    await expect.poll(() => page.getByRole('button', { name: 'Load earlier' }).count(), {
      timeout: 10_000,
    }).toBe(1)

    const toolButton = page.getByRole('button', { name: `Bash ${TOOL_DESCRIPTION}` })
    await toolButton.waitFor({ timeout: 10_000 })
    await toolButton.click()
    await expect.poll(() => page.getByText(TOOL_OUTPUT, { exact: true }).count(), {
      timeout: 10_000,
    }).toBe(1)
    await expect.poll(() => page.getByText(FULL_COUNTS, { exact: false }).count(), {
      timeout: 10_000,
    }).toBe(1)

    initialUi = await stableUiEvidence(page, scaffold)
    expect(initialUi.stats).toContain(FULL_COUNTS)
    expect(initialUi.stats).toContain('TTFT avg')
    expect(initialUi.stats).toContain('tok/s')
    expect(initialUi.stats).toContain('Cache hit 75%')
    expect(initialUi.stats).toContain('Input 3.2K tok · Output 400 tok')
    expect(initialUi.stats).toContain('Tool call')
    expect(initialUi.settledFooter).toContain('Ran for')
    expect(initialUi.settledFooter).toContain('TTFT')
    expect(initialUi.settledFooter).toContain('tok/s')
    expect(initialUi.interruptedTextCount).toBe(1)
    expect(initialUi.interruptedReasoningCount).toBe(1)
    expect(initialUi.stoppedCount).toBe(1)

    await expect.poll(async () => {
      const pages = await Promise.all(historyReads)
      return pages.filter(current => current.beforeSeq === undefined).length
    }, { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    const firstBrowserPage = (await Promise.all(historyReads))
      .find(current => current.beforeSeq === undefined)
    expect(firstBrowserPage?.bytes).toBeLessThanOrEqual(DEFAULT_HISTORY_PAGE_TARGET_BYTES)
    expect(firstBrowserPage?.packedRecordCount).toBeGreaterThan(0)
    expect(firstBrowserPage?.hasMore).toBe(true)

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(INITIAL_EXPECTED, snapshot, MODE)
  }, 90_000)

  it('loads every older physical page without changing logical content', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-lossless-history-expanded'))
    while (await page.getByText(USER_MARKERS[0] as string, { exact: true }).count() === 0) {
      expect(loadOlderOperations).toBeLessThan(10)
      await scrollToHistoryStart(page)
      const beforeReadCount = historyReads.length
      const beforeMarkerCount = await markerCount(page)
      const loadEarlier = page.getByRole('button', { name: 'Load earlier' })
      await loadEarlier.waitFor({ timeout: 10_000 })
      await loadEarlier.click()
      loadOlderOperations += 1
      await expect.poll(() => historyReads.length, { timeout: 15_000 })
        .toBeGreaterThan(beforeReadCount)
      await expect.poll(() => markerCount(page), { timeout: 20_000 })
        .toBeGreaterThan(beforeMarkerCount)
    }

    expect(loadOlderOperations).toBeGreaterThanOrEqual(2)
    await expect.poll(() => page.getByRole('button', { name: 'Load earlier' }).count(), {
      timeout: 10_000,
    }).toBe(0)
    for (const marker of MESSAGE_MARKERS) {
      expect(await page.getByText(marker, { exact: true }).count(), marker).toBe(1)
    }
    for (const marker of REASONING_MARKERS) {
      expect(await page.getByRole('button', { name: new RegExp(`^Think ${marker}`) }).count(), marker)
        .toBe(1)
    }

    const expandedUi = await stableUiEvidence(page, scaffold)
    expect(expandedUi).toEqual(initialUi)

    const pages = await Promise.all(historyReads)
    const tailPages = pages.filter(current => current.beforeSeq === undefined)
    const olderPages = pages.filter(current => current.beforeSeq !== undefined)
    expect(tailPages.length).toBeGreaterThanOrEqual(1)
    expect(olderPages).toHaveLength(loadOlderOperations)
    expect(olderPages.at(-1)?.hasMore).toBe(false)
    expect([...tailPages, ...olderPages.slice(0, -1)].every(current => current.hasMore)).toBe(true)
    expect(pages.every(current =>
      current.bytes <= DEFAULT_HISTORY_PAGE_TARGET_BYTES)).toBe(true)
    expect(pages.reduce((total, current) => total + current.bytes, 0))
      .toBeGreaterThan(DEFAULT_HISTORY_PAGE_TARGET_BYTES)
    expect(pages.reduce((total, current) => total + current.packedRecordCount, 0))
      .toBeGreaterThanOrEqual(2)
    expect(tailPages.every(current => current.hasProjections)).toBe(true)
    expect(olderPages.every(current => !current.hasProjections)).toBe(true)
    const cursors = olderPages.map(current => current.beforeSeq)
    expect(cursors.every((cursor): cursor is number => cursor !== undefined)).toBe(true)
    expect(new Set(cursors).size).toBe(loadOlderOperations)
    for (let index = 1; index < cursors.length; index++) {
      expect(cursors[index] as number).toBeLessThan(cursors[index - 1] as number)
    }

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(EXPANDED_EXPECTED, snapshot, MODE)
  }, 120_000)

  it('keeps the keyless model and browser tripwires clean', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    const unchanged = await scaffold.ctx.apiProxy.sessions.history({
      rpcId: RpcId('lossless-history-after-web'),
      payload: { sessionId: SessionId(SEED_ID) },
    })
    expect(unchanged.result.ok).toBe(true)
    if (!unchanged.result.ok) throw new Error(unchanged.result.error.message)
    expect(unchanged.result.value.events.length).toBeGreaterThanOrEqual(seed.eventCount)
    expect(unchanged.result.value.events.slice(0, seed.eventCount).map(({ event }) => event.seq))
      .toEqual(Array.from({ length: seed.eventCount }, (_, index) => index))
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'expanded.expected.md',
      'initial.expected.md',
    ])
  })
})
