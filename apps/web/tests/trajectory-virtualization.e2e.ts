// Browser contract for the tail-paged, virtualized Trajectory ledger. The
// scenario proves that semantic row identity survives an older-page prepend,
// DOM mounting stays bounded, and every scroll range remains reachable.
import { responsiveBrowser, responsiveBrowserName, responsiveMobileEmulation, responsiveViewports, expectViewportFit } from './responsive-browser.ts'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'

import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import {
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'
import { auditResponsiveControls } from './responsive-controls.ts'
import { captureTextContrast, expectTextContrast } from './text-contrast.ts'

const MODE = webSnapshotMode()
const LOAD_MORE_EXPECTED = fileURLToPath(new URL(
  './snapshots/trajectory-virtualization/load-more.expected.md',
  import.meta.url,
))
const SESSION_ID = 'trajectory-virtualization-e2e'
const FIXTURE = createChatScrollFixture({
  markerPrefix: 'TRAJECTORY_VIRTUAL',
  title: 'TRAJECTORY_VIRTUAL long ledger',
  // Alpha.4's larger conversation tail keeps an 88-turn fixture resident;
  // keep enough history to exercise the older-page path as well.
  turns: 240,
})
const MAX_MOUNTED_ROWS = 160
const GEOMETRY_TOLERANCE = 2
const STREAM_MARKER = 'TRAJECTORY_VIRTUAL_STREAM_FINISHED'
const STREAM_TEXT = Array.from(
  { length: 80 },
  (_, index) => `stream fragment ${String(index + 1).padStart(2, '0')} `,
).join('') + STREAM_MARKER

const STREAM_CHUNKS: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  ...Array.from({ length: 80 }, (_, index): StreamChunk => ({
    type: 'text-delta',
    index: 0,
    text: `stream fragment ${String(index + 1).padStart(2, '0')} `,
  })),
  { type: 'text-delta', index: 0, text: STREAM_MARKER },
  { type: 'block-end', index: 0, block: { type: 'text', text: STREAM_TEXT } },
  { type: 'usage', usage: { inputTokens: 2_700, outputTokens: 240 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

interface ScrollGeometry {
  readonly clientHeight: number
  readonly scrollHeight: number
  readonly scrollTop: number
}

interface RowAnchor {
  readonly key: string
  readonly top: number
}

// The compact shell keeps its navigation drawer open after session selection,
// so phone-width runs must dismiss it before the main tabs become clickable.
// Escape is the shell-level close; the toggle button label is the fallback.
async function closeCompactDrawer(page: Page): Promise<void> {
  const drawer = page.locator('[class*="drawer"][data-open="true"]')
  if ((await drawer.count()) === 0) return
  await page.keyboard.press('Escape')
  if ((await drawer.count()) > 0) {
    const toggle = page.getByRole('button', { name: /Close sidebar|关闭侧边栏/ })
    if ((await toggle.count()) > 0) await toggle.first().click()
  }
  await expect.poll(() => drawer.count(), { timeout: 10_000 }).toBe(0)
}

async function openSeed(page: Page, tailMarker: string | RegExp = FIXTURE.markers.assistant(FIXTURE.turns)): Promise<void> {
  const sidebarToggle = page.getByRole('button', { name: /Open sidebar|打开侧边栏/ })
  if (await sidebarToggle.count() > 0 && await sidebarToggle.getAttribute('aria-expanded') !== 'true') {
    await sidebarToggle.click()
  }
  // Search collapsed into a header action; expand it before filling.
  const searchButton = page.getByRole('button', { name: /Search sessions|搜索会话/ })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  const search = page.getByRole('textbox', { name: /Search sessions|搜索会话/ }).first()
  await search.fill(FIXTURE.markers.user(1))
  const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => result.count(), { timeout: 60_000 }).toBe(1)
  await result.click()
  await closeCompactDrawer(page)
  await page.getByRole('tab', { name: 'Trajectory', exact: true }).waitFor({ timeout: 30_000 })
  // Tail barrier: prove the conversation mounted its last page. The live
  // stream turn the first test appends displaces the seeded tail marker, so
  // callers on a smaller mounted window pass the streamed tail instead.
  await page.getByText(tailMarker, typeof tailMarker === 'string' ? { exact: false } : {})
    .last()
    .waitFor({ timeout: 30_000 })
}

async function openTrajectory(page: Page): Promise<void> {
  await closeCompactDrawer(page)
  await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
  const pane = page.locator('[data-trajectory-scroll]')
  await pane.waitFor({ timeout: 30_000 })
  await page.locator('[data-trajectory-scroll] [data-scroll-ready="true"]')
    .waitFor({ timeout: 30_000 })
}

async function logicalRows(page: Page): Promise<number> {
  const table = page.locator('[data-trajectory-scroll] table')
  const feed = page.locator('[data-trajectory-scroll] [data-trajectory-feed]')
  const raw = await (await table.count() > 0 ? table : feed.getByRole('listitem').first()).getAttribute(
    await table.count() > 0 ? 'aria-rowcount' : 'aria-setsize',
  )
  if (raw === null || !/^\d+$/.test(raw)) {
    throw new Error(`trajectory table has invalid aria-rowcount ${JSON.stringify(raw)}`)
  }
  return Number(raw)
}

async function mountedRows(page: Page): Promise<number> {
  return page.locator('[data-trajectory-scroll] [data-trajectory-row-key]').count()
}

async function geometry(page: Page): Promise<ScrollGeometry> {
  return page.locator('[data-trajectory-scroll]').evaluate(host => ({
    clientHeight: host.clientHeight,
    scrollHeight: host.scrollHeight,
    scrollTop: host.scrollTop,
  }))
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => { resolve() }))
  }))
}

async function scrollToRatio(page: Page, ratio: number): Promise<void> {
  await page.locator('[data-trajectory-scroll]').evaluate((host, value) => {
    const maximum = Math.max(0, host.scrollHeight - host.clientHeight)
    host.scrollTop = Math.round(maximum * value)
    host.dispatchEvent(new Event('scroll'))
  }, ratio)
  await nextPaint(page)
}

async function firstVisibleRow(page: Page): Promise<RowAnchor> {
  return page.locator('[data-trajectory-scroll]').evaluate((host) => {
    const hostBox = host.getBoundingClientRect()
    const rows = [...host.querySelectorAll<HTMLElement>('[data-trajectory-row-key]')]
    const row = rows.find((candidate) => {
      const box = candidate.getBoundingClientRect()
      return candidate.dataset.requestOnly !== 'true'
        && box.bottom > hostBox.top
        && box.top < hostBox.bottom
    })
    const key = row?.dataset.trajectoryRowKey
    if (row === undefined || key === undefined) {
      throw new Error('trajectory scrollport has no visible semantic row')
    }
    return { key, top: row.getBoundingClientRect().top - hostBox.top }
  })
}

async function rowTop(page: Page, key: string): Promise<number | null> {
  return page.locator('[data-trajectory-scroll]').evaluate((host, targetKey) => {
    const rows = [...host.querySelectorAll<HTMLElement>('[data-trajectory-row-key]')]
    const row = rows.find(candidate => candidate.dataset.trajectoryRowKey === targetKey)
    return row === undefined
      ? null
      : row.getBoundingClientRect().top - host.getBoundingClientRect().top
  }, key)
}

async function loadToFirstTurn(page: Page): Promise<void> {
  const marker = FIXTURE.markers.user(1)
  const loadMore = page.locator('[data-history-load] button')
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await page.getByText(marker, { exact: false }).count() > 0) return
    await expect.poll(() => loadMore.evaluateAll(buttons =>
      buttons.length === 0 || !(buttons[0] as HTMLButtonElement).disabled,
    ), { timeout: 15_000 }).toBe(true)
    const before = await logicalRows(page)
    await scrollToRatio(page, 0)
    if (await page.getByText(marker, { exact: false }).count() > 0) return
    const anchor = await firstVisibleRow(page)
    await expect.poll(async () => ({
      marker: await page.getByText(marker, { exact: false }).count() > 0,
      rows: await logicalRows(page),
    }), { timeout: 30_000 }).not.toEqual({ marker: false, rows: before })
    await nextPaint(page)
    await expect.poll(async () => {
      const top = await rowTop(page, anchor.key)
      return top === null ? Number.POSITIVE_INFINITY : Math.abs(top - anchor.top)
    }, { timeout: 15_000 }).toBeLessThanOrEqual(GEOMETRY_TOLERANCE)
  }
  throw new Error('trajectory did not reach the first turn after twelve older-page requests')
}

describe('web e2e: Trajectory virtualization over tail-paged history', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let replayDir: string

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-trajectory-virtualization-'))
    const replayFixture = join(replayDir, 'session.jsonl')
    const replayOverride = join(replayDir, 'replay.override.json')
    await writeFile(replayFixture, FIXTURE.log)
    await writeFile(replayOverride, JSON.stringify([{
      kind: 'chunks',
      chunks: STREAM_CHUNKS,
    } satisfies ReplayEntry]))
    scaffold = await launchWebScaffold({
      paceMs: 10,
      replayFixture,
      replayOverride,
    })
    await seedSession(scaffold, FIXTURE.log, SESSION_ID)
    browser = await responsiveBrowser.launch()
    page = await newEnglishPage(browser, 900)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // The compact layout dropped group session counts; the seeded baseline is
    // the Ungrouped bucket once cold summaries load.
    await page.getByText('Independent sessions', { exact: true }).waitFor({ timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(replayDir, { recursive: true, force: true })
  })

  it.skipIf(MODE === 'record')('retains identity on prepend and reaches the bounded virtual range', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-trajectory-virtualization'))
    await openSeed(page)

    await openTrajectory(page)
    const initialRows = await logicalRows(page)
    expect(initialRows).toBeGreaterThan(0)
    expect(await page.getByText('Initial System Prompt', { exact: true }).count()).toBe(0)
    expect(await mountedRows(page)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)

    const loadMore = page.locator('[data-history-load] button')
    await loadMore.waitFor({ timeout: 15_000 })
    await expect.poll(() => loadMore.textContent()).toBe('Load earlier history')
    const loadMoreSnapshot = await captureStableAria(
      page,
      '[data-history-load]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(LOAD_MORE_EXPECTED, loadMoreSnapshot, MODE)
    // Avoid Playwright scrolling the offscreen first row into the automatic-load threshold.
    await loadMore.evaluate((button: HTMLButtonElement) => { button.click() })
    await expect.poll(() => logicalRows(page), { timeout: 15_000 }).toBeGreaterThan(initialRows)
    const residentRows = await logicalRows(page)

    await scrollToRatio(page, 0)
    const anchor = await firstVisibleRow(page)
    const selectedRow = page.locator(
      `[data-trajectory-scroll] tr[data-trajectory-row-key=${JSON.stringify(anchor.key)}]`,
    )
    await selectedRow.click()
    await expect.poll(() => selectedRow.getAttribute('aria-selected'), { timeout: 10_000 })
      .toBe('true')

    await nextPaint(page)
    await expect.poll(async () => {
      const top = await rowTop(page, anchor.key)
      return top === null ? Number.POSITIVE_INFINITY : Math.abs(top - anchor.top)
    }, { timeout: 15_000 }).toBeLessThanOrEqual(GEOMETRY_TOLERANCE)
    await expect.poll(() => selectedRow.getAttribute('aria-selected'), { timeout: 10_000 })
      .toBe('true')
    expect(await mountedRows(page)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)

    await loadToFirstTurn(page)
    await expect.poll(
      () => page.getByText(FIXTURE.markers.user(1), { exact: false }).count(),
      { timeout: 10_000 },
    ).toBeGreaterThan(0)
    const fullRows = await logicalRows(page)

    await scrollToRatio(page, 0.5)
    const middle = await geometry(page)
    const maximum = middle.scrollHeight - middle.clientHeight
    expect(middle.scrollTop).toBeGreaterThan(maximum * 0.25)
    expect(middle.scrollTop).toBeLessThan(maximum * 0.75)
    expect(await mountedRows(page)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)
    expect(await mountedRows(page)).toBeLessThan(fullRows)

    await scrollToRatio(page, 1)
    await expect.poll(async () => {
      const value = await geometry(page)
      return value.scrollHeight - value.clientHeight - value.scrollTop
    }, { timeout: 10_000 }).toBeLessThanOrEqual(GEOMETRY_TOLERANCE)
    await expect.poll(
      () => page.getByText(FIXTURE.markers.assistant(FIXTURE.turns), { exact: false }).count(),
      { timeout: 10_000 },
    ).toBeGreaterThan(0)
    expect(await mountedRows(page)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)

    const trajectoryScroll = page.locator('[data-trajectory-scroll]')
    await trajectoryScroll.evaluate((host) => {
      const measuredWindow = window as Window & { __trajectoryScrollCalls?: number }
      measuredWindow.__trajectoryScrollCalls = 0
      const original = host.scrollTo.bind(host)
      const trackedScrollTo = (...args: [ScrollToOptions?] | [number, number]) => {
        measuredWindow.__trajectoryScrollCalls = (measuredWindow.__trajectoryScrollCalls ?? 0) + 1
        Reflect.apply(original, host, args)
      }
      host.scrollTo = trackedScrollTo as typeof host.scrollTo
    })
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('textarea').first()
    await input.fill('Stream one deterministic response while Trajectory remains visible.')
    await input.press('Enter')
    await settled
    await page.getByText('stream fragment 01', { exact: false }).waitFor({ timeout: 30_000 })
    await nextPaint(page)
    const streamingScrollCalls = await trajectoryScroll.evaluate(() => {
      return (window as Window & { __trajectoryScrollCalls?: number })
        .__trajectoryScrollCalls ?? 0
    })
    // Bottom-follow re-anchors per committed row-structure change, never per
    // chunk: a per-chunk follow would cost ~80 calls for this stream, while a
    // correct cadence stays in single digits for the whole turn.
    expect(streamingScrollCalls).toBeLessThanOrEqual(10)
    expect(await mountedRows(page)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)
    expect({
      pageErrors: tripwire.pageErrors,
      warnings: tripwire.warnings,
    }).toEqual({ pageErrors: [], warnings: [] })
    expect(await logicalRows(page)).toBeGreaterThanOrEqual(residentRows)
  }, 180_000)

  it.skipIf(MODE === 'record').each(responsiveViewports)('$name keeps the ledger and selected record reachable', async ({ name, width, height }) => {
    const mobilePage = await browser.newPage({
      viewport: { width, height },
      locale: 'en-US',
      hasTouch: true,
      isMobile: responsiveMobileEmulation && width < 768, reducedMotion: 'reduce',
    })
    try {
      await mobilePage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await mobilePage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      // The desktop test leaves a streamed turn appended to the seed, so the
      // phone window mounts the stream tail rather than the seeded marker.
      await openSeed(mobilePage, new RegExp(
        `${FIXTURE.markers.assistant(FIXTURE.turns)}|${STREAM_MARKER}`,
      ))
      await openTrajectory(mobilePage)
      const phone = width < 768
      const scroll = async (port: Locator, top: number) => {
        if (phone && responsiveBrowserName === 'webkit') {
          await port.evaluate((node, delta) => { node.scrollBy({ top: delta, behavior: 'instant' }) }, top)
        } else {
          await port.hover()
          await mobilePage.mouse.wheel(0, top)
        }
      }
      const pane = mobilePage.locator('[data-trajectory-scroll]')
      await expectViewportFit(mobilePage, pane)
      await expect.poll(() => mobilePage.locator('[data-trajectory-feed]').count()).toBe(phone ? 1 : 0)
      expect(await mountedRows(mobilePage)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)
      const record = mobilePage.locator('[data-trajectory-scroll] [data-record-index]').first()
      const first = phone ? record.getByRole('button').last() : record
      await first.click()
      const details = mobilePage.locator('[data-trajectory-details]')
      await expect.poll(() => details.getAttribute('role')).toBe(phone ? 'dialog' : 'complementary')
      if (phone) {
        const close = details.getByRole('button', { name: 'Close details' })
        await expect.poll(() => close.evaluate(node => node === document.activeElement)).toBe(true)
        await close.press('Shift+Tab')
        expect(await details.evaluate(node => node.contains(document.activeElement))).toBe(true)
        expect(await pane.evaluate(node => node.hasAttribute('inert'))).toBe(true)
      }
      await expectViewportFit(mobilePage, details, [details.getByRole('button', { name: 'Close details' })])
      const closeBox = await details.getByRole('button', { name: 'Close details' }).boundingBox()
      expect(closeBox?.width).toBeGreaterThanOrEqual(44)
      expect(closeBox?.height).toBeGreaterThanOrEqual(44)
      const tabs = details.getByRole('tab')
      const labels = await tabs.allTextContents()
      for (const label of labels) {
        const tab = details.getByRole('tab', { name: label, exact: true })
        await tab.click()
        await expect.poll(() => tab.getAttribute('aria-selected')).toBe('true')
        await expectViewportFit(mobilePage, details, [tab])
        const tabBox = await tab.boundingBox()
        expect(tabBox?.width).toBeGreaterThanOrEqual(44)
        expect(tabBox?.height).toBeGreaterThanOrEqual(44)
        await auditResponsiveControls(mobilePage, details, `trajectory/inspector/${label}/${name}`)
      }
      if (height <= 320 && await details.evaluate(node => node.scrollHeight > node.clientHeight + 1)) {
        await scroll(details, 300)
        await expect.poll(() => details.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
        await expect.poll(() => details.evaluate((node) => {
          const body = node.querySelector('[role="tabpanel"]')
          if (body === null) return false
          const outer = node.getBoundingClientRect(), content = body.getBoundingClientRect()
          return Math.min(outer.bottom, content.bottom) - Math.max(outer.top, content.top)
            >= Math.min(80, content.height, outer.height)
        })).toBe(true)
      }
      const directory = process.env.DSH_MOBILE_SCREENSHOTS
      if (directory !== undefined) {
        await mkdir(directory, { recursive: true })
        await mobilePage.screenshot({ path: join(directory, `trajectory-${responsiveBrowserName}-${name}.png`), animations: 'disabled' })
      }
      await mobilePage.getByRole('button', { name: 'Close details' }).click()
      await expect.poll(() => mobilePage.locator('[data-trajectory-details]').count(), { timeout: 10_000 }).toBe(0)
      const adjust = mobilePage.getByRole('button', { name: 'Adjust timeline', exact: true })
      await adjust.focus()
      await adjust.press('Enter')
      const controls = mobilePage.getByRole('dialog', { name: 'Adjust timeline', exact: true })
      await controls.waitFor()
      const start = controls.getByRole('slider', { name: 'Range start', exact: true })
      const end = controls.getByRole('slider', { name: 'Range end', exact: true })
      await start.focus()
      await start.press('ArrowRight')
      expect(Number(await start.inputValue())).toBeGreaterThan(0)
      await end.focus()
      await end.press('ArrowLeft')
      expect(Number(await end.inputValue())).toBeLessThan(100)
      const domain = mobilePage.locator('[data-timeline-domain]')
      const domainWidth = () => domain.evaluate(node => Number.parseFloat((node as HTMLElement).style.getPropertyValue('--trajectory-domain-width')))
      const zoomIn = controls.getByRole('button', { name: 'Zoom in', exact: true })
      await zoomIn.focus()
      await zoomIn.press('Space')
      expect(await domainWidth()).toBeGreaterThan(100)
      await controls.getByRole('button', { name: 'Reset timeline', exact: true }).click()
      expect(await domainWidth()).toBe(100)
      expect(Number(await start.inputValue())).toBe(0)
      expect(Number(await end.inputValue())).toBe(100)
      await mobilePage.keyboard.press('Escape')
      await controls.waitFor({ state: 'hidden' })
      await expect.poll(() => adjust.evaluate(node => node === document.activeElement)).toBe(true)
      await adjust.tap()
      await controls.waitFor()
      await expectViewportFit(mobilePage, controls, [start, end])
      const startBox = await start.boundingBox()
      if (startBox === null) throw new Error('Timeline range control has no measurable target')
      await start.tap({ position: { x: startBox.width * 0.25, y: startBox.height / 2 } })
      expect(Number(await start.inputValue())).toBeGreaterThan(0)
      await expectViewportFit(mobilePage, controls, [start, end])
      await auditResponsiveControls(mobilePage, controls, `trajectory/timeline-controls/${name}`)
      const controlsDirectory = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS ?? directory
      if (controlsDirectory !== undefined) {
        await mkdir(controlsDirectory, { recursive: true })
        await mobilePage.screenshot({ path: join(controlsDirectory, `trajectory-${responsiveBrowserName}-${name}-timeline-controls.png`), animations: 'disabled' })
      }
      await controls.getByRole('button', { name: 'Close timeline controls', exact: true }).click()
      await controls.waitFor({ state: 'hidden' })
      await scrollToRatio(mobilePage, 0.04)
      const outsideCandidates = pane.locator('[data-timeline-focus="outside"][data-kind="user"][data-record-index]')
      const reachableOutsideIndex = () => outsideCandidates.evaluateAll((rows) => {
        const scrollport = rows[0]?.closest('[data-trajectory-scroll]')
        if (scrollport === undefined || scrollport === null) return null
        const bounds = scrollport.getBoundingClientRect()
        const composer = document.querySelector('[data-composer-card]')?.getBoundingClientRect()
        const top = Math.max(bounds.top, 0)
        const bottom = composer !== undefined && composer.top > top
          ? Math.min(bounds.bottom, composer.top, innerHeight)
          : Math.min(bounds.bottom, innerHeight)
        const center = (top + bottom) / 2
        let distance: number | undefined
        for (const row of rows) {
          const box = row.getBoundingClientRect()
          if (box.height === 0) continue
          if (box.top >= top - 0.5 && box.bottom <= bottom + 0.5) return row.getAttribute('data-record-index')
          const offset = box.top + box.height / 2 - center
          if (distance === undefined || Math.abs(offset) < Math.abs(distance)) distance = offset
        }
        if (distance !== undefined) scrollport.scrollBy({ top: distance, behavior: 'instant' })
        return null
      })
      let outsideIndex: string | null = null
      await expect.poll(async () => {
        outsideIndex = await reachableOutsideIndex()
        return outsideIndex
      }).not.toBeNull()
      const outside = pane.locator(`[data-record-index="${outsideIndex}"]`)
      const outsidePreview = outside.locator('[class*="contentText"]')
      const outsideText = phone ? outside.locator('[class*="kindLabel"]') : outsidePreview.locator(':scope > span')
      const rangeContrast = await captureTextContrast(mobilePage, [
        { label: 'outside-record-text', text: outsideText, ...(phone ? {} : { region: outsidePreview }) },
      ], `trajectory-range-outside-${name}`)
      const outsideAction = phone ? outside.getByRole('button').last() : outside
      await outsideAction.tap()
      await details.waitFor()
      await expect.poll(() => outside.getAttribute('data-selected')).toBe('true')
      await details.getByRole('button', { name: 'Close details' }).click()
      await details.waitFor({ state: 'hidden' })
      expectTextContrast(rangeContrast)
    } catch (error) {
      await saveFailureShot(mobilePage, `trajectory-${responsiveBrowserName}-${name}-failed`)
      throw error
    } finally {
      await mobilePage.close()
    }
  }, 120_000)
})
