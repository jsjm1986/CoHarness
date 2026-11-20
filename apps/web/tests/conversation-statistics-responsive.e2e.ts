/** Logged context composition and per-turn accounting through the assembled Session renderer. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'
import { clientSessionKey } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import {
  launchWebScaffold, realizeSeedFixture, rewriteSeedEvents, seedSession, selectedSessionFixture,
  watchConsole, compareOrRefreshGolden, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { responsiveBrowser } from './responsive-browser.ts'
import { auditWorkflowState, newWorkflowPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'
import { auditResponsiveControl } from './responsive-controls.ts'
import { saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v7.jsonl', import.meta.url))
const ROUTE = 'provider-for-regional-enterprise-workspace-with-a-long-readable-name'
const MODEL = 'reasoning-model-with-a-large-context-window-and-long-revision-identifier'
const variants = ['rich', 'minimal', 'zero', 'composer'] as const

/** Require the whole draft to be visible before any acceptance helper scrolls it. */
async function expectDraftFullyVisible(input: Locator): Promise<void> {
  await expect.poll(() => input.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const viewport = visualViewport
    let top = viewport?.offsetTop ?? 0
    let bottom = top + (viewport?.height ?? innerHeight)
    let left = viewport?.offsetLeft ?? 0
    let right = left + (viewport?.width ?? innerWidth)
    for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      const box = parent.getBoundingClientRect()
      if (style.overflowY !== 'visible') { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom) }
      if (style.overflowX !== 'visible') { left = Math.max(left, box.left); right = Math.min(right, box.right) }
    }
    return { contained: rect.top >= top - 1 && rect.bottom <= bottom + 1
      && rect.left >= left - 1 && rect.right <= right + 1,
    hittable: [rect.left + 2, rect.left + rect.width / 2, rect.right - 2].every(x =>
      [rect.top + 2, rect.top + rect.height / 2, rect.bottom - 2].every(y => document.elementFromPoint(x, y) === node)) }
  })).toEqual({ contained: true, hittable: true })
}

/** Keep the recorded turn while varying provider-reported accounting at the durable event seam. */
function accountingSeed(raw: string, variant: typeof variants[number]): string {
  return rewriteSeedEvents(raw, (events) => {
    if (variant === 'zero') return [
      { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(1), time: 0, data: { turn: 1, step: 1 } },
      { type: 'request/context', seq: SessionSeq(2), time: 0, data: { provider: ROUTE, model: MODEL, contextWindow: 1_000_000 } },
      { type: 'assistant/attempt', seq: SessionSeq(3), time: 0, data: { turn: 1, step: 1,
        stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } } }] } },
      { type: 'step/end', seq: SessionSeq(4), time: 0, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: SessionSeq(5), time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    return events.map((event) => {
      if (event.type !== 'assistant/message') return event
      const usage = variant === 'rich'
        ? { inputTokens: 1_234_567, outputTokens: 234_567, cacheReadTokens: 3_456_789,
          cacheWriteTokens: 123_456, reasoningTokens: 123_456 }
        : { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
      return { ...event, data: { ...event.data, usage,
        message: { ...event.data.message,
          content: variant === 'composer' ? event.data.message.content.map(block => block.type !== 'text' ? block : {
            ...block, text: Array.from({ length: 24 }, (_, index) =>
              `History paragraph ${index + 1}: preserve access to earlier conversation while the input changes height.`)
              .join('\n\n') + `\n\n${block.text}`,
          }) : event.data.message.content,
          source: { kind: 'model' as const, provider: ROUTE, model: `${MODEL}-${event.data.step}` } },
        stream: variant === 'minimal' || variant === 'composer' ? [] : [...expandAssistantStream(event.data.stream)].map(member =>
          ({ type: 'chunk' as const, time: member.time,
            chunk: member.chunk.type === 'usage' ? { type: 'usage' as const, usage } : member.chunk })),
      } }
    })
  })
}

describe.skipIf(!workflowMatrixEnabled)('web e2e: context composition and per-turn statistics', () => {
  let browser: Browser
  beforeAll(async () => { browser = await responsiveBrowser.launch() })
  afterAll(async () => { await browser?.close() })

  async function open(variant: typeof variants[number]): Promise<{
    page: Page
    world: WebScaffold
    tripwire: ReturnType<typeof watchConsole>
  }> {
    const world = await launchWebScaffold()
    onTestFinished(() => world.close())
    const raw = await readFile(await selectedSessionFixture(SEED), 'utf8')
    const sessionId = SessionId(`statistics-${variant}`)
    const seed = accountingSeed(realizeSeedFixture(world, raw, sessionId), variant)
    const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
    const stored = await seedSession(world, seed, sessionId)
    await workspace.attachSession(stored)
    const resolved = await world.ctx.sessionController.resolveAgent(stored)
    if ('error' in resolved) throw new Error(resolved.error.message)
    const page = await newWorkflowPage(browser)
    const tripwire = watchConsole(page)
    try {
      await page.addInitScript((key) => { localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: key })) },
        clientSessionKey({ kind: 'personal' }, stored))
      await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
      await page.locator('textarea:enabled').first().waitFor()
      return { page, world, tripwire }
    } catch (error) { await page.close(); throw error }
  }

  async function inspectRows(page: Page, dialog: Locator, state: string): Promise<void> {
    await auditWorkflowState(page, 'conversation-statistics', state, dialog, [], undefined, async () => {
      for (const row of await dialog.locator('dt, dd').all()) {
        await auditResponsiveControl(page, row, `${state}/reading`)
      }
    })
  }

  it.each(['rich', 'minimal'] as const)('%s per-turn usage and timing remain readable and reopen from their actual actions', async (variant) => {
    const { page, tripwire } = await open(variant)
    try {
      await page.getByText('DONE', { exact: true }).waitFor()
      const tail = page.locator('[data-turn-tail="1"]')
      for (const kind of ['usage', 'time'] as const) {
        const trigger = tail.getByRole('button', { name: kind === 'usage' ? /^Usage / : /^Ran for / })
        await auditWorkflowState(page, 'conversation-statistics', `${variant}-${kind}-trigger`, trigger, [trigger])
        await trigger.click()
        const dialog = page.getByRole('dialog', { name: kind === 'usage' ? 'Turn usage' : 'Turn time and speed', exact: true })
        await dialog.waitFor()
        const text = await dialog.innerText()
        if (kind === 'usage') {
          expect(text).toContain(ROUTE)
          expect(text).toContain(`${MODEL}-1`)
          expect(text.includes('Cache write')).toBe(variant === 'rich')
          expect(/\breasoning\)/u.test(text)).toBe(variant === 'rich')
        } else {
          expect(text).toContain('Total run time')
          expect(text.includes('Time to first token')).toBe(variant === 'rich')
        }
        await inspectRows(page, dialog, `${variant}-${kind}-details`)
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden' })
        await trigger.focus()
        await page.keyboard.press('Enter')
        await dialog.waitFor()
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden' })
      }
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(page, `statistics-${variant}`); throw error }
    finally { await page.close() }
  }, 180_000)

  it('updates the live composition, hides an unavailable model capacity and restores the panel', async () => {
    const { page, world, tripwire } = await open('rich')
    try {
      await page.getByText('DONE', { exact: true }).waitFor()
      await expect.poll(() => world.ctx.agents.get(SessionId('statistics-rich'))).toBeDefined()
      const agent = world.ctx.agents.get(SessionId('statistics-rich'))
      if (agent === undefined) throw new Error('Statistics Session did not attach')
      const pressure = world.ctx.sessionProjections.snapshot(agent.session).values.contextPressure
      const used = pressure?.projectedTokens ?? pressure?.pressureTokens
      if (used === undefined || used <= 0) throw new Error('Recorded usage did not produce context pressure')
      agent.session.append('request/context', { provider: ROUTE, model: MODEL, contextWindow: Math.ceil(used / 0.95) })
      const trigger = page.getByRole('button', { name: '95% of context used', exact: true })
      await trigger.waitFor()
      await auditWorkflowState(page, 'context-meter', 'near-capacity-trigger', trigger, [trigger])
      await trigger.click()
      const dialog = page.getByRole('dialog', { name: 'of context used', exact: true })
      await dialog.waitFor()
      expect(await dialog.locator('dt').allTextContents()).toEqual(['System prompt', 'Tools', 'Messages'])
      await inspectRows(page, dialog, 'near-capacity-composition')
      agent.session.append('request/context', { provider: ROUTE, model: 'route-without-advertised-capacity' })
      await dialog.waitFor({ state: 'hidden' })
      await trigger.waitFor({ state: 'hidden' })
      const input = page.locator('textarea').first()
      await input.fill('Keep the draft while model capacity changes')
      await auditWorkflowState(page, 'context-meter', 'capacity-unavailable', page.locator('[data-composer-card]'), [input])
      agent.session.append('request/context', { provider: ROUTE, model: MODEL, contextWindow: Math.ceil(used / 0.5) })
      const restored = page.getByRole('button', { name: '50% of context used', exact: true })
      await restored.waitFor()
      expect(await restored.getAttribute('aria-expanded')).toBe('false')
      expect(await input.inputValue()).toBe('Keep the draft while model capacity changes')
      await restored.click()
      await dialog.waitFor()
      await inspectRows(page, dialog, 'capacity-restored-composition')
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(page, 'statistics-context'); throw error }
    finally { await page.close() }
  }, 180_000)

  it('flows an oversized composer with its transcript and restores the overlap reserve when it fits again', async () => {
    const { page, tripwire } = await open('composer')
    const summary: string[] = []
    try {
      await page.getByText('DONE', { exact: true }).waitFor()
      const input = page.locator('textarea').first()
      const draft = 'Preserve this draft through narrow layouts'
      await input.fill(draft)
      await input.blur()
      const scroller = page.locator('[data-conversation-scroll]').first()
      const seat = page.locator('[data-composer-seat]').first()
      const send = seat.getByRole('button', { name: 'Send message', exact: true })
      const screenshots = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
      if (screenshots !== undefined) await mkdir(screenshots, { recursive: true })
      const configurations = [
        { name: 'ordinary', width: 390, height: 844, mode: 'sticky' },
        { name: 'narrow-layout', width: 196, height: 355, mode: 'relative' },
        { name: 'short-landscape', width: 872, height: 230, mode: 'relative' },
        { name: 'restored', width: 390, height: 844, mode: 'sticky' },
      ] as const
      for (const layout of configurations) {
        await page.setViewportSize({ width: layout.width, height: layout.height })
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => {
          requestAnimationFrame(() => { resolve() })
        })))
        await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation =>
          (animation.playState === 'running' || animation.pending)
          && Number.isFinite(animation.effect?.getComputedTiming().endTime)).length)).toBe(0)
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(layout.width)
        await expect.poll(() => seat.evaluate(node => getComputedStyle(node).position)).toBe(layout.mode)
        const readGeometry = () => scroller.evaluate((node) => {
          const composer = node.querySelector<HTMLElement>('[data-composer-seat]')
          const flow = node.querySelector<HTMLElement>('[data-chat-flow]')?.parentElement ?? null
          if (composer === null || flow === null) throw new Error('Composer and transcript must share the scrollport')
          return { composer: composer.offsetHeight, viewport: node.clientHeight,
            padding: parseFloat(getComputedStyle(flow).paddingBottom),
            clearance: parseFloat(getComputedStyle(node).getPropertyValue('--dsh-composer-overlap-height')) }
        })
        await expect.poll(async () => {
          const next = await readGeometry()
          const overlap = layout.mode === 'relative' ? 0 : next.composer
          return { clearanceGap: next.clearance - overlap, paddingGap: next.padding - overlap - 16 }
        }).toEqual({ clearanceGap: 0, paddingGap: 0 })
        const geometry = await readGeometry()
        expect(await scroller.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(100)
        if (layout.name === 'narrow-layout') {
          expect(geometry.composer).toBeGreaterThanOrEqual(geometry.viewport)
          expect(await scroller.getAttribute('data-composer-flow')).toBe('')
        }
        if (layout.mode === 'relative') {
          expect(geometry.clearance).toBe(0)
          expect(geometry.padding).toBe(16)
        } else {
          expect(geometry.clearance).toBe(geometry.composer)
          expect(geometry.padding).toBe(geometry.composer + 16)
        }
        await expectDraftFullyVisible(input)
        if (screenshots !== undefined) {
          await page.screenshot({ path: join(screenshots, `composer-${layout.name}-initial.png`) })
        }
        await auditResponsiveControl(page, page.getByText('DONE', { exact: true }), `${layout.name}/last-message`)
        await auditResponsiveControl(page, input, `${layout.name}/draft`)
        await auditResponsiveControl(page, send, `${layout.name}/send`)
        expect(await input.inputValue()).toBe(draft)
        await scroller.evaluate((node) => { node.scrollTop = 0 })
        const bottom = page.getByRole('button', { name: 'Back to bottom', exact: true })
        await bottom.waitFor()
        await auditResponsiveControl(page, bottom, `${layout.name}/back-to-bottom`)
        await bottom.click()
        await expectDraftFullyVisible(input)
        await expect.poll(() => scroller.evaluate((node) => {
          const composer = node.querySelector<HTMLElement>('[data-composer-seat]')
          if (composer === null) throw new Error('Composer disappeared from its scrollport')
          const target = Math.max(0, node.scrollHeight - Math.max(node.clientHeight, composer.offsetHeight))
          return Math.abs(target - node.scrollTop)
        })).toBeLessThanOrEqual(2)
        if (screenshots !== undefined) {
          await page.screenshot({ path: join(screenshots, `composer-${layout.name}.png`) })
        }
        summary.push(`${layout.name}: ${layout.mode}; overlap reserve ${geometry.clearance === 0 ? 'none' : 'composer'}; draft initially visible and visible after Back to bottom; message and Send reachable; draft retained`)
      }
      const expected = fileURLToPath(new URL('./snapshots/conversation-statistics/composer-fit.expected.md', import.meta.url))
      await compareOrRefreshGolden(expected, summary.join('\n'), webSnapshotMode())
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(page, 'statistics-composer-fit'); throw error }
    finally { await page.close() }
  }, 120_000)

  it('reveals each focused workbench draft through nested scrolling when the visual viewport is 77px tall', async () => {
    const isolated = await launchWebScaffold({ workbench: true })
    const page = await newWorkflowPage(browser)
    const tripwire = watchConsole(page)
    const report: string[] = []
    try {
      const raw = await readFile(await selectedSessionFixture(SEED), 'utf8')
      const names = ['Focused first pane', 'Focused second pane']
      for (const [index, name] of names.entries()) {
        const directory = join(isolated.workspaceCwd, name)
        await mkdir(directory)
        const workspace = await isolated.ctx.workspaceRegistry.create(directory)
        const seed = accountingSeed(realizeSeedFixture(isolated, raw, `focused-pane-${index}`), 'composer')
        const session = await seedSession(isolated, seed, name, undefined, directory)
        await workspace.attachSession(session)
        await isolated.ctx.agents.resume({ resumeSessionId: session,
          setup: agentCtx => isolated.ctx.agentPresets.mount(agentCtx).then(() => undefined) })
      }
      await page.goto(isolated.authenticatedUrl, { waitUntil: 'load' })
      const toolbar = page.locator('[data-workbench-toolbar]')
      await toolbar.getByRole('button', { name: 'Select workbench', exact: true }).click()
      await page.getByRole('menuitem', { name: /My workbench/u }).click()
      for (const name of names) {
        await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).click()
        const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
        await picker.locator('button').filter({ hasText: name }).first().click()
        await picker.waitFor({ state: 'hidden' })
      }
      const panes = page.locator('[data-workbench] [data-session-pane]')
      await expect.poll(() => panes.count()).toBe(2)
      for (const pane of await panes.all()) await pane.getByText('DONE', { exact: true }).waitFor()
      const frame = page.locator('[data-viewport]').first()
      await page.setViewportSize({ width: 872, height: 286 })
      await expect.poll(() => frame.getAttribute('data-viewport')).toBe('medium')
      await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation =>
        (animation.playState === 'running' || animation.pending)
        && Number.isFinite(animation.effect?.getComputedTiming().endTime)).length)).toBe(0)
      const screenshots = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
      if (screenshots !== undefined) await mkdir(screenshots, { recursive: true })
      for (const [index, pane] of (await panes.all()).entries()) {
        const input = pane.locator('textarea:enabled').first()
        const back = pane.getByRole('button', { name: 'Back to bottom', exact: true })
        if (await back.isVisible()) await back.click()
        await input.fill(`Focused draft for pane ${index}`)
        expect(await back.count()).toBe(0)
        await expectDraftFullyVisible(input)
        await page.evaluate(() => {
          Object.defineProperty(visualViewport!, 'height', { configurable: true, value: 77 })
          visualViewport!.dispatchEvent(new Event('resize'))
        })
        await expect.poll(() => frame.evaluate(node => node.getBoundingClientRect().height)).toBe(77)
        await expectDraftFullyVisible(input)
        await input.fill(`Retained draft for pane ${index}`)
        await expectDraftFullyVisible(input)
        expect(await pane.locator('[data-conversation-scroll]').evaluate(node => node.clientHeight)).toBe(44)
        expect(await page.locator('[data-workbench]').evaluate(node => node.scrollTop)).toBeGreaterThan(0)
        if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, `workbench-focused-${index}-77px.png`) })
        await auditResponsiveControl(page, pane.getByRole('button', { name: 'Send message', exact: true }), `focused-${index}/send`)
        expect(await input.inputValue()).toBe(`Retained draft for pane ${index}`)
        await input.blur()
        await page.evaluate(() => {
          Reflect.deleteProperty(visualViewport!, 'height')
          visualViewport!.dispatchEvent(new Event('resize'))
        })
        await expect.poll(() => frame.evaluate(node => node.getBoundingClientRect().height)).toBe(286)
        await expectDraftFullyVisible(input)
        if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, `workbench-focused-${index}-restored.png`) })
        report.push(`Pane ${index}: focused draft fully visible without acceptance scrolling at 77px; Send separately reachable; draft retained and visible after restore.`)
      }
      await compareOrRefreshGolden(fileURLToPath(new URL('./snapshots/conversation-statistics/workbench-focused-draft.expected.md', import.meta.url)),
        report.join('\n'), webSnapshotMode())
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      console.info('[focused-draft-geometry]', JSON.stringify(await page.locator('textarea:focus').evaluateAll((nodes) => {
        const boxOf = (node: Element) => {
          const { x, y, width, height } = node.getBoundingClientRect()
          return { x, y, width, height }
        }
        return nodes.map(node => ({ input: boxOf(node),
          ancestors: Array.from((function* () { for (let el = node.parentElement; el !== null; el = el.parentElement) yield el })())
            .filter(el => el.getBoundingClientRect().height > 0)
            .map(el => ({ name: el.className, box: boxOf(el),
              overflow: getComputedStyle(el).overflow, top: el.scrollTop, height: el.clientHeight, total: el.scrollHeight })),
        }))
      })))
      await saveFailureShot(page, 'statistics-workbench-focused'); throw error
    }
    finally { try { await page.close() } finally { await isolated.close() } }
  }, 120_000)

  it('keeps an actual zero-usage attempt empty without painting filled composition segments', async () => {
    const { page, tripwire } = await open('zero')
    try {
      const trigger = page.getByRole('button', { name: '0% of context used', exact: true })
      await trigger.waitFor()
      await trigger.click()
      const dialog = page.getByRole('dialog', { name: 'of context used', exact: true })
      await dialog.waitFor()
      expect(await dialog.locator('dd').allTextContents()).toEqual(['~0', '~0', '~0'])
      expect(await dialog.locator('[class*="segment"]').count()).toBe(0)
      await inspectRows(page, dialog, 'zero-composition')
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(page, 'statistics-zero'); throw error }
    finally { await page.close() }
  }, 180_000)
})
