/**
 * Shell viewport-mode acceptance over the assembled application: the compact
 * topbar + drawer + scrim pair, the medium rail with no details track, the
 * expanded three-track grid, and a wide/compact round-trip — the assembled
 * narrow-viewport walkthrough the shell previously lacked. Keyless: every
 * scenario is pure shell behavior over a cold world, no model turns.
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { Browser, Page } from 'playwright'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-workspace'
import { chromium, devices, webkit } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'
import { auditResponsiveControls } from './responsive-controls.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/responsive-shell', import.meta.url))
const DRAWER_EXPECTED = join(SNAPSHOT_DIR, 'compact-drawer.expected.md')
const SIDEBAR_CONTROLS_EXPECTED = fileURLToPath(new URL('./expected/responsive-shell/compact-sidebar-controls.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const engine = process.env.DSH_RESPONSIVE_BROWSER ?? 'chromium'
if (engine !== 'chromium' && engine !== 'webkit') throw new Error('DSH_RESPONSIVE_BROWSER must be chromium or webkit')

const phoneViewports = [
  { width: 320, height: 568 }, { width: 344, height: 882 }, { width: 360, height: 640 }, { width: 375, height: 667 },
  { width: 390, height: 844 }, { width: 393, height: 852 }, { width: 412, height: 915 },
  { width: 430, height: 932 }, { width: 480, height: 800 }, { width: 540, height: 720 },
  { width: 600, height: 800 }, { width: 720, height: 960 }, { width: 820, height: 1180 },
  { width: 568, height: 320 }, { width: 667, height: 375 }, { width: 740, height: 360 },
  { width: 844, height: 390 }, { width: 932, height: 430 },
  { width: 767, height: 800 }, { width: 768, height: 800 }, { width: 769, height: 800 },
  { width: 1023, height: 768 }, { width: 1024, height: 768 },
] as const

describe('web e2e: responsive shell modes', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole> = { warnings: [], pageErrors: [] }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await (engine === 'webkit' ? webkit : chromium).launch()
  }, 120_000)

  afterEach(async () => {
    try {
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page?.close()
    }
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'responsive shell e2e cleanup failed')
  })

  async function openAt(width: number, height: number, source = scaffold): Promise<Page> {
    const opened = await browser.newPage({ viewport: { width, height }, locale: 'en-US' })
    tripwire = watchConsole(opened)
    await opened.goto(source.authenticatedUrl, { waitUntil: 'load' })
    await opened.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    return opened
  }

  it.each(phoneViewports)('touch layout $width × $height keeps navigation, settings and plugin pages reachable', async ({ width, height }) => {
    page = await browser.newPage({ viewport: { width, height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, locale: 'en-US' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, `web-e2e-mobile-${engine}-${width}-${height}`))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const frame = page.locator('[data-viewport]').first()
    await frame.waitFor()
    expect(await frame.getAttribute('data-viewport')).toBe(width < 768 ? 'compact' : width < 1024 ? 'medium' : 'expanded')
    const assertPageFits = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
      expect(await page.evaluate(() => innerWidth)).toBe(width)
    }
    await assertPageFits()
    if (width < 768) await page.getByRole('button', { name: 'Open sidebar', exact: true }).tap()
    await page.getByRole('button', { name: 'Settings', exact: true }).tap()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.waitFor()
    await settings.getByRole('button', { name: 'General', exact: true }).waitFor()
    await settings.evaluate(async (element) => { await Promise.all(element.getAnimations().map(animation => animation.finished)) })
    const box = await settings.boundingBox()
    if (!box) throw new Error('Settings dialog has no rendered box')
    expect(box.x).toBeGreaterThanOrEqual(-1)
    expect(box.y).toBeGreaterThanOrEqual(-1)
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1)
    expect(box.y + box.height).toBeLessThanOrEqual(height + 1)
    await assertPageFits()
    const screenshots = process.env.DSH_MOBILE_SCREENSHOTS
    if (screenshots && [320, 390, 844].includes(width)) {
      await mkdir(screenshots, { recursive: true })
      await page.screenshot({ path: join(screenshots, `settings-${engine}-${width}-${height}.png`) })
    }
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
    if (width < 768) {
      const open = page.getByRole('button', { name: 'Open sidebar', exact: true })
      if (await open.count()) await open.tap()
    }
    await page.getByRole('navigation', { name: 'Panels' }).getByRole('button', { name: 'Plugins', exact: true }).tap()
    if (width < 768) {
      await expect.poll(() => page.locator('[class*="drawer"][data-open]').count()).toBe(0)
    }
    await page.locator('[data-plugin-panel]').waitFor()
    await assertPageFits()
    if (screenshots && [320, 390, 844].includes(width)) {
      await page.screenshot({ path: join(screenshots, `plugins-${engine}-${width}-${height}.png`) })
    }
  })

  it('keeps the device profile usable through rotation, text spacing and theme changes', async () => {
    const profile = devices[engine === 'webkit' ? 'iPhone 13' : 'Pixel 7']
    page = await browser.newPage({ ...profile, locale: 'en-US' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, `web-e2e-mobile-profile-${engine}`))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).waitFor()
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false)
    const shell = page.locator('[data-viewport]').first()
    await page.addStyleTag({ content: '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important } p { margin-block-end: 2em !important }' })
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      for (const viewport of [profile.viewport, { width: profile.viewport.height, height: profile.viewport.width }, profile.viewport]) {
        await page.setViewportSize(viewport)
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(viewport.width)
        const mode = viewport.width < 768 ? 'compact' : viewport.width < 1024 ? 'medium' : viewport.width < 1440 ? 'expanded' : 'wide'
        await expect.poll(() => shell.getAttribute('data-viewport')).toBe(mode)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1)
        if (mode === 'compact') {
          const open = page.getByRole('button', { name: 'Open sidebar', exact: true })
          if (await open.count()) await open.tap()
        }
        await page.getByRole('button', { name: 'Settings', exact: true }).tap()
        const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
        await settings.waitFor()
        const close = settings.getByRole('button', { name: 'Close', exact: true })
        await close.tap()
        await settings.waitFor({ state: 'hidden' })
      }
    }
  })

  it('compact: single CSS-owned column under the shell topbar; the drawer opens and scrim-dismisses', async () => {
    page = await openAt(390, 844)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-responsive-compact'))
    const frame = page.locator('[class*="frame"]').first()
    expect(await frame.getAttribute('data-viewport')).toBe('compact')
    // CSS owns the compact template: no inline column tracks, no drag handles.
    expect(await frame.evaluate(node => (node as HTMLElement).style.gridTemplateColumns)).toBe('')
    expect(await page.locator('[class*="handle"]').count()).toBe(0)

    const coldGeometry = await page.evaluate(() => {
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const actionable = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
        .map((element) => {
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return {
            visible: rect.width > 0 && rect.height > 0
              && rect.right > 0 && rect.left < viewportWidth
              && rect.bottom > 0 && rect.top < viewportHeight
              && style.display !== 'none' && style.visibility !== 'hidden',
            inside: rect.left >= -1 && rect.right <= viewportWidth + 1
              && rect.top >= -1 && rect.bottom <= viewportHeight + 1,
          }
        })
        .filter(item => item.visible)
      return {
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        actionableInside: actionable.every(item => item.inside),
      }
    })
    expect(coldGeometry.documentWidth).toBeLessThanOrEqual(390)
    expect(coldGeometry.bodyWidth).toBeLessThanOrEqual(390)
    expect(coldGeometry.actionableInside).toBe(true)

    // Stable class anchor: the toggle's accessible name flips between
    // Open/Close sidebar with the drawer state.
    const toggle = page.locator('[class*="topbarToggle"]').first()
    await toggle.waitFor({ timeout: 10_000 })
    expect(await page.locator('[data-mobile-app-header]').textContent()).toBe('COHARNESS')
    expect(await toggle.getAttribute('aria-label')).toBe('Open sidebar')
    const drawer = page.locator('[class*="drawer"]').first()
    expect(await drawer.getAttribute('data-open')).toBeNull()

    await toggle.click()
    await expect.poll(() => drawer.getAttribute('data-open'), { timeout: 5_000 }).toBe('true')
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    expect(await toggle.getAttribute('aria-label')).toBe('Close sidebar')
    // The drawer renders the full expanded sidebar (its New Session control is reachable).
    await drawer.getByRole('button', { name: /new session/i }).first().waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(page, '[class*="drawer"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DRAWER_EXPECTED, snapshot, MODE)

    // Tap the scrim strip right of the drawer (the drawer covers the left 320px).
    const scrim = page.locator('[class*="scrim"][data-open]').first()
    await scrim.click({ position: { x: 370, y: 420 } })
    await expect.poll(() => drawer.getAttribute('data-open'), { timeout: 5_000 }).toBeNull()
  }, 60_000)

  it('keeps both sidebar controls in the compact topbar through resizing without losing the draft', async () => {
    const isolated = await launchWebScaffold({})
    onTestFinished(() => isolated.close())
    page = await openAt(390, 844, isolated)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-compact-sidebar-controls'))
    await connectFreshWorkspace(page, isolated.workspaceCwd)
    const composer = page.locator('textarea:enabled[placeholder="Describe what you want to build"]')
    await composer.fill('Keep this draft while opening the sidebars')
    const right = page.locator('[data-sidebar-right-expand]:visible')
    const topbar = page.locator('[class*="topbar"]:has(> [data-mobile-app-header])')
    const viewports = [
      { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 360, height: 640 },
      { width: 480, height: 800 }, { width: 600, height: 800 }, { width: 720, height: 960 },
      { width: 767, height: 844 }, { width: 768, height: 844 }, { width: 900, height: 900 },
      { width: 1024, height: 844 }, { width: 1280, height: 900 },
      { width: 568, height: 320 }, { width: 740, height: 360 }, { width: 844, height: 390 },
      { width: 1280, height: 480 }, { width: 390, height: 844 },
    ]
    const measurements: Array<{ width: number; height: number; theme: string; mode: string; rightY: number; leftY?: number }> = []
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect.poll(() => page.locator('body').evaluate(body => body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
      for (const { width, height } of viewports) {
        await page.setViewportSize({ width, height })
        const mode = width < 768 ? 'compact' : width < 1024 ? 'medium' : 'expanded'
        await expect.poll(() => page.locator('[data-viewport]').first().getAttribute('data-viewport')).toBe(mode)
        await expect.poll(() => right.count()).toBe(1)
        expect(await page.evaluate(() => document.documentElement.scrollWidth), `${colorScheme} ${width}×${height}`).toBeLessThanOrEqual(width + 1)
        const rightBox = await right.boundingBox()
        if (!rightBox) throw new Error('Missing right sidebar toggle geometry')
        expect(rightBox.y).toBeGreaterThanOrEqual(0)
        expect(rightBox.y + rightBox.height).toBeLessThanOrEqual(height)
        if (width < 768) {
          await page.locator('[data-viewport] > [class*="drawer"]').waitFor({ state: 'hidden' })
          const left = page.getByRole('button', { name: 'Open sidebar', exact: true })
          expect(await left.count()).toBe(1)
          const leftBox = await left.boundingBox()
          if (!leftBox) throw new Error('Missing left sidebar toggle geometry')
          expect(Math.abs(leftBox.y - rightBox.y), `${colorScheme} ${width}×${height}: same row`).toBeLessThanOrEqual(1)
          expect(rightBox.x).toBeGreaterThan(leftBox.x + leftBox.width)
          for (const box of [leftBox, rightBox]) {
            expect(box.width).toBeGreaterThanOrEqual(44)
            expect(box.height).toBeGreaterThanOrEqual(44)
          }
          expect(await topbar.locator('[data-sidebar-right-expand]').count()).toBe(1)
          expect(await page.locator('[data-conversation-header-corner]:visible').count()).toBe(0)
          expect(await page.locator('[class*="headerBlank"]:visible').count()).toBe(0)
          measurements.push({ width, height, theme: colorScheme, mode, leftY: leftBox.y, rightY: rightBox.y })
        } else {
          expect(await topbar.count()).toBe(0)
          expect(await page.locator('[data-conversation-header-corner] [data-sidebar-right-expand]:visible').count()).toBe(1)
          measurements.push({ width, height, theme: colorScheme, mode, rightY: rightBox.y })
        }
        expect(await composer.inputValue()).toBe('Keep this draft while opening the sidebars')
        const screenshots = process.env.DSH_MOBILE_SCREENSHOTS
        if (screenshots) {
          await mkdir(screenshots, { recursive: true })
          await page.screenshot({ path: join(screenshots, `sidebar-controls-${engine}-${width}-${height}-${colorScheme}.png`) })
        }
      }
      await composer.hover()
      await topbar.getByRole('tooltip').waitFor({ state: 'hidden' })
      await compareOrRefreshGolden(SIDEBAR_CONTROLS_EXPECTED,
        await captureStableAria(page, '[class*="topbar"]:has(> [data-mobile-app-header])', isolated.workspaceCwd), MODE)
      await right.focus()
      await page.keyboard.press('Enter')
      const collapse = page.getByRole('button', { name: 'Collapse right sidebar', exact: true })
      await collapse.waitFor()
      await collapse.click()
      await right.waitFor()
      expect(await composer.inputValue()).toBe('Keep this draft while opening the sidebars')
    }
    if (process.env.DSH_MOBILE_SCREENSHOTS) {
      await writeFile(join(process.env.DSH_MOBILE_SCREENSHOTS, `sidebar-controls-${engine}.json`), JSON.stringify(measurements, null, 2) + '\n')
    }
  }, 90_000)

  it('keeps sidebar controls in one row according to the measured frame inside a wider browser', async () => {
    const isolated = await launchWebScaffold({})
    onTestFinished(() => isolated.close())
    page = await openAt(1280, 900, isolated)
    onTestFailed(() => saveFailureShot(page, `web-e2e-contained-sidebar-controls-${engine}`))
    await connectFreshWorkspace(page, isolated.workspaceCwd)
    const composer = page.locator('textarea:enabled[placeholder="Describe what you want to build"]')
    await composer.fill('Keep the contained frame draft')
    const constraint = await page.addStyleTag({ content: '[data-viewport] { max-width: 600px; }' })
    const frame = page.locator('[data-viewport]').first()
    const right = page.locator('[data-sidebar-right-expand]:visible')
    await expect.poll(() => frame.getAttribute('data-viewport')).toBe('compact')
    await page.locator('[data-viewport] > [class*="drawer"]').waitFor({ state: 'hidden' })
    // Restore the previous wide-window defaults only inside this fixture to
    // demonstrate that a compact frame can expose both navigation entries.
    const previousMediaRules = await page.addStyleTag({ content: `
      @media (min-width: 768px) {
        [data-viewport='compact'] [data-conversation-header-corner],
        [data-viewport='compact'] [class*='headerBlank'] { display: flex !important; }
      }
    ` })
    try {
      await expect.poll(() => right.count()).toBe(2)
      if (process.env.DSH_MOBILE_SCREENSHOTS) {
        await mkdir(process.env.DSH_MOBILE_SCREENSHOTS, { recursive: true })
        await page.screenshot({ path: join(process.env.DSH_MOBILE_SCREENSHOTS, `contained-sidebar-${engine}-600-previous-media.png`) })
      }
    } finally {
      await previousMediaRules.evaluate(style => style.parentNode?.removeChild(style))
    }
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      for (const width of [600, 767.5, 768, 1280]) {
        await constraint.evaluate((style, size) => { style.textContent = `[data-viewport] { max-width: ${size}px; }` }, width)
        const mode = width < 768 ? 'compact' : width < 1024 ? 'medium' : 'expanded'
        await expect.poll(() => frame.getAttribute('data-viewport')).toBe(mode)
        expect(await page.evaluate(() => innerWidth)).toBe(1280)
        expect((await frame.boundingBox())?.width).toBe(width)
        await expect.poll(() => right.count()).toBe(1)
        if (width < 768) {
          await page.locator('[data-viewport] > [class*="drawer"]').waitFor({ state: 'hidden' })
          const leftBox = await page.getByRole('button', { name: 'Open sidebar', exact: true }).boundingBox()
          const rightBox = await right.boundingBox()
          if (!leftBox || !rightBox) throw new Error('Missing contained frame sidebar geometry')
          expect(Math.abs(leftBox.y - rightBox.y)).toBeLessThanOrEqual(1)
          expect(rightBox.width).toBeGreaterThanOrEqual(44)
          expect(rightBox.height).toBeGreaterThanOrEqual(44)
          expect(await page.locator('[data-mobile-session-actions] [data-sidebar-right-expand]:visible').count()).toBe(1)
          expect(await page.locator('[data-conversation-header-corner]:visible').count()).toBe(0)
          expect(await page.locator('[class*="headerBlank"]:visible').count()).toBe(0)
        } else {
          expect(await page.locator('[data-mobile-session-actions]').count()).toBe(0)
          expect(await page.locator('[data-conversation-header-corner] [data-sidebar-right-expand]:visible').count()).toBe(1)
        }
        expect(await composer.inputValue()).toBe('Keep the contained frame draft')
        if (process.env.DSH_MOBILE_SCREENSHOTS) {
          await mkdir(process.env.DSH_MOBILE_SCREENSHOTS, { recursive: true })
          await page.screenshot({ path: join(process.env.DSH_MOBILE_SCREENSHOTS, `contained-sidebar-${engine}-${width}-${colorScheme}.png`) })
        }
      }
    }
  }, 90_000)

  it.each([false, true])('keeps sidebar controls attached to the active workbench Session across viewport and narrow-pane layouts (touch: %s)', async (touch) => {
    const scenario = `${engine}-${touch ? 'touch' : 'pointer'}`
    const isolated = await launchWebScaffold({ workbench: true })
    onTestFinished(() => isolated.close())
    const seed = await readFile(fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url)), 'utf8')
    const names = ['Sidebar first pane', 'Sidebar second pane']
    for (const name of names) {
      const path = join(isolated.workspaceCwd, name)
      await mkdir(path)
      const workspace = await isolated.ctx.workspaceRegistry.create(path)
      const session = await seedSession(isolated, seed, name, undefined, path)
      await workspace.attachSession(session)
      await isolated.ctx.agents.resume({
        resumeSessionId: session,
        setup: agentCtx => isolated.ctx.agentPresets.mount(agentCtx).then(() => undefined),
      })
    }
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, hasTouch: touch, isMobile: touch, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(isolated.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-viewport]').first().waitFor()
    onTestFailed(() => saveFailureShot(page, `web-e2e-workbench-sidebar-controls-${scenario}`))
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
    const ids = await panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-pane')!))
    for (const [index, id] of ids.entries()) {
      const pane = page.locator(`[data-session-pane="${id}"]`)
      const input = pane.locator('textarea').first()
      await expect.poll(() => input.isEditable()).toBe(true)
      await input.fill(`Draft belonging to pane ${index}`)
      const box = await pane.boundingBox()
      if (!box) throw new Error('Missing workbench pane geometry')
      expect(box.width).toBeLessThan(768)
    }
    const right = page.locator('[data-sidebar-right-expand]:visible')
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      for (const width of [1280, 390, 767, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 })
        await expect.poll(() => page.locator('[data-viewport]').first().getAttribute('data-viewport')).toBe(width < 768 ? 'compact' : width < 1024 ? 'medium' : 'expanded')
        await expect.poll(() => right.count()).toBe(1)
        if (width < 768) {
          await page.locator('[data-viewport] > [class*="drawer"]').waitFor({ state: 'hidden' })
          expect(await page.locator('[data-mobile-session-actions] [data-sidebar-right-expand]:visible').count()).toBe(1)
          const leftBox = await page.getByRole('button', { name: 'Open sidebar', exact: true }).boundingBox()
          const rightBox = await right.boundingBox()
          if (!leftBox || !rightBox) throw new Error('Missing compact workbench sidebar geometry')
          expect(Math.abs(leftBox.y - rightBox.y)).toBeLessThanOrEqual(1)
          expect(await page.locator('[data-conversation-header-corner]:visible').count()).toBe(0)
        } else {
          expect(await page.locator('[data-mobile-session-actions]').count()).toBe(0)
          expect(await page.locator('[data-conversation-header-corner] [data-sidebar-right-expand]:visible').count()).toBe(1)
        }
        const mountedIds = await panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-pane')!))
        if (width === 1280) expect(new Set(mountedIds)).toEqual(new Set(ids))
        for (const id of mountedIds) {
          expect(await page.locator(`[data-session-pane="${id}"] textarea`).first().inputValue()).toBe(`Draft belonging to pane ${ids.indexOf(id)}`)
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
        if (process.env.DSH_MOBILE_SCREENSHOTS) {
          await mkdir(process.env.DSH_MOBILE_SCREENSHOTS, { recursive: true })
          await page.screenshot({ path: join(process.env.DSH_MOBILE_SCREENSHOTS, `workbench-sidebar-${scenario}-${width}-${colorScheme}.png`) })
        }
      }
    }
    const frame = page.locator('[data-viewport]').first()
    const drafts = new Map(ids.map((id, index) => [id, `Draft belonging to pane ${index}`]))
    const screenshots = process.env.DSH_MOBILE_SCREENSHOTS
    if (screenshots) await mkdir(screenshots, { recursive: true })
    const viewportReport: { visibleHeight: number; pane: number; draft: string; restoredHeight: number }[] = []
    for (const visibleHeight of [200, 100, 76]) {
      const originalHeight = await page.evaluateHandle(() => Object.getOwnPropertyDescriptor(visualViewport!, 'height'))
      try {
        // This exercises the shipped viewport listener; native keyboards and gesture scrolling have separate device coverage.
        await page.evaluate((height) => {
          Object.defineProperty(visualViewport!, 'height', { configurable: true, value: height })
          visualViewport!.dispatchEvent(new Event('resize'))
        }, visibleHeight)
        await expect.poll(() => frame.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(visibleHeight)
        expect(await page.evaluate(() => innerWidth)).toBe(1280)
        expect(new Set(await panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-pane'))))).toEqual(new Set(ids))
        for (const [index, id] of ids.entries()) {
          const pane = page.locator(`[data-session-pane="${id}"]`)
          const input = pane.locator('textarea').first()
          const state = `workbench ${visibleHeight}px visible, pane ${index}`
          expect(await input.inputValue()).toBe(drafts.get(id))
          await auditResponsiveControls(page, input, `${state}: input`)
          await input.click()
          await input.press('ControlOrMeta+A')
          await input.press('ArrowRight')
          await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => element.selectionStart === element.value.length
            && element.selectionEnd === element.value.length)).toBe(true)
          await input.pressSequentially(` ${visibleHeight}`)
          const edited = `${drafts.get(id)!} ${visibleHeight}`
          drafts.set(id, edited)
          await expect.poll(() => input.inputValue()).toBe(edited)
          await auditResponsiveControls(page, input, `${state}: edited input`)
          if (screenshots) {
            await page.screenshot({ path: join(screenshots, `workbench-visible-${scenario}-${visibleHeight}-pane-${index}-input.png`) })
          }
          for (const name of ['Add images or documents', 'Send message']) {
            const action = pane.getByRole('button', { name, exact: true })
            await expect.poll(() => action.isEnabled()).toBe(true)
            await auditResponsiveControls(page, action, `${state}: ${name}`)
          }
          if (screenshots) {
            await page.screenshot({ path: join(screenshots, `workbench-visible-${scenario}-${visibleHeight}-pane-${index}-actions.png`) })
          }
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1281)
      } catch (error) {
        if (screenshots) {
          await page.screenshot({ path: join(screenshots, `workbench-visible-${scenario}-${visibleHeight}-failed.png`) })
          const geometry = await panes.evaluateAll(nodes => nodes.map((pane) => {
            const input = pane.querySelector('textarea')!
            const ancestors = []
            for (let element: Element | null = input; element !== null; element = element.parentElement) {
              const style = getComputedStyle(element)
              const rect = element.getBoundingClientRect()
              ancestors.push({ className: element.className, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                overflow: style.overflow, minHeight: style.minHeight, height: style.height,
                scrollTop: element.scrollTop, scrollHeight: element.scrollHeight })
            }
            return { pane: pane.getAttribute('data-session-pane'), ancestors }
          }))
          await writeFile(join(screenshots, `workbench-visible-${scenario}-${visibleHeight}-failed.json`), JSON.stringify(geometry, null, 2) + '\n')
        }
        throw error
      } finally {
        try {
          await originalHeight.evaluate((descriptor) => {
            if (descriptor === undefined) Reflect.deleteProperty(visualViewport!, 'height')
            else Object.defineProperty(visualViewport!, 'height', descriptor)
            visualViewport!.dispatchEvent(new Event('resize'))
          })
        } finally {
          await originalHeight.dispose()
        }
      }
      await expect.poll(() => frame.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(900)
      expect(new Set(await panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-pane'))))).toEqual(new Set(ids))
      for (const [index, id] of ids.entries()) {
        const pane = page.locator(`[data-session-pane="${id}"]`)
        const input = pane.locator('textarea').first()
        expect(await input.inputValue()).toBe(drafts.get(id))
        expect(await input.isEditable()).toBe(true)
        await auditResponsiveControls(page, input, `workbench restored after ${visibleHeight}px, pane ${index}`)
        await auditResponsiveControls(page, pane.getByRole('button', { name: 'Send message', exact: true }),
          `workbench restored after ${visibleHeight}px, pane ${index}: send`)
        viewportReport.push({ visibleHeight, pane: index, draft: await input.inputValue(), restoredHeight: 900 })
      }
      await auditResponsiveControls(page, toolbar.getByRole('button', { name: 'Select workbench', exact: true }),
        `workbench restored after ${visibleHeight}px: selector`)
      if (screenshots) {
        await page.screenshot({ path: join(screenshots, `workbench-visible-${scenario}-${visibleHeight}-restored.png`) })
      }
    }
    if (screenshots) {
      await writeFile(join(screenshots, `workbench-visible-${scenario}.json`), JSON.stringify(viewportReport, null, 2) + '\n')
    }
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, `workbench-visual-viewport-${touch ? 'touch' : 'pointer'}.expected.md`),
      viewportReport.map(row => `${row.visibleHeight}px visible, pane ${row.pane}: typing, attachment and send reachable; `
        + `draft ${JSON.stringify(row.draft)} retained after ${row.restoredHeight}px restore.`).join('\n'), MODE)
  }, 90_000)

  it('short compact: stamps the short-height profile without horizontal overflow', async () => {
    page = await openAt(375, 667)
    const frame = page.locator('[class*="frame"]').first()
    expect(await frame.getAttribute('data-viewport')).toBe('compact')
    expect(await frame.getAttribute('data-viewport-short')).toBe('true')
    const geometry = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      viewportWidth: innerWidth,
    }))
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth)
    expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.viewportWidth)
  }, 60_000)

  it('keeps terminal recovery feedback clear of the model and send controls', async () => {
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.route('**/api/terminal/list**', route => route.fulfill({ status: 503, body: 'Unavailable' }))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const retry = page.getByRole('button', { name: 'Retry terminal recovery' })
    await retry.waitFor({ timeout: 15_000 })
    const box = await retry.boundingBox()
    if (box === null) throw new Error('terminal recovery feedback has no box')
    expect(box.height).toBeGreaterThanOrEqual(44)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    await auditResponsiveControls(page, retry, 'Terminal recovery retry')
    for (const action of ['Add images or documents', 'Choose from Documents', 'Commands', 'Send message']) {
      const control = page.getByRole('button', { name: action, exact: true })
      const target = await control.boundingBox()
      if (target === null) throw new Error(`missing composer control: ${action}`)
      const overlapX = Math.min(box.x + box.width, target.x + target.width) - Math.max(box.x, target.x)
      const overlapY = Math.min(box.y + box.height, target.y + target.height) - Math.max(box.y, target.y)
      expect(Math.min(overlapX, overlapY), action).toBeLessThanOrEqual(0)
      await auditResponsiveControls(page, control, action)
    }
  }, 60_000)

  it('medium: rail column with two grid tracks and no drag handles while collapsed', async () => {
    page = await openAt(900, 700)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-responsive-medium'))
    const frame = page.locator('[class*="frame"]').first()
    expect(await frame.getAttribute('data-viewport')).toBe('medium')
    expect(await frame.getAttribute('data-sidebar-collapsed')).toBe('true')
    // The browser serializes the track list with explicit px units.
    expect(await frame.evaluate(node => (node as HTMLElement).style.gridTemplateColumns))
      .toBe('56px minmax(0px, 1fr)')
    expect(await page.locator('[class*="handle"]').count()).toBe(0)
    // The shell topbar is compact-only; medium keeps the rail as the toggle host.
    expect(await page.locator('[class*="topbar"]').count()).toBe(0)
  }, 60_000)

  it.each(['hero', 'active'] as const)('keeps the draft reachable when the visual viewport shrinks in every width mode (%s)', async (phase) => {
    const world = phase === 'hero' ? await launchWebScaffold({}) : scaffold
    if (world !== scaffold) onTestFinished(() => world.close())
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US' })
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, `web-e2e-visible-viewport-${phase}`))
    if (phase === 'active') {
      const seed = await readFile(fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url)), 'utf8')
      const sessionId = await seedSession(scaffold, seed, 'Visible viewport active history')
      await (await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)).attachSession(sessionId)
      await page.addInitScript((id) => { localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id })) }, sessionId)
    }
    await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
    if (phase === 'hero') await connectFreshWorkspace(page, world.workspaceCwd)
    const input = page.locator('[data-composer-card] textarea:enabled')
    const frame = page.locator('[data-viewport]').first()
    await page.locator(`[data-phase="${phase}"]`).waitFor()
    await input.fill('Keep this draft through keyboard and width changes.')
    const report: string[] = []
    for (const size of [
      { width: 390, height: 844, visible: 360, mode: 'compact' },
      { width: 872, height: 430, visible: 76, mode: 'medium' },
      { width: 1024, height: 768, visible: 200, mode: 'expanded' },
      { width: 1680, height: 900, visible: 240, mode: 'wide' },
    ]) {
      await page.setViewportSize({ width: size.width, height: size.height })
      await expect.poll(() => frame.getAttribute('data-viewport')).toBe(size.mode)
      try {
        // Emulation has no native keyboard; exercise the shipped visual-viewport listener separately from device acceptance.
        await page.evaluate((height) => {
          Object.defineProperty(visualViewport!, 'height', { configurable: true, value: height })
          visualViewport!.dispatchEvent(new Event('resize'))
        }, size.visible)
        await expect.poll(() => frame.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(size.visible)
        await auditResponsiveControls(page, input, `visual viewport ${size.mode}`)
        const draft = await input.inputValue()
        expect(draft).toBe('Keep this draft through keyboard and width changes.')
        report.push(`${size.mode}: ${size.width}px wide, ${size.visible}px visible; draft reachable and retained.`)
      } finally {
        await page.evaluate(() => {
          Reflect.deleteProperty(visualViewport!, 'height')
          visualViewport!.dispatchEvent(new Event('resize'))
        })
      }
      await expect.poll(() => frame.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(size.height)
    }
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, phase === 'hero' ? 'visual-viewport.expected.md' : 'visual-viewport-active.expected.md'),
      report.join('\n'), MODE)
  }, 60_000)

  it('expanded: three grid tracks with details closed and the sidebar handle present', async () => {
    page = await openAt(1280, 800)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-responsive-expanded'))
    const frame = page.locator('[class*="frame"]').first()
    expect(await frame.getAttribute('data-viewport')).toBe('expanded')
    expect(await frame.evaluate(node => (node as HTMLElement).style.gridTemplateColumns))
      .toMatch(/^\d+px minmax\(0px, 1fr\) 0px$/)
    expect(await page.locator('[class*="handle"]').count()).toBe(1)
  }, 60_000)

  it('wide/compact round-trip re-seats the shell cleanly', async () => {
    page = await openAt(1680, 1000)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-responsive-roundtrip'))
    const frame = page.locator('[class*="frame"]').first()
    expect(await frame.getAttribute('data-viewport')).toBe('wide')
    expect(await page.locator('[class*="topbar"]').count()).toBe(0)

    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => frame.getAttribute('data-viewport'), { timeout: 5_000 }).toBe('compact')
    await page.getByRole('button', { name: 'Open sidebar' }).waitFor({ timeout: 10_000 })

    await page.setViewportSize({ width: 1680, height: 1000 })
    await expect.poll(() => frame.getAttribute('data-viewport'), { timeout: 5_000 }).toBe('wide')
    await expect.poll(() => page.locator('[class*="topbar"]').count(), { timeout: 5_000 }).toBe(0)
    expect(await frame.evaluate(node => (node as HTMLElement).style.gridTemplateColumns))
      .toMatch(/^\d+px minmax\(0px, 1fr\) \d+px$/)
  }, 60_000)
})
