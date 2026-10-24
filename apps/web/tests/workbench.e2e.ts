// Real Web composition and transport, with recorded LLM streams for keyless
// concurrency/approval coverage and measured pane layouts. Workspaces and Sessions are created through
// their production actions; the workbench receives no fixture-only UI state.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page, Locator } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { pdfResourceFixture } from '../../../packages/client/ui-workbench/tests/pdf-resource-fixture.ts'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  fixtureUserPrompts, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const APPROVAL = fileURLToPath(new URL('./snapshots/approval-composer/session.jsonl', import.meta.url))
const REPLY = fileURLToPath(new URL('./snapshots/live-interactions/session.jsonl', import.meta.url))
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const PROVIDERS = fileURLToPath(new URL('./snapshots/plan-narrow-viewport/session.jsonl', import.meta.url))
const SNAPSHOTS = fileURLToPath(new URL('./snapshots/workbench', import.meta.url))
const SELECTION_EXPECTED_DIR = fileURLToPath(new URL('./expected/workbench', import.meta.url))
const TRACK_EXPECTED_DIR = join(SELECTION_EXPECTED_DIR, 'track-fill')
const POINTER_EXPECTED_DIR = join(SELECTION_EXPECTED_DIR, 'tab-pointer')
const MODE = webSnapshotMode()
const TRACK_SCENARIOS = [
  { name: 'preview-equal', count: 2, width: 1567, mode: 'preview', unequal: false },
  { name: 'preview-unequal', count: 2, width: 1567, mode: 'preview', unequal: true },
  { name: 'phone-unequal', count: 2, width: 1567, mode: 'phone', unequal: true },
  { name: 'stacked-three', count: 3, width: 1920, mode: 'stacked', unequal: false },
  { name: 'stacked-four-unequal', count: 4, width: 2160, mode: 'stacked', unequal: true },
  { name: 'collapsed-neighbor-unequal', count: 2, width: 1567, mode: 'collapsed', unequal: true },
] as const

/** Submit through one explicit pane's existing composer. */
async function prompt(pane: Locator, text: string): Promise<void> {
  const input = pane.locator('textarea').first()
  await input.fill(text)
  await input.press('Enter')
}

/** Observe one private page's tab input without changing focus or event delivery. */
async function traceWorkbenchTabs(page: Page, scenario: string) {
  const trace = await page.evaluateHandle((name) => {
    const root = document.querySelector<HTMLElement>('[data-workbench]')
    if (root === null) throw new Error('Workbench trace has no mounted root')
    const describeElement = (target: EventTarget | null | undefined) => target instanceof Element ? {
      tag: target.tagName, role: target.getAttribute('role'), label: target.getAttribute('aria-label'),
      text: target.textContent?.slice(0, 120), pane: target.closest('[data-session-pane]')?.getAttribute('data-session-pane'),
    } : null
    const snapshot = () => {
      const toolbar = root.querySelector('[data-workbench-toolbar]')
      const tabs = [...(toolbar?.querySelectorAll('[role="tab"]') ?? [])]
      const strip = tabs[0]?.parentElement
      const bounds = strip?.getBoundingClientRect()
      return {
        focus: describeElement(document.activeElement),
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map(dialog => dialog.getAttribute('aria-label')),
        panes: [...root.querySelectorAll('[data-session-pane]')].map(pane => ({
          id: pane.getAttribute('data-session-pane'), active: pane.hasAttribute('data-active'),
        })),
        tabs: tabs.map(tab => ({ selected: tab.getAttribute('aria-selected'), text: tab.textContent })),
        strip: strip === undefined || strip === null || bounds === undefined ? null : {
          left: bounds.left, right: bounds.right, width: bounds.width,
          clientWidth: strip.clientWidth, scrollWidth: strip.scrollWidth, scrollLeft: strip.scrollLeft,
        },
      }
    }
    const rows: Record<string, unknown>[] = []
    let dropped = 0
    const record = (kind: string, event?: Event, changes?: Record<string, unknown>[]): void => {
      if (rows.length >= 256) { dropped += 1; return }
      rows.push({
        sequence: rows.length, time: performance.now(), kind, trusted: event?.isTrusted,
        target: describeElement(event?.target), phase: event?.eventPhase,
        relatedTarget: event instanceof FocusEvent ? describeElement(event.relatedTarget) : undefined,
        pointer: event instanceof MouseEvent ? {
          x: event.clientX, y: event.clientY, hit: describeElement(document.elementFromPoint(event.clientX, event.clientY)),
        } : undefined,
        state: snapshot(), changes,
      })
    }
    const capture = (event: Event): void => {
      if (event.target instanceof Element && event.target.closest('[data-workbench], [role="dialog"]') !== null) {
        record(`capture:${event.type}`, event)
      }
    }
    const bubble = (event: Event): void => {
      if (event.target instanceof Element && event.target.closest('[data-workbench], [role="dialog"]') !== null) {
        record(`bubble:${event.type}`, event)
      }
    }
    const events = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'focusin', 'focusout', 'scroll']
    for (const event of events) document.addEventListener(event, capture, true)
    document.addEventListener('click', bubble)
    document.addEventListener('focusin', bubble)
    let previous = JSON.stringify(snapshot())
    const observer = new MutationObserver((mutations) => {
      const next = JSON.stringify(snapshot())
      const changes: Record<string, unknown>[] = []
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.target instanceof Element) {
          changes.push({ type: 'attribute', target: describeElement(mutation.target),
            name: mutation.attributeName, before: mutation.oldValue,
            after: mutation.attributeName === null ? null : mutation.target.getAttribute(mutation.attributeName) })
        } else if (mutation.type === 'childList') {
          const paneIds = (nodes: NodeList) => [...nodes].flatMap(node => node instanceof Element
            ? [node, ...node.querySelectorAll('[data-session-pane]')]
              .filter(element => element.hasAttribute('data-session-pane')).map(element => element.getAttribute('data-session-pane'))
            : [])
          const added = paneIds(mutation.addedNodes)
          const removed = paneIds(mutation.removedNodes)
          if (added.length > 0 || removed.length > 0) changes.push({ type: 'panes', added, removed })
        }
      }
      if (changes.length > 32) dropped += changes.length - 32
      if (next !== previous || changes.length > 0) { previous = next; record('mutation', undefined, changes.slice(0, 32)) }
    })
    observer.observe(root, {
      subtree: true, childList: true, attributes: true, attributeOldValue: true,
      attributeFilter: ['aria-selected', 'data-active', 'data-session-pane', 'data-tabbed'],
    })
    record('trace-start')
    return {
      mark: (stage: string) => { record(stage) },
      stop: () => {
        observer.disconnect()
        for (const event of events) document.removeEventListener(event, capture, true)
        document.removeEventListener('click', bubble)
        document.removeEventListener('focusin', bubble)
        record('trace-stop')
        return { scenario: name, rows, dropped }
      },
    }
  }, scenario)
  return {
    mark: async (stage: string): Promise<void> => { await trace.evaluate((owned, value) => { owned.mark(value) }, stage) },
    stop: async (): Promise<void> => {
      try {
        const result = await trace.evaluate(owned => owned.stop())
        console.info('[workbench-tab-trace]', JSON.stringify(result))
        expect(result.dropped, 'Workbench pointer trace exceeded its owned event bound').toBe(0)
      } finally {
        await trace.dispose()
      }
    },
  }
}

describe('web: Cordis Workspace workbench', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let releaseStartupHistory: (() => void) | undefined
  afterEach(async () => {
    releaseStartupHistory?.()
    releaseStartupHistory = undefined
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    browser = undefined
    scaffold = undefined
    if (failures.length > 0) throw new AggregateError(failures, 'Workbench fixture teardown failed')
  })

  it.skipIf(MODE === 'record').each(TRACK_SCENARIOS)(
    'fills the visible workbench row without changing saved ratios: $name', async (scenario) => {
      scaffold = await launchWebScaffold({
        workbench: true, remoteAuthority: 'app.localhost', openInApp: false,
        replayFixture: PROVIDERS, replayProvidersOnly: true,
      })
      const runtime = scaffold
      const seed = await readFile(SEED, 'utf8')
      const names = Array.from({ length: scenario.count }, (_, index) => `track-pane-${String(index + 1)}`)
      for (const name of names) {
        const path = join(runtime.workspaceCwd, name)
        await mkdir(path)
        await mkdir(join(path, 'workspace'))
        await writeFile(join(path, 'preview.pdf'), pdfResourceFixture('vector'))
        const workspace = await runtime.ctx.workspaceRegistry.create(path)
        const session = await seedSession(runtime, seed, name, undefined, path)
        await workspace.attachSession(session)
        await runtime.ctx.agents.resume({
          resumeSessionId: session,
          setup: agentCtx => runtime.ctx.agentPresets.mount(agentCtx).then(() => undefined),
        })
      }
      browser = await chromium.launch()
      page = await browser.newPage({
        viewport: { width: scenario.width, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce',
      })
      const tripwire = watchConsole(page)
      onTestFailed(() => saveFailureShot(page, `workbench-track-${scenario.name}`))
      await page.goto(runtime.authenticatedUrl, { waitUntil: 'load' })
      await page.locator('[class*="titleRow"] [data-workbench-toolbar]').waitFor({ timeout: 30_000 })
      const toolbar = page.locator('[data-workbench-toolbar]')
      await toolbar.getByRole('button', { name: 'Select workbench', exact: true }).click()
      await page.getByRole('menuitem', { name: /My workbench/u }).click()
      for (const name of names) {
        await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).click()
        const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
        await picker.locator('button').filter({ hasText: name }).first().click()
        await picker.waitFor({ state: 'hidden' })
      }
      const root = page.locator('[data-workbench]')
      const panes = root.locator('[data-session-pane]')
      await expect.poll(() => panes.count()).toBe(scenario.count)
      await expect.poll(() => root.getAttribute('data-tabbed')).toBeNull()
      await expect.poll(() => root.locator('[data-workbench-row]').count()).toBe(1)
      await toolbar.getByRole('button', { name: 'Layout', exact: true }).click()
      await page.getByRole('menuitem', {
        name: scenario.unequal ? 'Wide first pane' : 'Equal widths', exact: true,
      }).click()
      const ids = await panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-pane')!))
      const draftFor = (index: number): string => `Track draft ${String(index + 1)} survives the layout change`
      for (const [index, id] of ids.entries()) {
        const input = root.locator(`[data-session-pane="${id}"] textarea`).first()
        await expect.poll(() => input.isEditable(), { timeout: 30_000 }).toBe(true)
        await input.fill(draftFor(index))
      }
      await panes.first().locator('textarea').first().click()
      await expect.poll(() => panes.first().getAttribute('data-active')).toBe('true')
      const savedRatios = await panes.locator('[role="separator"]').evaluateAll(
        nodes => nodes.map(node => node.getAttribute('aria-valuenow')),
      )
      expect(savedRatios).toHaveLength(scenario.count - 1)
      expect(savedRatios[0]).toBe(String(Math.round(100 * (scenario.unequal ? 2 : 1)
        / (scenario.count + (scenario.unequal ? 1 : 0)))))
      const edgeChecks: { stage: string; row: number; edge: string; delta: number }[] = []
      const observeRows = async (stage: string) => {
        const geometry = await root.evaluate((node) => {
          const box = (element: Element) => {
            const bounds = element.getBoundingClientRect()
            return { left: bounds.left, right: bounds.right, top: bounds.top, width: bounds.width, height: bounds.height }
          }
          const toolbarNode = node.querySelector<HTMLElement>('[data-workbench-toolbar]')
          const tabs = [...(toolbarNode?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])]
          const strip = tabs[0]?.parentElement
          return {
            viewportWidth: window.innerWidth,
            viewportClass: node.closest('[data-viewport]')?.getAttribute('data-viewport'),
            root: box(node), tabbed: node.hasAttribute('data-tabbed'),
            toolbar: toolbarNode === null ? null : {
              box: box(toolbarNode),
              children: [...toolbarNode.children].map(child => ({ box: box(child), text: child.textContent })),
              strip: strip === undefined || strip === null ? null : {
                box: box(strip), clientWidth: strip.clientWidth, scrollWidth: strip.scrollWidth, scrollLeft: strip.scrollLeft,
              },
              tabs: tabs.map((tab) => {
                const bounds = box(tab)
                const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
                return {
                  box: bounds, selected: tab.getAttribute('aria-selected'),
                  centerHit: hit === null ? null : { tag: hit.tagName, text: hit.textContent,
                    tabIndex: tabs.findIndex(candidate => candidate === hit.closest('[role="tab"]')) },
                }
              }),
            },
            rows: [...node.querySelectorAll<HTMLElement>('[data-workbench-row]')].map(row => ({
              box: box(row), inlineTracks: row.style.gridTemplateColumns,
              computedTracks: getComputedStyle(row).gridTemplateColumns,
              panes: [...row.querySelectorAll<HTMLElement>(':scope > [data-session-pane]')].map(pane => ({
                id: pane.getAttribute('data-session-pane'), collapsed: pane.hasAttribute('data-collapsed'), box: box(pane),
              })),
            })),
          }
        })
        console.info('[workbench-track-geometry]', JSON.stringify({ scenario: scenario.name, stage, savedRatios, geometry }))
        for (const [index, row] of geometry.rows.entries()) {
          expect(row.panes.length).toBeGreaterThan(0)
          edgeChecks.push(
            { stage, row: index, edge: 'left', delta: Math.abs(row.panes[0]!.box.left - row.box.left) },
            { stage, row: index, edge: 'right', delta: Math.abs(row.panes.at(-1)!.box.right - row.box.right) },
          )
          for (const [column, pane] of row.panes.entries()) {
            if (pane.collapsed) edgeChecks.push({
              stage, row: index, edge: 'collapsed width', delta: Math.abs(pane.box.width - 46),
            })
            const previous = row.panes[column - 1]
            if (previous !== undefined) edgeChecks.push({
              stage, row: index, edge: 'adjacent panes', delta: Math.abs(pane.box.left - previous.box.right),
            })
          }
        }
        return geometry
      }
      const desktopBefore = await observeRows('desktop-before')
      let preview: Locator | undefined
      if (scenario.mode === 'preview') {
        await toolbar.getByRole('button', { name: 'Workspace files', exact: true }).click()
        const files = page.getByRole('dialog', { name: 'Workspace files', exact: true })
        await files.getByRole('treeitem', { name: 'preview.pdf', exact: true }).click()
        await files.waitFor({ state: 'hidden' })
        preview = page.getByRole('region', { name: 'preview.pdf', exact: true })
        const canvas = preview.locator('canvas').first()
        await canvas.waitFor({ state: 'visible' })
        await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(0)
      } else if (scenario.mode === 'phone') {
        await page.setViewportSize({ width: 390, height: 844 })
      } else if (scenario.mode === 'stacked') {
        await page.setViewportSize({ width: 1280, height: 1000 })
      } else {
        await panes.last().getByRole('button', { name: 'Collapse pane', exact: true }).click()
        await expect.poll(() => panes.last().getAttribute('data-collapsed')).toBe('true')
      }
      const tabbed = scenario.mode === 'preview' || scenario.mode === 'phone'
      if (tabbed) {
        await expect.poll(() => root.getAttribute('data-tabbed')).toBe('true')
        await expect.poll(() => panes.count()).toBe(1)
        await expect.poll(() => toolbar.getByRole('tab').count()).toBe(scenario.count)
        expect(await root.evaluate(node => node.getBoundingClientRect().width)).toBeLessThan(728)
        expect(await panes.first().getAttribute('data-session-pane')).toBe(ids[0])
        await expect.poll(() => panes.first().locator('textarea').first().inputValue()).toBe(draftFor(0))
      } else {
        await expect.poll(() => root.getAttribute('data-tabbed')).toBeNull()
        await expect.poll(() => root.locator('[data-workbench-row]').count()).toBe(scenario.mode === 'stacked' ? 2 : 1)
        expect(await panes.count()).toBe(scenario.count)
      }
      const target = await observeRows('transition')
      if (scenario.mode === 'stacked') {
        expect(target.rows.map(row => row.panes.length)).toEqual(scenario.count === 3 ? [2, 1] : [2, 2])
      }
      const failures: unknown[] = []
      let transitionAria: string | undefined
      try {
        for (const check of edgeChecks) {
          expect(check.delta, `${scenario.name}: ${check.stage} row ${String(check.row)} ${check.edge}`)
            .toBeLessThanOrEqual(1)
        }
        transitionAria = await captureStableAria(page, '[data-workbench-toolbar]', runtime.workspaceCwd)
      } catch (error) {
        failures.push(error)
      } finally {
        try {
          if (preview !== undefined) {
            await preview.getByRole('button', { name: 'Close preview', exact: true }).click()
            await preview.waitFor({ state: 'hidden' })
          } else if (scenario.mode === 'collapsed') {
            await panes.last().getByRole('button', { name: 'Expand pane', exact: true }).click()
            await expect.poll(() => panes.last().getAttribute('data-collapsed')).toBeNull()
          } else {
            await page.setViewportSize({ width: scenario.width, height: 1000 })
          }
          await expect.poll(() => panes.count()).toBe(scenario.count)
          await expect.poll(() => root.getAttribute('data-tabbed')).toBeNull()
          await expect.poll(() => root.locator('[data-workbench-row]').count()).toBe(1)
          const restorationCheckStart = edgeChecks.length
          const desktopAfter = await observeRows('desktop-restored')
          for (const check of edgeChecks.slice(restorationCheckStart)) {
            expect(check.delta, `${scenario.name}: ${check.stage} row ${String(check.row)} ${check.edge}`)
              .toBeLessThanOrEqual(1)
          }
          expect(await panes.locator('[role="separator"]').evaluateAll(
            nodes => nodes.map(node => node.getAttribute('aria-valuenow')),
          )).toEqual(savedRatios)
          for (const [index, pane] of desktopAfter.rows[0]!.panes.entries()) {
            const original = desktopBefore.rows[0]!.panes[index]!
            expect(pane.id).toBe(original.id)
            expect(Math.abs(pane.box.left - original.box.left)).toBeLessThanOrEqual(1)
            expect(Math.abs(pane.box.width - original.box.width)).toBeLessThanOrEqual(1)
            expect(await root.locator(`[data-session-pane="${pane.id}"] textarea`).first().inputValue()).toBe(draftFor(index))
          }
          expect(tripwire.pageErrors).toEqual([])
          expect(tripwire.warnings).toEqual([])
          console.info('[workbench-track-restoration]', JSON.stringify({
            scenario: scenario.name, verifiedDrafts: scenario.count, savedRatios, restored: true,
          }))
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Workbench geometry and restoration failed')
      if (transitionAria === undefined) throw new Error('Workbench geometry did not produce an ARIA snapshot')
      if (MODE === 'refresh') await mkdir(TRACK_EXPECTED_DIR, { recursive: true })
      await compareOrRefreshGolden(join(TRACK_EXPECTED_DIR, `${scenario.name}.expected.md`), transitionAria, MODE)
    },
  )

  it.skipIf(MODE === 'record')('keeps the workbench track fixture inventory exact', async () => {
    await assertFixtureInventory(TRACK_EXPECTED_DIR, TRACK_SCENARIOS.map(scenario => `${scenario.name}.expected.md`))
  })

  it.skipIf(MODE === 'record').each(['preview-width', 'phone-width'] as const)(
    'switches workbench tabs through ordinary pointer input: %s', async (scenario) => {
      scaffold = await launchWebScaffold({
        workbench: true, remoteAuthority: 'app.localhost', openInApp: false,
        replayFixture: PROVIDERS, replayProvidersOnly: true,
      })
      const runtime = scaffold
      const seed = await readFile(SEED, 'utf8')
      const names = ['pointer-pane-1', 'pointer-pane-2']
      for (const name of names) {
        const path = join(runtime.workspaceCwd, name)
        await mkdir(path)
        await mkdir(join(path, 'workspace'))
        await writeFile(join(path, 'preview.pdf'), pdfResourceFixture('vector'))
        const workspace = await runtime.ctx.workspaceRegistry.create(path)
        const session = await seedSession(runtime, seed, name, undefined, path)
        await workspace.attachSession(session)
        await runtime.ctx.agents.resume({
          resumeSessionId: session,
          setup: agentCtx => runtime.ctx.agentPresets.mount(agentCtx).then(() => undefined),
        })
      }
      browser = await chromium.launch()
      page = await browser.newPage({ viewport: { width: 1567, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' })
      const tripwire = watchConsole(page)
      onTestFailed(() => saveFailureShot(page, `workbench-pointer-${scenario}`))
      await page.goto(runtime.authenticatedUrl, { waitUntil: 'load' })
      await page.locator('[class*="titleRow"] [data-workbench-toolbar]').waitFor({ timeout: 30_000 })
      const toolbar = page.locator('[data-workbench-toolbar]')
      await toolbar.getByRole('button', { name: 'Select workbench', exact: true }).click()
      await page.getByRole('menuitem', { name: /My workbench/u }).click()
      for (const name of names) {
        await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).click()
        const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
        await picker.locator('button').filter({ hasText: name }).first().click()
        await picker.waitFor({ state: 'hidden' })
      }
      const root = page.locator('[data-workbench]')
      const panes = root.locator('[data-session-pane]')
      await expect.poll(() => panes.count()).toBe(2)
      await toolbar.getByRole('button', { name: 'Layout', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Wide first pane', exact: true }).click()
      const ids = await panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-pane')!))
      const drafts = ['Pointer draft P survives the layout change', 'Pointer draft Q survives the layout change']
      for (const [index, id] of ids.entries()) {
        const input = root.locator(`[data-session-pane="${id}"] textarea`).first()
        await expect.poll(() => input.isEditable(), { timeout: 30_000 }).toBe(true)
        await input.fill(drafts[index]!)
      }
      await panes.first().locator('textarea').first().click()
      await expect.poll(() => panes.first().getAttribute('data-active')).toBe('true')
      const desktopBefore = await panes.evaluateAll(nodes => nodes.map(node => ({
        id: node.getAttribute('data-session-pane'), left: node.getBoundingClientRect().left, width: node.getBoundingClientRect().width,
      })))
      const savedRatios = await panes.locator('[role="separator"]').evaluateAll(
        nodes => nodes.map(node => node.getAttribute('aria-valuenow')),
      )
      expect(savedRatios).toEqual(['67'])
      const trace = await traceWorkbenchTabs(page, scenario)
      const failures: unknown[] = []
      let preview: Locator | undefined
      let interactionAria: string | undefined
      try {
        await trace.mark('before-transition')
        if (scenario === 'preview-width') {
          await toolbar.getByRole('button', { name: 'Workspace files', exact: true }).click()
          const files = page.getByRole('dialog', { name: 'Workspace files', exact: true })
          await files.getByRole('treeitem', { name: 'preview.pdf', exact: true }).click()
          await files.waitFor({ state: 'hidden' })
          await trace.mark('file-picker-closed')
          preview = page.getByRole('region', { name: 'preview.pdf', exact: true })
          const canvas = preview.locator('canvas').first()
          await canvas.waitFor({ state: 'visible' })
          await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(0)
        } else {
          await page.setViewportSize({ width: 390, height: 844 })
        }
        await expect.poll(() => root.getAttribute('data-tabbed')).toBe('true')
        await expect.poll(() => panes.count()).toBe(1)
        await expect.poll(() => toolbar.getByRole('tab').count()).toBe(2)
        const width = await root.evaluate(node => node.getBoundingClientRect().width)
        expect(width).toBeLessThan(728)
        if (scenario === 'preview-width') expect(width).toBeGreaterThan(500)
        else expect(width).toBe(390)
        await trace.mark('before-Q-pointer')
        await toolbar.getByRole('tab').last().click()
        await trace.mark('after-Q-pointer')
        await expect.poll(() => panes.first().getAttribute('data-session-pane')).toBe(ids[1])
        await expect.poll(() => panes.first().locator('textarea').first().inputValue()).toBe(drafts[1])
        expect(await toolbar.getByRole('tab').last().getAttribute('aria-selected')).toBe('true')
        await trace.mark('Q-pane-ready')
        await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).click()
        const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
        await picker.waitFor({ state: 'visible' })
        await page.keyboard.press('Escape')
        await picker.waitFor({ state: 'hidden' })
        await toolbar.getByRole('button', { name: 'Layout', exact: true }).click()
        await page.getByRole('menuitem', { name: 'Wide first pane', exact: true }).waitFor({ state: 'visible' })
        await page.keyboard.press('Escape')
        await page.getByRole('menu').waitFor({ state: 'hidden' })
        await toolbar.getByRole('button', { name: 'Workspace files', exact: true }).click()
        const files = page.getByRole('dialog', { name: 'Workspace files', exact: true })
        await files.waitFor({ state: 'visible' })
        await page.keyboard.press('Escape')
        await files.waitFor({ state: 'hidden' })
        await toolbar.getByRole('button', { name: 'Select workbench', exact: true }).click()
        await page.getByRole('menuitem', { name: 'My workbench · 2/4', exact: true }).waitFor({ state: 'visible' })
        await page.keyboard.press('Escape')
        await page.getByRole('menu').waitFor({ state: 'hidden' })
        expect(await panes.first().getAttribute('data-session-pane')).toBe(ids[1])
        expect(await panes.first().locator('textarea').first().inputValue()).toBe(drafts[1])
        interactionAria = await captureStableAria(page, '[data-workbench-toolbar]', runtime.workspaceCwd)
        await trace.mark('before-P-pointer')
        await toolbar.getByRole('tab').first().click()
        await trace.mark('after-P-pointer')
        await expect.poll(() => panes.first().getAttribute('data-session-pane')).toBe(ids[0])
        await expect.poll(() => panes.first().locator('textarea').first().inputValue()).toBe(drafts[0])
      } catch (error) {
        failures.push(error)
        try {
          await trace.mark('interaction-failed')
          await saveFailureShot(page, `workbench-pointer-before-restoration-${scenario}`)
        } catch (traceError) {
          failures.push(traceError)
        }
      } finally {
        try {
          await trace.mark('before-restoration')
          if (await page.locator('[role="dialog"], [role="menu"]').count() > 0) await page.keyboard.press('Escape')
          if (preview !== undefined && await preview.isVisible()) {
            await preview.getByRole('button', { name: 'Close preview', exact: true }).click()
            await preview.waitFor({ state: 'hidden' })
          }
          await page.setViewportSize({ width: 1567, height: 1000 })
          await expect.poll(() => panes.count()).toBe(2)
          await expect.poll(() => root.getAttribute('data-tabbed')).toBeNull()
          const desktopAfter = await panes.evaluateAll(nodes => nodes.map(node => ({
            id: node.getAttribute('data-session-pane'), left: node.getBoundingClientRect().left, width: node.getBoundingClientRect().width,
          })))
          expect(await panes.locator('[role="separator"]').evaluateAll(
            nodes => nodes.map(node => node.getAttribute('aria-valuenow')),
          )).toEqual(savedRatios)
          for (const [index, pane] of desktopAfter.entries()) {
            const original = desktopBefore[index]!
            expect(pane.id).toBe(original.id)
            expect(Math.abs(pane.left - original.left)).toBeLessThanOrEqual(1)
            expect(Math.abs(pane.width - original.width)).toBeLessThanOrEqual(1)
            expect(await root.locator(`[data-session-pane="${pane.id}"] textarea`).first().inputValue()).toBe(drafts[index])
          }
          expect(tripwire.pageErrors).toEqual([])
          expect(tripwire.warnings).toEqual([])
          await trace.mark('desktop-restored')
          console.info('[workbench-pointer-restoration]', JSON.stringify({ scenario, restored: true, verifiedDrafts: 2, savedRatios }))
        } catch (error) {
          failures.push(error)
        }
        try { await trace.stop() }
        catch (error) { failures.push(error) }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Workbench pointer interaction and restoration failed')
      if (interactionAria === undefined) throw new Error('Workbench pointer interaction did not produce an ARIA snapshot')
      if (MODE === 'refresh') await mkdir(POINTER_EXPECTED_DIR, { recursive: true })
      await compareOrRefreshGolden(join(POINTER_EXPECTED_DIR, `${scenario}.expected.md`), interactionAria, MODE)
    },
  )

  it.skipIf(MODE === 'record')('keeps the workbench pointer fixture inventory exact', async () => {
    await assertFixtureInventory(POINTER_EXPECTED_DIR, ['preview-width.expected.md', 'phone-width.expected.md'])
  })

  it.skipIf(MODE === 'record')('restores the selected named workbench after reloading identical pane layouts', async () => {
    scaffold = await launchWebScaffold({
      workbench: true, openInApp: false, replayFixture: PROVIDERS, replayProvidersOnly: true,
    })
    const runtime = scaffold
    const seed = await readFile(SEED, 'utf8')
    const names = ['selection-alpha', 'selection-beta']
    for (const name of names) {
      const path = join(scaffold.workspaceCwd, name)
      await mkdir(path)
      await mkdir(join(path, 'workspace'))
      const workspace = await scaffold.ctx.workspaceRegistry.create(path)
      const session = await seedSession(scaffold, seed, name, undefined, path)
      await workspace.attachSession(session)
      await scaffold.ctx.agents.resume({
        resumeSessionId: session,
        setup: agentCtx => runtime.ctx.agentPresets.mount(agentCtx).then(() => undefined),
      })
    }
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'workbench-selection-reload'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const toolbar = page.locator('[data-workbench-toolbar]')
    await page.locator('[class*="titleRow"] [data-workbench-toolbar]').waitFor({ timeout: 30_000 })
    const caption = toolbar.getByRole('button', { name: 'Select workbench', exact: true })
    await caption.click()
    await page.getByRole('menuitem', { name: 'New workbench', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'New workbench', exact: true })
    await create.getByRole('textbox', { name: 'Workbench name', exact: true }).fill('Selection A')
    await create.getByRole('button', { name: 'Confirm', exact: true }).click()
    await create.waitFor({ state: 'hidden' })
    for (const name of names) {
      await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).click()
      const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
      await picker.locator('button').filter({ hasText: name }).first().click()
      await picker.waitFor({ state: 'hidden' })
    }
    const panes = page.locator('[data-session-pane]')
    await expect.poll(() => panes.count()).toBe(2)
    await panes.first().locator('textarea').first().click()
    await expect.poll(() => panes.first().getAttribute('data-active')).toBe('true')
    const layout = await panes.evaluateAll(nodes => nodes.map(node => ({
      id: node.getAttribute('data-session-pane'), active: node.getAttribute('data-active'),
    })))
    const ratios = await page.locator('[data-session-pane] [role="separator"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-valuenow')))
    expect(ratios).toEqual(['50'])
    await caption.click()
    await page.getByRole('menuitem', { name: 'Duplicate workbench', exact: true }).click()
    const duplicate = page.getByRole('dialog', { name: 'Duplicate workbench', exact: true })
    await duplicate.getByRole('textbox', { name: 'Workbench name', exact: true }).fill('Selection B')
    await duplicate.getByRole('button', { name: 'Confirm', exact: true }).click()
    await duplicate.waitFor({ state: 'hidden' })
    expect((await caption.innerText()).trim()).toBe('Selection B')
    expect(await panes.evaluateAll(nodes => nodes.map(node => ({
      id: node.getAttribute('data-session-pane'), active: node.getAttribute('data-active'),
    })))).toEqual(layout)
    expect(await page.locator('[data-session-pane] [role="separator"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-valuenow')))).toEqual(ratios)
    await caption.click()
    await page.getByRole('menuitem', { name: 'Selection A · 2/4', exact: true }).click()
    await page.getByRole('menu').waitFor({ state: 'hidden' })
    expect((await caption.innerText()).trim()).toBe('Selection A')
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => panes.count(), { timeout: 30_000 }).toBe(2)
    await expect.poll(() => panes.evaluateAll(nodes => nodes.filter((node) => {
      const input = node.querySelector('textarea')
      return input !== null && !input.disabled && !input.readOnly
    }).length), { timeout: 30_000 }).toBe(2)
    expect((await caption.innerText()).trim()).toBe('Selection A')
    expect(await panes.evaluateAll(nodes => nodes.map(node => ({
      id: node.getAttribute('data-session-pane'), active: node.getAttribute('data-active'),
    })))).toEqual(layout)
    expect(await page.locator('[data-session-pane] [role="separator"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-valuenow')))).toEqual(ratios)
    expect(tripwire.pageErrors).toEqual([])
    if (MODE === 'refresh') await mkdir(SELECTION_EXPECTED_DIR, { recursive: true })
    await compareOrRefreshGolden(join(SELECTION_EXPECTED_DIR, 'selection-restored.expected.md'), await captureStableAria(page, '[data-workbench-toolbar]', scaffold.workspaceCwd), MODE)
  })

  it.skipIf(MODE === 'record')('keeps the originating conversation selected when its document preview narrows the workbench', async () => {
    scaffold = await launchWebScaffold({
      workbench: true, remoteAuthority: 'app.localhost', openInApp: false,
      replayFixture: PROVIDERS, replayProvidersOnly: true,
    })
    const runtime = scaffold
    const reply = 'DONE\n\n[Open Markdown](report.md)\n\n[Open PDF](preview.pdf)'
    const seed = (await readFile(SEED, 'utf8')).replace('"text":"DONE"', `"text":${JSON.stringify(reply)}`)
    const names = ['preview-origin-alpha', 'preview-origin-beta'] as const
    for (const name of names) {
      const path = join(runtime.workspaceCwd, name)
      await mkdir(path)
      await mkdir(join(path, 'workspace'))
      await writeFile(join(path, 'report.md'), `# ${name}\n\nDocument owned by ${name}.\n`)
      if (name === names[1]) await writeFile(join(path, 'preview.pdf'), pdfResourceFixture('vector'))
      const workspace = await runtime.ctx.workspaceRegistry.create(path)
      const session = await seedSession(runtime, seed, name, undefined, path)
      await workspace.attachSession(session)
      await runtime.ctx.agents.resume({
        resumeSessionId: session,
        setup: agentCtx => runtime.ctx.agentPresets.mount(agentCtx).then(() => undefined),
      })
    }
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1567, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' })
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'workbench-preview-origin'))
    await page.goto(runtime.authenticatedUrl, { waitUntil: 'load' })
    const toolbar = page.locator('[data-workbench-toolbar]')
    await toolbar.waitFor({ timeout: 30_000 })
    await toolbar.getByRole('button', { name: 'Select workbench', exact: true }).click()
    await page.getByRole('menuitem', { name: /My workbench/u }).click()
    for (const name of names) {
      await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).click()
      const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
      await picker.locator('button').filter({ hasText: name }).first().click()
      await picker.waitFor({ state: 'hidden' })
    }
    const root = page.locator('[data-workbench]')
    const panes = root.locator('[data-session-pane]')
    await expect.poll(() => panes.count()).toBe(2)
    const identities = await panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-pane')))
    const drafts = ['Alpha unsent draft', 'Beta unsent draft']
    await panes.first().locator('textarea').first().fill(drafts[0]!)
    await panes.last().locator('textarea').first().fill(drafts[1]!)
    const output: string[] = []
    for (const activation of ['without-focus-event', 'pointer', 'keyboard'] as const) {
      for (const format of ['Markdown', 'PDF'] as const) {
        await panes.first().locator('textarea').first().click()
        await expect.poll(() => panes.first().getAttribute('data-active')).toBe('true')
        const link = panes.last().getByRole('button', { name: `Open ${format}`, exact: true })
        if (activation === 'without-focus-event') await link.dispatchEvent('click')
        else if (activation === 'keyboard') { await link.focus(); await link.press('Enter') }
        else await link.click()
        await expect.poll(() => root.getAttribute('data-tabbed')).toBe('true')
        await expect.poll(() => panes.count()).toBe(1)
        await expect.poll(() => panes.getAttribute('data-session-pane')).toBe(identities[1])
        await expect.poll(() => panes.locator('textarea').first().inputValue()).toBe(drafts[1])
        const preview = page.getByRole('region', { name: format === 'Markdown' ? 'report.md' : 'preview.pdf', exact: true })
        if (format === 'Markdown') {
          await preview.getByRole('heading', { name: names[1], exact: true }).waitFor()
        } else {
          const canvas = preview.locator('canvas').first()
          await canvas.waitFor()
          await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(0)
        }
        output.push(`${activation} / ${format}\n${await captureStableAria(page, '[data-workbench-toolbar]', runtime.workspaceCwd)}`)
        await preview.getByRole('button', { name: 'Close preview', exact: true }).click()
        await preview.waitFor({ state: 'hidden' })
        await expect.poll(() => root.getAttribute('data-tabbed')).toBeNull()
        await expect.poll(() => panes.count()).toBe(2)
        expect(await panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-pane')))).toEqual(identities)
        expect(await panes.first().locator('textarea').first().inputValue()).toBe(drafts[0])
        expect(await panes.last().locator('textarea').first().inputValue()).toBe(drafts[1])
      }
    }
    expect(tripwire.pageErrors).toEqual([])
    if (MODE === 'refresh') await mkdir(SELECTION_EXPECTED_DIR, { recursive: true })
    await compareOrRefreshGolden(join(SELECTION_EXPECTED_DIR, 'preview-origin.expected.md'), output.join('\n\n'), MODE)
  })

  it.skipIf(MODE === 'record')('selects a stored document into its restored workbench pane across view changes', async () => {
    scaffold = await launchWebScaffold({
      workbench: true, openInApp: false, replayFixture: PROVIDERS, replayProvidersOnly: true,
    })
    const runtime = scaffold
    const seed = await readFile(SEED, 'utf8')
    const names = ['picker-alpha', 'picker-beta']
    for (const name of names) {
      const path = join(runtime.workspaceCwd, name)
      await mkdir(path)
      await mkdir(join(path, 'workspace'))
      const workspace = await runtime.ctx.workspaceRegistry.create(path)
      const session = await seedSession(runtime, seed, name, undefined, path)
      await workspace.attachSession(session)
      await runtime.ctx.agents.resume({
        resumeSessionId: session,
        setup: agentCtx => runtime.ctx.agentPresets.mount(agentCtx).then(() => undefined),
      })
    }
    const content = 'Workbench library selection fixture'.padEnd(47, '.') + '\n'
    const bytes = new TextEncoder().encode(content)
    expect(bytes).toHaveLength(48)
    const target = await runtime.ctx.userDocs.resolveTarget({ name: 'workbench-library.txt' })
    const stored = await runtime.ctx.userDocs.save(target, new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); controller.close() },
    }))
    expect(stored.bytes).toBe(48)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'workbench-document-picker'))
    await page.goto(runtime.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[class*="titleRow"] [data-workbench-toolbar]').waitFor({ timeout: 30_000 })
    const toolbar = page.locator('[data-workbench-toolbar]')
    const caption = toolbar.getByRole('button', { name: 'Select workbench', exact: true })
    await caption.click()
    await page.getByRole('menuitem', { name: 'New workbench', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'New workbench', exact: true })
    await create.getByRole('textbox', { name: 'Workbench name', exact: true }).fill('Picker A')
    await create.getByRole('button', { name: 'Confirm', exact: true }).click()
    await create.waitFor({ state: 'hidden' })
    for (const name of names) {
      await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).click()
      const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
      await picker.locator('button').filter({ hasText: name }).first().click()
      await picker.waitFor({ state: 'hidden' })
    }
    await page.reload({ waitUntil: 'load' })
    const panes = page.locator('[data-session-pane]')
    await expect.poll(() => panes.count(), { timeout: 30_000 }).toBe(2)
    await expect.poll(() => panes.evaluateAll(nodes => nodes.filter((node) => {
      const input = node.querySelector('textarea')
      return input !== null && !input.disabled && !input.readOnly
    }).length), { timeout: 30_000 }).toBe(2)
    const [pKey, qKey] = await panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-pane')!))
    const p = page.locator(`[data-session-pane="${pKey}"]`)
    const q = page.locator(`[data-session-pane="${qKey}"]`)
    expect((await caption.innerText()).trim()).toBe('Picker A')
    expect(await page.getByRole('button', { name: 'Documents', exact: true }).count()).toBe(0)
    await q.locator('textarea').click()
    await p.getByRole('button', { name: 'Choose from Documents', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'Document Manager', exact: true })
    await manager.waitFor({ state: 'visible', timeout: 10_000 })
    await manager.getByText(stored.name, { exact: true }).waitFor()
    const output = [await manager.getByRole('heading', { name: 'Document Manager', exact: true }).ariaSnapshot()]
    await manager.getByRole('button', { name: `Preview ${stored.name}`, exact: true }).click()
    const preview = page.getByRole('dialog', { name: `Preview: ${stored.name}`, exact: true })
    await expect.poll(() => preview.locator('pre').textContent()).toBe(content)
    output.push(await captureStableAria(page, '[role="dialog"]:has(pre)', runtime.workspaceCwd))
    await preview.getByRole('button', { name: 'Close', exact: true }).click()
    await preview.waitFor({ state: 'hidden' })
    await manager.getByRole('button', { name: `Add ${stored.name} to conversation`, exact: true }).click()
    await manager.waitFor({ state: 'hidden' })
    const remove = p.getByRole('button', { name: `Remove document ${stored.name}`, exact: true })
    await remove.waitFor()
    await p.locator('[data-document-status="ready"]').waitFor()
    expect(await q.getByRole('button', { name: `Remove document ${stored.name}`, exact: true }).count()).toBe(0)
    output.push(await captureStableAria(
      page, `[data-session-pane="${pKey}"] [data-document-status="ready"]`, runtime.workspaceCwd,
    ))
    await q.locator('textarea').click()
    expect(await q.getByRole('button', { name: `Remove document ${stored.name}`, exact: true }).count()).toBe(0)
    await p.locator('textarea').click()
    await remove.click()
    await remove.waitFor({ state: 'hidden' })
    await expect.poll(() => p.getByRole('button', { name: 'Send message', exact: true }).isDisabled()).toBe(true)
    expect(new TextDecoder().decode((await runtime.ctx.userDocs.read(stored.docId)).data)).toBe(content)

    await caption.click()
    await page.getByRole('menuitem', { name: 'Exit workbench', exact: true }).click()
    await expect.poll(() => panes.count()).toBe(0)
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    await manager.getByText(stored.name, { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await manager.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Choose from Documents', exact: true }).click()
    await manager.getByText(stored.name, { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await manager.waitFor({ state: 'hidden' })
    await caption.click()
    await page.getByRole('menuitem', { name: 'Picker A · 2/4', exact: true }).click()
    await page.getByRole('menu').waitFor({ state: 'hidden' })
    await expect.poll(() => p.locator('textarea').isEditable()).toBe(true)
    await p.getByRole('button', { name: 'Choose from Documents', exact: true }).click()
    await manager.getByText(stored.name, { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await manager.waitFor({ state: 'hidden' })
    expect(tripwire.pageErrors).toEqual([])
    if (MODE === 'refresh') await mkdir(SELECTION_EXPECTED_DIR, { recursive: true })
    await compareOrRefreshGolden(join(SELECTION_EXPECTED_DIR, 'document-picker.expected.md'), output.join('\n\n'), MODE)
  })

  it.skipIf(MODE === 'record')('isolates four panes, concurrent streams, approval, draft recovery, and background completion', async () => {
    scaffold = await launchWebScaffold({
      workbench: true,
      openInApp: false,
      replayFixture: APPROVAL,
      replayChildFixtures: [REPLY, REPLY],
      paceMs: 15,
    })
    const runtime = scaffold
    const events = new Map<string, SessionEvent[]>()
    const assistantFrames = new Map<string, number>()
    scaffold.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const log = events.get(session.id) ?? []
      log.push(event)
      events.set(session.id, log)
    })
    scaffold.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (frame.type !== 'chunk') return
      assistantFrames.set(agent.session.id, (assistantFrames.get(agent.session.id) ?? 0) + 1)
    })
    // Seed one content-bearing Session per Workspace through the production
    // persistence and Workspace registry paths; the chooser's history list
    // hides blank Sessions, and attachSession validates the header cwd against
    // the workspace path. The browser exercises chooser selection and pane
    // binding; no Session internals are injected.
    const seed = await readFile(SEED, 'utf8')
    const workspaceIds: string[] = []
    const hostIds: string[] = []
    for (const name of ['alpha', 'beta', 'gamma', 'delta-with-a-long-workspace-name']) {
      const path = join(scaffold.workspaceCwd, name)
      await mkdir(path)
      await mkdir(join(path, 'workspace'))
      const workspace = await scaffold.ctx.workspaceRegistry.create(path)
      const session = await seedSession(scaffold, seed, `workbench-${name}`, undefined, path)
      hostIds.push(session)
      await workspace.attachSession(session)
      await scaffold.ctx.agents.resume({
        resumeSessionId: session,
        setup: agentCtx => runtime.ctx.agentPresets.mount(agentCtx).then(() => undefined),
      })
      workspaceIds.push(workspace.id)
    }
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, locale: 'en-US' })
    const sockets: string[] = []
    page.on('websocket', (socket) => { sockets.push(socket.url()) })
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'workbench'))
    const requestedHistory = Promise.withResolvers<undefined>()
    const releasedHistory = Promise.withResolvers<undefined>()
    releaseStartupHistory = () => { releasedHistory.resolve(undefined) }
    let held = false
    await page.route(/\/api\/session\.history(?:\?.*)?$/, async (route) => {
      if (!held) {
        held = true
        requestedHistory.resolve(undefined)
        await releasedHistory.promise
      }
      await route.continue()
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await requestedHistory.promise
    const toolbar = page.locator('[data-workbench-toolbar]')
    await toolbar.waitFor({ timeout: 30_000 })
    // History completion moves the same root controls from Hero to title row;
    // an already-open menu must survive without a second opening gesture.
    await toolbar.getByRole('button', { name: 'Select workbench' }).click()
    await page.getByRole('menuitem', { name: /My workbench/ }).waitFor()
    releasedHistory.resolve(undefined)
    await page.locator('[class*="titleRow"] [data-workbench-toolbar]').waitFor()
    expect(await toolbar.getByRole('button', { name: 'Select workbench' }).getAttribute('aria-expanded')).toBe('true')
    await page.getByRole('menuitem', { name: /My workbench/ }).click()
    await page.locator('[data-workbench-empty-content]').waitFor({ timeout: 30_000 })
    for (const workspaceId of workspaceIds) {
      await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).click()
      const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
      const name = ['alpha', 'beta', 'gamma', 'delta-with-a-long-workspace-name'][workspaceIds.indexOf(workspaceId)]!
      await picker.locator('button').filter({ hasText: name }).first().click()
      await picker.waitFor({ state: 'hidden' })
    }
    const panes = page.locator('[data-session-pane]')
    expect(await panes.count()).toBe(4)
    const ids = await panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-pane')!))
    const [a, b, c, d] = ids.map(id => page.locator(`[data-session-pane="${id}"]`)) as [Locator, Locator, Locator, Locator]
    await d.locator('textarea').first().fill('Delta draft survives pane changes')
    await a.locator('[aria-label^="Access mode"]').click()
    await page.getByRole('menuitem', { name: 'Read only', exact: true }).click()
    const approvalPrompt = fixtureUserPrompts(await readFile(APPROVAL, 'utf8'))[0]!
    const replyPrompt = fixtureUserPrompts(await readFile(REPLY, 'utf8'))[0]!
    await prompt(a, approvalPrompt)
    await expect.poll(() => (assistantFrames.get(hostIds[0]!) ?? 0) > 0, { timeout: 30_000 }).toBe(true)
    await prompt(b, replyPrompt)
    await expect.poll(() => (assistantFrames.get(hostIds[1]!) ?? 0) > 0, { timeout: 30_000 }).toBe(true)
    expect(await a.locator('[data-state="ongoing"]').count()).toBeGreaterThan(0)
    expect(await b.locator('[data-state="ongoing"]').count()).toBeGreaterThan(0)
    const approval = a.locator('[data-approval-key]')
    await approval.waitFor({ timeout: 60_000 })
    await prompt(c, replyPrompt)
    await expect.poll(() => (assistantFrames.get(hostIds[2]!) ?? 0) > 0, { timeout: 30_000 }).toBe(true)
    await c.getByRole('button', { name: 'Close pane', exact: true }).click()
    await expect.poll(() => events.get(hostIds[2]!)?.some(event => event.type === 'turn/end'), { timeout: 60_000 }).toBe(true)
    expect(await panes.count()).toBe(3)
    expect(await approval.count()).toBe(1)
    expect(await d.locator('textarea').first().inputValue()).toBe('Delta draft survives pane changes')
    await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
    await expect.poll(() => events.get(hostIds[0]!)?.some(event => event.type === 'turn/end'), { timeout: 60_000 }).toBe(true)
    expect(await approval.count()).toBe(0)
    expect(sockets.length).toBe(2)
    await compareOrRefreshGolden(join(SNAPSHOTS, 'toolbar.expected.md'), await captureStableAria(page, '[data-workbench-toolbar]', scaffold.workspaceCwd), MODE)
    await page.setViewportSize({ width: 600, height: 900 })
    await expect.poll(() => panes.count()).toBe(1)
    expect(await toolbar.getByRole('tab').count()).toBe(3)
    await toolbar.getByRole('tab').last().click()
    expect(await panes.locator('textarea').first().inputValue()).toBe('Delta draft survives pane changes')
    await compareOrRefreshGolden(join(SNAPSHOTS, 'tabs.expected.md'), await captureStableAria(page, '[data-workbench-toolbar]', scaffold.workspaceCwd), MODE)
    await page.reload({ waitUntil: 'load' })
    await page.locator('[data-session-pane]').waitFor({ timeout: 30_000 })
    await expect.poll(() => page.locator('[data-session-pane] textarea').first().inputValue()).toBe('Delta draft survives pane changes')
    await toolbar.getByRole('button', { name: 'Select workbench' }).click()
    await page.getByRole('menuitem', { name: 'Exit workbench', exact: true }).click()
    expect(await page.locator('[data-session-pane]').count()).toBe(0)
    expect(await page.locator('textarea').first().inputValue()).toBe('Delta draft survives pane changes')
    await toolbar.getByRole('button', { name: 'Select workbench' }).click()
    await page.getByRole('menuitem', { name: /My workbench/ }).click()
    expect(await toolbar.getByRole('tab').count()).toBe(3)
    expect(tripwire.pageErrors).toEqual([])
  }, 240_000)
})
