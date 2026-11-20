/** Historical workspace review through the shipped recorder, RPC, and Web consumers. */
import { responsiveBrowser, responsiveBrowserName } from './responsive-browser.ts'
import { auditWorkflowState, compareWorkflowGolden, newWorkflowPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, type Page } from 'playwright'
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
import { completionBarrier, newEnglishPage, saveFailureShot } from './support.ts'
import { captureTextContrast, expectTextContrast } from './text-contrast.ts'

const SESSION = SessionId('workspace-review-web')
const DIRECTORY = fileURLToPath(new URL('./snapshots/workspace-review', import.meta.url))

/** Execute and log real file tools in a private repository, leaving publication to the caller. */
async function writeRecordedFiles(host: WebScaffold, id: SessionId, names: readonly string[]) {
  const cwd = join(host.workspaceCwd, id)
  await mkdir(cwd)
  execFileSync('git', ['init', '--quiet'], { cwd })
  for (const name of names) await writeFile(join(cwd, name), `Before ${name}\n`)
  const created = await host.ctx.apiProxy.sessions.create({ rpcId: RpcId(`${id}-create`), payload: { sessionId: id, cwd } })
  if (!created.result.ok) throw new Error(created.result.error.message)
  const agent = host.ctx.agents.get(id)
  if (agent === undefined) throw new Error('File fixture Session has no Agent')
  const signal = new AbortController().signal
  const read = await host.ctx.tools.execute({ agent, signal, calls: names.map((name, index) => ({
    type: 'tool-call' as const, id: ToolCallId(`${id}-read-${index}`), name: 'read',
    arguments: JSON.stringify({ file_path: name }),
  })) })
  expect(read.results.filter(result => result.result.isError).map(result => result.result.content)).toEqual([])
  const { session } = agent
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Update the fixture files.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  const calls = names.map((name, index) => ({
    type: 'tool-call' as const, id: ToolCallId(`${id}-write-${index}`), name: 'write',
    arguments: JSON.stringify({ file_path: name, content: `After ${name}\n` }),
  }))
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    content: calls, source: { provider: 'fixture', model: 'fixture' },
  }) }, { surfaceOp: 'append' })
  const written = await host.ctx.tools.execute({ agent, log: { turn: 1, step: 1 }, calls, signal })
  expect(written.results).toHaveLength(names.length)
  expect(written.results.filter(result => result.result.isError).map(result => result.result.content)).toEqual([])
  for (const name of names) expect(await readFile(join(cwd, name), 'utf8')).toBe(`After ${name}\n`)
  await (await host.ctx.workspaceRegistry.create(cwd)).attachSession(id)
  return agent
}

describe('web e2e: delivered files and historical review', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  const previousHosts: WebScaffold[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ workbench: true })
    const { ctx, workspaceCwd } = scaffold
    execFileSync('git', ['init', '--quiet'], { cwd: workspaceCwd })
    // The scaffold plants the private harness homes inside the workspace; a
    // work-tree snapshot must never walk their live temporary files.
    await writeFile(join(workspaceCwd, '.gitignore'), '.dsh-home/\n.agents-home/\n.bundled-skills/\n')
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
    const delivery = (await ctx.tools.execute({
      agent, signal: new AbortController().signal,
      calls: [{
        type: 'tool-call', id: ToolCallId('review-present'), name: 'present',
        arguments: JSON.stringify({ files: [{ path: 'review.txt', description: 'Reviewed text file' }] }),
      }],
    })).results[0]!.result
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
    browser = await responsiveBrowser.launch()
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
    // one, so the default-app row and its overflow menu are
    // environment-dependent chrome.
    const reviewSnapshot = (await captureStableAria(page, '[data-changes-review]', scaffold.workspaceCwd))
      .replace(/\n *- button "Open [^\n]* in default app":\n *- img/g, '')
      .replace(/\n *- button "More file actions for [^\n]*":\n *- img/g, '')
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

  it.skipIf(responsiveBrowserName !== 'chromium')('keeps CDP edge gestures inside either diff column and accepts reverse scrolling', async () => {
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

  it.skipIf(!workflowMatrixEnabled)('inspects delivery, review loading, failure, split and wrap at every touch viewport', async () => {
    if (scaffold === undefined || browser === undefined) throw new Error('Web scaffold unavailable')
    const touchPage = await newWorkflowPage(browser)
    const tripwire = watchConsole(touchPage)
    const release = completionBarrier()
    const diffRoute = '**/workspaceChanges.diff*'
    try {
      await touchPage.route(diffRoute, async (route) => {
        await release.promise
        await route.fulfill({ status: 503, body: 'Temporarily unavailable' })
      })
      await touchPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await touchPage.getByText('The review file is ready.', { exact: true }).waitFor()
      const delivered = touchPage.locator('[data-presented-file]')
      await auditWorkflowState(touchPage, 'deliverables', 'presented-file-card', delivered)
      const changed = touchPage.locator('[data-changed-files]')
      expectTextContrast(await captureTextContrast(touchPage, [
        { label: 'added', text: changed.locator('[class*="added"]').first() },
        { label: 'deleted', text: changed.locator('[class*="deleted"]').first() },
      ], 'deliverables-changed-counts'))
      await auditWorkflowState(touchPage, 'deliverables', 'changed-file-list', changed)
      await changed.getByRole('button').first().tap()
      const review = touchPage.locator('[data-changes-review]')
      await review.getByText('Reading changes…', { exact: true }).waitFor()
      await auditWorkflowState(touchPage, 'deliverables', 'review-loading', review)
      release.resolve()
      await review.getByText('Could not read the changes', { exact: true }).waitFor()
      const retry = review.getByRole('button', { name: 'Retry', exact: true })
      await auditWorkflowState(touchPage, 'deliverables', 'review-read-failure', review, [retry])
      await touchPage.unroute(diffRoute)
      await retry.tap()
      await expect.poll(() => review.textContent()).toContain('before the turn')
      const file = review.getByRole('button', { name: 'Choose the file to review', exact: true })
      expectTextContrast(await captureTextContrast(touchPage, [
        { label: 'added', text: review.locator('[class*="added"]').first() },
        { label: 'deleted', text: review.locator('[class*="deleted"]').first() },
      ], 'deliverables-review-counts'))
      await auditWorkflowState(touchPage, 'deliverables', 'review-unified', review, [file], async () => {
        for (const action of [file, ...await review.locator('[data-review-tool]').all()]) {
          const box = await action.boundingBox()
          expect(box?.height, await action.getAttribute('aria-label') ?? 'review action').toBeGreaterThanOrEqual(44)
        }
      })
      await file.tap()
      expectTextContrast(await captureTextContrast(touchPage, [
        { label: 'added', text: touchPage.getByRole('menu').locator('[class*="added"]').first() },
        { label: 'deleted', text: touchPage.getByRole('menu').locator('[class*="deleted"]').first() },
      ], 'deliverables-review-menu-counts'))
      await auditWorkflowState(touchPage, 'deliverables', 'review-file-chooser', touchPage.getByRole('menu'))
      await touchPage.getByRole('menuitem').first().tap()
      const split = review.getByRole('button', { name: 'Split view', exact: true })
      const wrap = review.getByRole('button', { name: 'Line wrap', exact: true })
      await split.tap()
      expect(await split.getAttribute('aria-pressed')).toBe('true')
      await auditWorkflowState(touchPage, 'deliverables', 'review-split', review, [split, wrap])
      await wrap.tap()
      expect(await wrap.getAttribute('aria-pressed')).toBe('true')
      await auditWorkflowState(touchPage, 'deliverables', 'review-split-wrapped', review, [split, wrap])
      await review.locator('[data-review-tool="open-file"]').tap()
      const preview = touchPage.getByRole('region', { name: 'review.txt', exact: true })
      await preview.getByText('current file changed later', { exact: false }).waitFor()
      await auditWorkflowState(touchPage, 'deliverables', 'review-current-file-preview', preview)
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(touchPage, 'workspace-review-responsive'); throw error }
    finally { release.resolve(); await touchPage.unrouteAll({ behavior: 'wait' }); await touchPage.close() }
  }, 180_000)

  it('expands and folds real multi-file deliveries and changes without losing file selection', async () => {
    if (scaffold === undefined || browser === undefined) throw new Error('Web scaffold unavailable')
    const host = scaffold
    const id = SessionId('workspace-review-multiple')
    const names = ['delivery-1.txt', 'delivery-2.txt', 'delivery-3.txt', 'delivery-4.txt', '第五份-完整交付文件.txt']
    const agent = await writeRecordedFiles(host, id, names)
    const call = { type: 'tool-call' as const, id: ToolCallId('multiple-present'), name: 'present',
      arguments: JSON.stringify({ files: names.map(path => ({ path, description: `Delivered ${path}` })) }) }
    agent.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      content: [call], source: { provider: 'fixture', model: 'fixture' },
    }) }, { surfaceOp: 'append' })
    const delivered = await host.ctx.tools.execute({
      agent, log: { turn: 1, step: 1 }, calls: [call], signal: new AbortController().signal,
    })
    expect(delivered.results[0]?.result.isError).toBe(false)
    await host.ctx.serial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const announcement = agent.session.snapshotEvents().find(event => event.type === 'workspace/changes')
    if (announcement === undefined) throw new Error('Multi-file recorder did not publish its review')
    const summary = await host.ctx.workspaceChanges.summary(id, announcement.seq)
    expect(summary?.total).toBe(5)
    expect(summary?.files.map(file => file.path).sort()).toEqual([...names].sort())
    expect(agent.session.snapshotEvents().find(event => event.type === 'deliverables/presented')?.data.files).toHaveLength(5)
    const target = await newWorkflowPage(browser)
    const tripwire = watchConsole(target)
    await target.addInitScript((sessionId) => {
      if (window === window.top) localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }))
    }, id)
    try {
      await target.goto(host.authenticatedUrl, { waitUntil: 'load' })
      const deliveries = target.locator('[data-presented-files-row]').locator('xpath=..')
      const cards = deliveries.locator('[data-presented-file]')
      const changes = target.locator('[data-changed-files]')
      const rows = changes.locator(':scope > ul > li')
      await expect.poll(() => cards.count()).toBe(4)
      await expect.poll(() => rows.count()).toBe(4)
      const expandDeliveries = deliveries.getByRole('button', { name: 'Show all 5 delivered files', exact: true })
      const expandChanges = changes.getByRole('button', { name: 'Show all 5 changed files', exact: true })
      await auditWorkflowState(target, 'deliverables', 'multiple-deliveries-collapsed', deliveries, [expandDeliveries])
      await auditWorkflowState(target, 'deliverables', 'multiple-changes-collapsed', changes, [expandChanges])
      await expandDeliveries.click()
      await expandChanges.click()
      await expect.poll(() => cards.count()).toBe(5)
      await expect.poll(() => rows.count()).toBe(5)
      const collapseDeliveries = deliveries.getByRole('button', { name: 'Collapse delivered files', exact: true })
      const collapseChanges = changes.getByRole('button', { name: 'Collapse changed files', exact: true })
      await auditWorkflowState(target, 'deliverables', 'multiple-deliveries-expanded', deliveries, [collapseDeliveries])
      await auditWorkflowState(target, 'deliverables', 'multiple-changes-expanded', changes, [collapseChanges])
      await compareWorkflowGolden(join(DIRECTORY, 'multiple-files.expected.md'),
        `${await captureStableAria(target, '[data-presented-files-row]', host.workspaceCwd)}\n${await captureStableAria(target, '[data-changed-files]', host.workspaceCwd)}`, webSnapshotMode())
      await collapseDeliveries.click()
      await collapseChanges.click()
      await expect.poll(() => cards.count()).toBe(4)
      await expect.poll(() => rows.count()).toBe(4)
      expect(await expandDeliveries.getAttribute('aria-expanded')).toBe('false')
      expect(await expandChanges.getAttribute('aria-expanded')).toBe('false')
      await expandChanges.click()
      await rows.last().getByRole('button').click()
      const review = target.locator('[data-changes-review]')
      const last = summary!.files.at(-1)!.path
      await expect.poll(() => review.locator('[data-review-file]').getAttribute('data-review-file')).toBe(last)
      await expect.poll(() => review.textContent()).toContain(`After ${last}`)
      await review.getByRole('button', { name: 'Choose the file to review', exact: true }).click()
      const chooser = target.getByRole('menu')
      expect(await chooser.getByRole('menuitem').count()).toBe(5)
      await auditWorkflowState(target, 'deliverables', 'multiple-file-chooser', chooser)
      await chooser.getByRole('menuitem').first().click()
      const first = summary!.files[0]!.path
      await expect.poll(() => review.locator('[data-review-file]').getAttribute('data-review-file')).toBe(first)
      await expect.poll(() => review.textContent()).toContain(`After ${first}`)
      expect(await cards.count()).toBe(4)
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(target, 'workspace-review-multiple'); throw error }
    finally { await target.close() }
  }, 180_000)

  it('shows the recorder storage failure without claiming zero changes or removing earlier reviews', async () => {
    if (scaffold === undefined || browser === undefined) throw new Error('Web scaffold unavailable')
    const host = scaffold
    const id = SessionId('workspace-review-storage-failure')
    const earlier = host.ctx.sessions.get(SESSION)?.snapshotEvents().find(event => event.type === 'workspace/changes')
    if (earlier === undefined) throw new Error('Earlier historical review unavailable')
    const preserved = await host.ctx.workspaceChanges.diff(SESSION, earlier.seq, 0, new AbortController().signal)
    const agent = await writeRecordedFiles(host, id, ['changed-before-storage-failure.txt'])
    const root = join(host.harnessHome, 'workspace-reviews')
    await mkdir(root, { recursive: true })
    const obstruction = join(root, createHash('sha256').update(id).digest('hex'))
    await writeFile(obstruction, 'Fixture-owned unavailable Session review directory\n', { flag: 'wx' })
    const target = await newWorkflowPage(browser)
    const tripwire = watchConsole(target)
    try {
      await expect(host.ctx.serial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal }))
        .rejects.toThrow('Historical review did not complete')
      agent.session.append('step/end', { turn: 1, step: 1 })
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
      const announcements = agent.session.snapshotEvents().filter(event => event.type === 'workspace/changes')
      expect(announcements).toHaveLength(1)
      expect(announcements[0]!.data).toMatchObject({ turn: 1, incomplete: true })
      expect(await host.ctx.workspaceChanges.summary(id, announcements[0]!.seq)).toMatchObject({ incomplete: true })
      expect(await readFile(join(host.workspaceCwd, id, 'changed-before-storage-failure.txt'), 'utf8')).toBe('After changed-before-storage-failure.txt\n')
      expect(await host.ctx.workspaceChanges.diff(SESSION, earlier.seq, 0, new AbortController().signal)).toEqual(preserved)
      await target.addInitScript((sessionId) => {
        if (window === window.top) localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }))
      }, id)
      await target.goto(host.authenticatedUrl, { waitUntil: 'load' })
      const alert = target.locator('[data-changed-files][role="alert"]')
      await alert.getByText('This turn’s review did not complete', { exact: true }).waitFor()
      expect(await alert.textContent()).toContain('File changes may already have occurred.')
      expect(await alert.getByRole('button').count()).toBe(0)
      expect(await alert.textContent()).not.toContain('Edited 0 files')
      expectTextContrast(await captureTextContrast(target, [
        { label: 'heading', text: alert.locator('strong') }, { label: 'explanation', text: alert.locator('p') },
      ], 'deliverables-storage-incomplete'))
      await auditWorkflowState(target, 'deliverables', 'review-storage-incomplete', alert)
      await compareWorkflowGolden(join(DIRECTORY, 'storage-incomplete.expected.md'),
        await captureStableAria(target, '[data-changed-files]', host.workspaceCwd), webSnapshotMode())
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(target, 'workspace-review-storage-failure'); throw error }
    finally { try { await target.close() } finally { await rm(obstruction) } }
  }, 120_000)

  it('retries an unavailable recorded summary while keeping delivered-file preview usable', async () => {
    if (scaffold === undefined || browser === undefined) throw new Error('Web scaffold unavailable')
    const host = scaffold
    const target = await newWorkflowPage(browser)
    const tripwire = watchConsole(target)
    const summaryRoute = '**/workspaceChanges.summary*'
    await target.addInitScript((sessionId) => {
      if (window === window.top) localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }))
    }, SESSION)
    try {
      await target.route(summaryRoute, route => route.fulfill({ status: 503, body: 'Historical storage temporarily unavailable' }))
      await target.goto(host.authenticatedUrl, { waitUntil: 'load' })
      const unavailable = target.locator('[data-review-unavailable]')
      const retry = unavailable.getByRole('button', { name: 'Retry', exact: true })
      await retry.waitFor()
      expect(await unavailable.textContent()).toContain('This turn’s recorded changes are temporarily unavailable.')
      expect(await target.locator('[data-changed-files]').count()).toBe(0)
      await auditWorkflowState(target, 'deliverables', 'review-summary-unavailable', unavailable, [retry])
      await compareWorkflowGolden(join(DIRECTORY, 'summary-unavailable.expected.md'),
        await captureStableAria(target, '[data-review-unavailable]', host.workspaceCwd), webSnapshotMode())
      await target.locator('[data-presented-file]').getByRole('button', { name: /Open .* in sidebar/u }).click()
      const preview = target.getByRole('region', { name: 'review.txt', exact: true })
      await preview.getByText('current file changed later', { exact: false }).waitFor()
      await target.unroute(summaryRoute)
      const [response] = await Promise.all([
        target.waitForResponse(value => new URL(value.url()).pathname.endsWith('/workspaceChanges.summary')),
        retry.click(),
      ])
      expect(await response.json()).toMatchObject({ result: { ok: true, value: { files: [{ path: 'review.txt' }] } } })
      await unavailable.waitFor({ state: 'hidden' })
      await target.locator('[data-changed-files]').waitFor()
      await preview.getByText('current file changed later', { exact: false }).waitFor()
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(target, 'workspace-review-summary-unavailable'); throw error }
    finally { try { await target.unrouteAll({ behavior: 'wait' }) } finally { await target.close() } }
  }, 120_000)

  it('keeps native file action failures retryable without launching an external application', async () => {
    if (scaffold === undefined || browser === undefined) throw new Error('Web scaffold unavailable')
    const host = scaffold
    const target = await newWorkflowPage(browser)
    const tripwire = watchConsole(target)
    const appsGate = completionBarrier()
    const openGate = completionBarrier()
    const revealGate = completionBarrier()
    const reviewOpenGate = completionBarrier()
    const reviewRevealGate = completionBarrier()
    const describeHost = host.ctx.apiProxy.host.describe.bind(host.ctx.apiProxy.host)
    const description = vi.spyOn(host.ctx.apiProxy.host, 'describe').mockImplementation(async (request) => {
      const result = await describeHost(request)
      if (result.result.ok) {
        result.result.value.canOpenPath = true
        result.result.value.fileManager = null
        result.result.value.executionAuthorityRequired = false
      }
      return result
    })
    const applications = vi.spyOn(host.ctx.apiProxy.host, 'fileApplications')
      .mockImplementation(async request => ({ rpcId: request.rpcId, result: { ok: true, value: { applications: [
        { id: 'fixture.editor', name: 'Fixture Editor', default: true, icon: null },
      ] } } }))
      .mockImplementationOnce(async (request) => {
        await appsGate.promise
        return { rpcId: request.rpcId, result: { ok: false, error: { code: 'internal', message: 'Associations unavailable', details: {} } } }
      })
    const open = vi.spyOn(host.ctx.apiProxy.host, 'openPath')
      .mockImplementation(async request => ({ rpcId: request.rpcId, result: { ok: true, value: { opened: true as const } } }))
      .mockImplementationOnce(async (request) => {
        await openGate.promise
        return { rpcId: request.rpcId, result: { ok: false, error: { code: 'internal', message: 'Desktop open unavailable', details: {} } } }
      })
    try {
      await target.addInitScript((sessionId) => {
        if (window === window.top) localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }))
      }, SESSION)
      await target.goto(host.authenticatedUrl, { waitUntil: 'load' })
      const card = target.locator('[data-presented-file]')
      const more = card.getByRole('button', { name: /More file actions for /u })
      const status = card.locator('[role="status"] [class*="secondaryText"]')
      await more.click()
      const menu = target.getByRole('menu')
      await menu.getByText('Loading applications…', { exact: true }).waitFor()
      await auditWorkflowState(target, 'deliverables', 'native-applications-loading', menu)
      appsGate.resolve()
      await menu.getByText('Could not load applications', { exact: true }).waitFor()
      await auditWorkflowState(target, 'deliverables', 'native-applications-failed', menu)
      await menu.getByRole('menuitem', { name: 'Open in default app', exact: true }).click()
      await target.mouse.move(0, 0)
      await expect.poll(() => status.innerText()).toBe('Opening…')
      expect(await more.isDisabled()).toBe(true)
      await auditWorkflowState(target, 'deliverables', 'native-open-pending', card)
      openGate.resolve()
      await expect.poll(() => status.innerText()).toBe('Could not open. Click to retry.')
      expectTextContrast(await captureTextContrast(target, [{ label: 'open-error', text: status, region: card.locator('[role="status"]') }], 'deliverables-native-open-error'))
      await auditWorkflowState(target, 'deliverables', 'native-open-failed', card)
      await compareWorkflowGolden(join(DIRECTORY, 'native-open-error.expected.md'),
        await captureStableAria(target, '[data-presented-file]', host.workspaceCwd), webSnapshotMode())
      await more.click()
      await menu.getByRole('menuitem', { name: 'Fixture Editor (default)', exact: true }).waitFor()
      await auditWorkflowState(target, 'deliverables', 'native-application-chooser', menu)
      await menu.getByRole('menuitem', { name: 'Fixture Editor (default)', exact: true }).click()
      await target.mouse.move(0, 0)
      await expect.poll(() => status.innerText()).toBe('Opened in default app')
      expect(open.mock.calls.at(-1)?.[0].payload).toEqual({ path: join(host.workspaceCwd, 'review.txt'), action: 'open', application: 'fixture.editor' })
      await auditWorkflowState(target, 'deliverables', 'native-open-retried', card)
      open.mockImplementationOnce(async (request) => {
        await revealGate.promise
        return { rpcId: request.rpcId, result: { ok: false, error: { code: 'internal', message: 'Directory open unavailable', details: {} } } }
      })
      await more.click()
      await menu.getByRole('menuitem', { name: 'Open containing folder', exact: true }).click()
      await target.mouse.move(0, 0)
      await expect.poll(() => status.innerText()).toBe('Opening containing folder…')
      expect(await more.isDisabled()).toBe(true)
      await auditWorkflowState(target, 'deliverables', 'native-reveal-pending', card)
      revealGate.resolve()
      await expect.poll(() => status.innerText()).toBe('Could not open containing folder. Try again.')
      expectTextContrast(await captureTextContrast(target, [{ label: 'reveal-error', text: status, region: card.locator('[role="status"]') }], 'deliverables-native-reveal-error'))
      await auditWorkflowState(target, 'deliverables', 'native-reveal-failed', card)
      await more.click()
      await menu.getByRole('menuitem', { name: 'Open containing folder', exact: true }).click()
      await target.mouse.move(0, 0)
      await expect.poll(() => status.innerText()).toBe('Requested to open the containing folder')
      expect(open.mock.calls.at(-1)?.[0].payload).toEqual({ path: join(host.workspaceCwd, 'review.txt'), action: 'reveal' })
      expect(applications.mock.calls.every(([request]) => request.payload.path === join(host.workspaceCwd, 'review.txt'))).toBe(true)
      await auditWorkflowState(target, 'deliverables', 'native-reveal-retried', card)
      expect(open).toHaveBeenCalledTimes(4)

      await target.locator('[data-changed-files]').getByRole('button').first().click()
      const review = target.locator('[data-changes-review]')
      await expect.poll(() => review.textContent()).toContain('before the turn')
      const native = review.locator('[data-review-tool="open-native"]')
      const nativeMore = review.locator('[data-review-tool="open-native-more"]')
      open.mockImplementationOnce(async (request) => {
        await reviewOpenGate.promise
        return { rpcId: request.rpcId, result: { ok: false, error: { code: 'internal', message: 'Review desktop open unavailable', details: {} } } }
      })
      await native.click()
      await expect.poll(() => native.isDisabled()).toBe(true)
      expect(await nativeMore.isDisabled()).toBe(true)
      await auditWorkflowState(target, 'deliverables', 'review-native-open-pending', review)
      reviewOpenGate.resolve()
      await expect.poll(() => native.getAttribute('data-error')).toBe('true')
      await nativeMore.focus()
      await target.keyboard.press('Shift+Tab')
      expect(await native.evaluate(element => element === document.activeElement)).toBe(true)
      await target.getByRole('tooltip').getByText('Could not open. Click to retry.', { exact: true }).waitFor()
      await auditWorkflowState(target, 'deliverables', 'review-native-open-failed', review, [native, nativeMore])
      const openFailure = await captureStableAria(target, '[data-changes-review]', host.workspaceCwd)
      await target.keyboard.press('Escape')
      const [openRetry] = await Promise.all([
        target.waitForResponse(response => new URL(response.url()).pathname === '/api/host.openPath'),
        native.click(),
      ])
      expect(await openRetry.json()).toMatchObject({ result: { ok: true } })
      await expect.poll(() => native.getAttribute('data-error')).toBeNull()
      expect(await review.textContent()).toContain('before the turn')
      open.mockImplementationOnce(async (request) => {
        await reviewRevealGate.promise
        return { rpcId: request.rpcId, result: { ok: false, error: { code: 'internal', message: 'Review reveal unavailable', details: {} } } }
      })
      await nativeMore.click()
      await menu.getByRole('menuitem', { name: 'Open containing folder', exact: true }).click()
      await expect.poll(() => native.isDisabled()).toBe(true)
      expect(await nativeMore.isDisabled()).toBe(true)
      reviewRevealGate.resolve()
      await expect.poll(() => native.getAttribute('data-error')).toBe('true')
      await nativeMore.focus()
      await target.keyboard.press('Shift+Tab')
      expect(await native.evaluate(element => element === document.activeElement)).toBe(true)
      await target.getByRole('tooltip').getByText('Could not open containing folder. Try again.', { exact: true }).waitFor()
      await auditWorkflowState(target, 'deliverables', 'review-native-reveal-failed', review, [native, nativeMore])
      await compareWorkflowGolden(join(DIRECTORY, 'review-native-errors.expected.md'),
        `${openFailure}\n${await captureStableAria(target, '[data-changes-review]', host.workspaceCwd)}`, webSnapshotMode())
      await target.keyboard.press('Escape')
      await nativeMore.click()
      const [revealRetry] = await Promise.all([
        target.waitForResponse(response => new URL(response.url()).pathname === '/api/host.openPath'),
        menu.getByRole('menuitem', { name: 'Open containing folder', exact: true }).click(),
      ])
      expect(await revealRetry.json()).toMatchObject({ result: { ok: true } })
      await expect.poll(() => native.getAttribute('data-error')).toBeNull()
      expect(open.mock.calls.slice(4).map(([request]) => request.payload)).toEqual([
        { path: join(host.workspaceCwd, 'review.txt'), action: 'open' },
        { path: join(host.workspaceCwd, 'review.txt'), action: 'open' },
        { path: join(host.workspaceCwd, 'review.txt'), action: 'reveal' },
        { path: join(host.workspaceCwd, 'review.txt'), action: 'reveal' },
      ])
      expect(await review.textContent()).toContain('after the turn')
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(target, 'workspace-review-native-actions'); throw error }
    finally {
      appsGate.resolve(); openGate.resolve(); revealGate.resolve(); reviewOpenGate.resolve(); reviewRevealGate.resolve()
      try { await target.close() } finally { open.mockRestore(); applications.mockRestore(); description.mockRestore() }
    }
  }, 180_000)

  it('owns only its review goldens', async () => {
    await assertFixtureInventory(DIRECTORY, ['review.expected.md', 'native-open-error.expected.md', 'multiple-files.expected.md',
      'storage-incomplete.expected.md', 'summary-unavailable.expected.md', 'review-native-errors.expected.md'])
  })

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
