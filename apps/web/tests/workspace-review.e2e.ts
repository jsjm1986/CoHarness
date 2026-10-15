/** Historical workspace review through the shipped recorder, RPC, and Web consumers. */
import { execFileSync } from 'node:child_process'
import { cp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {} from '@deepseek-ai/dsh-workspace-changes/types'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type { ChangesSummary } from '@deepseek-ai/dsh-client-ui-deliverables/src/changes.ts'
import {
  launchWebScaffold, watchConsole, captureStableAria, compareOrRefreshGolden, assertFixtureInventory,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SESSION = SessionId('workspace-review-web')
const DIRECTORY = fileURLToPath(new URL('./snapshots/workspace-review', import.meta.url))

describe('web e2e: delivered files and historical review', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  const previousHosts: WebScaffold[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ workbench: true })
    const { ctx, workspaceCwd } = scaffold
    execFileSync('git', ['init', '--quiet'], { cwd: workspaceCwd })
    await writeFile(join(workspaceCwd, 'review.txt'), 'before the turn\n')
    const created = await ctx.apiProxy.sessions.create({ rpcId: RpcId('review-create'), payload: { sessionId: SESSION, cwd: workspaceCwd } })
    if (!created.result.ok) throw new Error(created.result.error.message)
    const agent = ctx.agents.get(SESSION)
    if (agent === undefined) throw new Error('Created Session has no Agent')
    const session = agent.session
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Update the review file.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    // The extra appended line leaves an empty fill row on the comparison's
    // left side, which exercises the full-width paint of empty alignment rows.
    const args = { file_path: 'review.txt', content: 'after the turn\nand one more line\n' }
    // The recorder observes the same pre-execution waterfall as a real file tool.
    await ctx.waterfall('tools/pre-execute', { agent, name: 'write', arguments: args } as never, () => Promise.resolve(undefined as never))
    await writeFile(join(workspaceCwd, 'review.txt'), args.content)
    const callId = ToolCallId('review-write')
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name: 'write', arguments: JSON.stringify(args) }],
      source: { provider: 'fixture', model: 'fixture' },
    }) }, { surfaceOp: 'append' })
    const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'write', arguments: JSON.stringify(args) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Updated review.txt' }], isError: false }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    const delivery = await ctx.tools.execute({
      agent, signal: new AbortController().signal, name: 'present', callId: ToolCallId('review-present'),
      arguments: { files: [{ path: 'review.txt', description: 'Reviewed text file' }] },
    })
    expect(delivery.isError).toBe(false)
    expect(session.snapshotEvents().find(event => event.type === 'deliverables/presented'))
      .toMatchObject({ data: { files: [{ path: join(workspaceCwd, 'review.txt'), description: 'Reviewed text file' }] } })
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      content: [{ type: 'text', text: 'The review file is ready.' }], source: { provider: 'fixture', model: 'fixture' },
    }) }, { surfaceOp: 'append' })
    await ctx.parallel('agent/turn-stopping', { agent, turn: 1 } as never)
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const event = session.snapshotEvents().find(event => event.type === 'workspace/changes')
    if (event === undefined) throw new Error('Shipped recorder did not announce changes')
    expect((await ctx.workspaceChanges.summary(SESSION, event.seq))?.files.map(file => file.path)).toContain('review.txt')
    // Ordinary preview must see the newer file while Review keeps the turn snapshot.
    await writeFile(join(workspaceCwd, 'review.txt'), 'current file changed later\n')
    const workspace = await ctx.workspaceRegistry.create(workspaceCwd)
    await workspace.attachSession(SESSION)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally {
      const failures: unknown[] = []
      for (const host of [scaffold, ...previousHosts.toReversed()]) {
        try { await host?.close() } catch (error) { failures.push(error) }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Review Hosts did not clean up')
    }
  })

  it('opens the recorded comparison and separately previews the current file', async () => {
    if (scaffold === undefined) throw new Error('Web scaffold unavailable')
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-review'))
    const tripwire = watchConsole(page)
    const summaryResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/workspaceChanges.summary'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const summaryWire: unknown = await (await summaryResponse).json()
    expect(summaryWire, JSON.stringify(summaryWire)).toMatchObject({ result: { ok: true, value: { files: [{ path: 'review.txt' }] } } })
    await page.getByText('The review file is ready.', { exact: true }).waitFor()
    await page.locator('[data-presented-file]').waitFor()
    await page.locator('[data-changed-files] button').first().click()
    const review = page.locator('[data-changes-review]')
    await expect.poll(() => review.textContent()).toContain('before the turn')
    expect(await review.textContent()).toContain('after the turn')
    expect(await review.textContent()).not.toContain('current file changed later')
    // The host reports an open-in-app handler only on desktops that probe
    // one, so the default-app row is environment-dependent chrome.
    const reviewSnapshot = (await captureStableAria(page, '[data-changes-review]', scaffold.workspaceCwd))
      .replace(/\n *- button "Open [^\n]* in default app":\n *- img/g, '')
    await compareOrRefreshGolden(join(DIRECTORY, 'review.expected.md'), reviewSnapshot, webSnapshotMode())
    await review.locator('[data-review-tool="split"]').click()
    // The appended row has no old-side text; constrain the columns so the hunk header overflows it.
    const emptyRowLayout = await page.addStyleTag({ content: `
      [data-diff-side="left"] { width: 90px; }
      [data-diff-side="right"] { width: 120px; }
    ` })
    try {
      const left = review.locator('[data-diff-side="left"]')
      const emptyRow = left.locator('[data-diff-line="add"]').last()
      const maximum = await left.evaluate(element => element.scrollWidth - element.clientWidth)
      expect(maximum).toBeGreaterThan(0)
      await left.evaluate((element) => { element.scrollLeft = element.scrollWidth })
      await expect.poll(() => left.evaluate(element => element.scrollLeft)).toBe(maximum)
      const fill = await emptyRow.evaluate((row) => {
        const column = row.closest('[data-diff-side]')!
        const columnBox = column.getBoundingClientRect()
        const rowBox = row.getBoundingClientRect()
        const y = rowBox.top + rowBox.height / 2
        return {
          rowWidth: rowBox.width,
          contentWidth: column.scrollWidth,
          background: getComputedStyle(row).backgroundColor,
          coversViewport: [columnBox.left + 4, columnBox.right - 4].every(x =>
            document.elementFromPoint(x, y)?.closest('[data-diff-line]') === row),
        }
      })
      expect(fill.background).not.toBe('rgba(0, 0, 0, 0)')
      expect(fill.rowWidth).toBeGreaterThanOrEqual(fill.contentWidth - 0.5)
      expect(fill.coversViewport).toBe(true)
    } finally {
      await emptyRowLayout.evaluate(element => element.parentNode!.removeChild(element))
      await review.locator('[data-diff-side]').evaluateAll((elements) => {
        for (const element of elements) element.scrollLeft = 0
      })
    }
    await review.locator('[data-review-tool="wrap"]').click()
    expect(await review.locator('[data-review-tool="split"]').getAttribute('aria-pressed')).toBe('true')
    await review.locator('[data-review-tool="open-file"]').click()
    expect(tripwire.pageErrors).toEqual([])
    await page.getByText('current file changed later', { exact: false }).waitFor()
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(await page.locator('[data-slot-error]').count()).toBe(0)
  }, 60_000)

  it('keeps edge gestures inside either diff column and accepts reverse scrolling', async () => {
    if (scaffold === undefined) throw new Error('Web scaffold unavailable')
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-review-overscroll'))
    const tripwire = watchConsole(page)
    // The previous scenario leaves the file preview active; the review stays as a sibling tab.
    await page.getByRole('tab', { name: 'Review · turn 1' }).click()
    const review = page.locator('[data-changes-review]')
    const wrapButton = review.getByRole('button', { name: 'Line wrap' })
    if (await wrapButton.getAttribute('aria-pressed') === 'true') await wrapButton.click()
    const body = review.locator('[data-review-view="split"]:not([data-review-wrap])')
    await body.waitFor({ state: 'visible' })
    // A scrollable parent makes escaped edge gestures observable without native trackpad rebound.
    const layout = await page.addStyleTag({ content: `
      [data-changes-review] { height: 220px !important; }
      [data-review-view="split"] { display: block; max-width: 220px; }
      [data-review-view="split"] > div { width: 160px; height: 60px; margin: 160px; }
    ` })
    onTestFinished(async () => {
      await layout.evaluate(element => element.parentNode!.removeChild(element))
      await body.evaluate((element) => { element.scrollTo(0, 0) })
      if (await wrapButton.getAttribute('aria-pressed') !== 'true') await wrapButton.click()
    })
    const input = await page.context().newCDPSession(page)
    try {
      for (const side of ['left', 'right']) {
        const column = review.locator(`[data-diff-side="${side}"]`)
        for (const axis of ['x', 'y'] as const) {
          for (const end of [false, true]) {
            const parentPosition = await body.evaluate((element) => {
              const x = (element.scrollWidth - element.clientWidth) / 2
              const y = (element.scrollHeight - element.clientHeight) / 2
              element.scrollTo(x, y)
              return { x: element.scrollLeft, y: element.scrollTop }
            })
            expect(parentPosition.x).toBeGreaterThan(0)
            expect(parentPosition.y).toBeGreaterThan(0)
            const edge = await column.evaluate((element, { axis, end }) => {
              const maximum = axis === 'x'
                ? element.scrollWidth - element.clientWidth
                : element.scrollHeight - element.clientHeight
              element.scrollTo(axis === 'x' && end ? maximum : 0, axis === 'y' && end ? maximum : 0)
              return { maximum, offset: end ? maximum : 0 }
            }, { axis, end })
            expect(edge.maximum).toBeGreaterThan(0)
            const position = () => column.evaluate((element, axis) => axis === 'x' ? element.scrollLeft : element.scrollTop, axis)
            await expect.poll(position).toBe(edge.offset)
            const box = await column.boundingBox()
            if (box === null) throw new Error('diff column has no visible bounds')
            const gesture = { x: box.x + box.width / 2, y: box.y + box.height / 2, gestureSourceType: 'mouse' as const }
            const distance = end ? -80 : 80
            // CDP acknowledges the completed gesture, including default scrolling, before observation.
            await input.send('Input.synthesizeScrollGesture', {
              ...gesture, xDistance: axis === 'x' ? distance : 0, yDistance: axis === 'y' ? distance : 0,
            })
            expect(await body.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }))).toEqual(parentPosition)
            expect(await position()).toBe(edge.offset)
            await input.send('Input.synthesizeScrollGesture', {
              ...gesture, xDistance: axis === 'x' ? -distance : 0, yDistance: axis === 'y' ? -distance : 0,
            })
            await expect.poll(position).not.toBe(edge.offset)
          }
        }
      }
    } finally {
      await input.detach()
    }
    expect(tripwire.pageErrors).toEqual([])
  })

  it('preserves filename endings when the review narrows and updates the fade after resizing', async () => {
    if (scaffold === undefined || browser === undefined) throw new Error('Web scaffold unavailable')
    const previewContext = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    const preview = await previewContext.newPage()
    onTestFinished(async () => { await previewContext.close() })
    const previewTripwire = watchConsole(preview)
    const longName = 'src/components/review/' + 'long-filename-'.repeat(8) + 'before.ts'
    // Project a long display name into a separate page; recorded paths, comparisons, and Session data stay intact.
    await preview.route('**/workspaceChanges.summary*', async (route) => {
      const response = await route.fetch()
      const wire = await response.json() as { result?: { ok?: boolean; value?: ChangesSummary } }
      if (wire.result?.ok === true && wire.result.value !== undefined) {
        wire.result.value = {
          ...wire.result.value,
          files: wire.result.value.files.map((file, index) => index === 0 ? { ...file, display: longName } : file),
        }
      }
      await route.fulfill({ response, json: wire })
    })
    await preview.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await preview.locator('[data-changed-files] button').first().click()
    const review = preview.locator('[data-changes-review]')
    const selector = review.getByRole('button', { name: 'Choose the file to review' })
    const label = selector.locator('[data-path-label]')
    const layout = await preview.addStyleTag({ content: '[data-sidebar-right-panel] { width: 340px !important; }' })
    const resize = async (width: number) => {
      await layout.evaluate((element, width) => {
        element.textContent = `[data-sidebar-right-panel] { width: ${width}px !important; }`
      }, width)
    }
    const metrics = () => label.evaluate((element) => {
      const text = element.firstElementChild!
      const box = element.getBoundingClientRect()
      const textBox = text.getBoundingClientRect()
      const filename = text.lastElementChild!
      const suffix = document.createRange()
      const node = filename.firstChild!
      suffix.setStart(node, Math.max(0, node.textContent!.length - 'before.ts'.length))
      suffix.setEnd(node, node.textContent!.length)
      const suffixBox = suffix.getBoundingClientRect()
      return {
        clipped: element.hasAttribute('data-path-clipped'), mask: getComputedStyle(element).maskImage,
        left: textBox.left - box.left, right: box.right - textBox.right,
        suffixVisible: suffixBox.left >= box.left && suffixBox.right <= box.right + 0.5,
        directoryColor: getComputedStyle(text.firstElementChild!).color,
        nameColor: getComputedStyle(filename).color,
      }
    })
    await expect.poll(async () => (await metrics()).clipped).toBe(true)
    const clipped = await metrics()
    expect(clipped.left).toBeLessThan(0)
    expect(Math.abs(clipped.right)).toBeLessThanOrEqual(0.5)
    expect(clipped.suffixVisible).toBe(true)
    expect(clipped.mask).toContain('linear-gradient')
    expect(clipped.directoryColor).not.toBe(clipped.nameColor)
    expect(await label.getAttribute('title')).toBe(longName)
    const controls = await selector.evaluate((button) => {
      const header = button.parentElement!.parentElement!
      const bounds = header.getBoundingClientRect()
      const caret = button.querySelector('svg')!
      const counts = button.parentElement!.nextElementSibling!
      return [caret, counts, ...header.querySelectorAll('[data-review-tool]')].map((element) => {
        const box = element.getBoundingClientRect()
        return box.width > 0 && box.left >= bounds.left && box.right <= bounds.right
      })
    })
    expect(controls.every(Boolean)).toBe(true)
    await resize(1400)
    await expect.poll(async () => (await metrics()).clipped).toBe(false)
    expect((await metrics()).left).toBeCloseTo(0, 1)
    expect((await metrics()).mask).toBe('none')
    expect(previewTripwire.pageErrors).toEqual([])
  })

  it('owns only its review golden', async () => { await assertFixtureInventory(DIRECTORY, ['review.expected.md']) })

  it('reopens the recorded review on an independent Host after the current file is deleted', async () => {
    if (scaffold === undefined) throw new Error('Web scaffold unavailable')
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-review-restart'))
    const prior = scaffold
    const live = prior.ctx.sessions.get(SESSION)
    if (live === undefined) throw new Error('Review Session unavailable before restart')
    await prior.ctx.sessions.flush(live)
    const reader = await prior.ctx.sessionPersistence.open(SESSION, 'read')
    const header = reader.header
    let history: Awaited<ReturnType<typeof reader.read>>
    try { history = await reader.read() } finally { await reader.close() }
    await prior.ctx.fiber.dispose()
    previousHosts.push(prior)
    scaffold = await launchWebScaffold({ workbench: true })
    const writer = await scaffold.ctx.sessionPersistence.create(header)
    try { await writer.append(history.events) } finally { await writer.close() }
    await cp(join(prior.harnessHome, 'workspace-reviews'), join(scaffold.harnessHome, 'workspace-reviews'), { recursive: true })
    await rm(join(prior.workspaceCwd, 'review.txt'))
    const workspace = await scaffold.ctx.workspaceRegistry.create(prior.workspaceCwd)
    await workspace.attachSession(SESSION)
    expect(scaffold.ctx.agents.get(SESSION) === undefined, 'cold Host before Review lookup').toBe(true)
    const announcement = history.events.find(event => event.type === 'workspace/changes')
    if (announcement === undefined) throw new Error('Persisted history lost the review announcement')
    const coldSummary = await scaffold.ctx.workspaceChanges.summary(SESSION, announcement.seq)
    expect(JSON.parse(JSON.stringify(coldSummary ?? null)) as unknown).toMatchObject({ files: [{ path: 'review.txt' }] })
    const read = await scaffold.ctx.apiProxy.workspaceChanges.summary({ rpcId: RpcId('cold-review'), payload: { sessionId: SESSION, seq: announcement.seq } })
    expect(JSON.parse(JSON.stringify(read.result)) as unknown).toMatchObject({ ok: true, value: { files: [{ path: 'review.txt' }] } })
    const transcript = await scaffold.ctx.apiProxy.sessions.history({ rpcId: RpcId('cold-review-history'), payload: { sessionId: SESSION, detail: 'conversation' } })
    if (!transcript.result.ok) throw new Error(transcript.result.error.message)
    expect(transcript.result.value.events.some(entry => entry.event.type === 'workspace/changes'), 'cold history includes the Review announcement').toBe(true)
    expect(scaffold.ctx.agents.get(SESSION) === undefined, 'Review RPC does not activate an Agent').toBe(true)
    const modelCalls = vi.spyOn(scaffold.ctx.llm, 'stream')
    const startedTurns: number[] = []
    const stopWatching = scaffold.ctx.on('session/event', (session, event) => {
      if (session.id === SESSION && event.type === 'turn/start') startedTurns.push(event.data.turn)
    })
    const coldResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/workspaceChanges.summary'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByText('The review file is ready.', { exact: true }).waitFor()
    expect(await (await coldResponse).json()).toMatchObject({ result: { ok: true, value: { files: [{ path: 'review.txt' }] } } })
    await page.locator('[data-changed-files] button').first().click()
    const review = page.locator('[data-changes-review]')
    await expect.poll(() => review.textContent()).toContain('before the turn')
    expect(await review.textContent()).toContain('after the turn')
    expect(await review.textContent()).not.toContain('current file changed later')
    expect(modelCalls).not.toHaveBeenCalled()
    expect(startedTurns).toEqual([])
    stopWatching()
    modelCalls.mockRestore()
    expect(await page.locator('[data-slot-error]').count()).toBe(0)
  }, 120_000)
})
