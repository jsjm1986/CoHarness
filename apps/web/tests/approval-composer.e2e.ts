// Web e2e scenario: the composer-takeover approval panel under a long
// command. The shipped composition confines bash through the sandbox policy
// and routes its escalation through the approval seam, so a read-only session
// asked to write a file produces a REAL pending approval — the panel renders
// in the browser, the test measures its geometry, answers through it, and the
// escalated command then runs. Replay is deterministic: the denial, the
// escalation retry and its command text arrive from replayed chunks, and the
// answer click is the test's own gesture (the same sanctioned reaction to
// model content as the question composer: the turn cannot complete without it).
//
// Geometry is the point of the scenario. The command is unbounded model text,
// and an uncapped card grows with it until the refuse/allow buttons leave the
// viewport — an approval the user could see and not answer.
import { responsiveBrowser, responsiveBrowserName, responsiveViewports } from './responsive-browser.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'

import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type import: carries the approval package's session-event merge, so
// the decided-outcome assertion below type-checks against the real union.
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  assertFixtureInventory, captureStableAria, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'
import { auditWorkflowState, compareWorkflowGolden as compareOrRefreshGolden, newWorkflowPage as newEnglishPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'
import { auditResponsiveControl } from './responsive-controls.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/approval-composer', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
// The scenario's one golden: the waiting panel. Everything the answered state
// proves is asserted directly — see the world-state block at the end.
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()

// Irreducible payload: the command has to be long enough to pass the card's
// height cap, which is the only command length that reproduces an action row pushed off
// screen. Unrelated tokens, not a repeated word — a repeated word is what the
// model compressed into `printf 'alpha %.0s' {1..400}` while recording, and a
// short command proves nothing here. The formula keeps the source small; the
// model receives the expanded literal it has to put in the command.
const TOKENS = Array.from({ length: 220 }, (_, index) => `tok${((index + 1) * 7919 % 99991).toString(36)}`).join(' ')
const PROMPT = `Write a file named notes.txt in the workspace containing exactly this text on one line: ${TOKENS}. Use one bash command with the literal text inline. Then reply with the single word DONE and stop.`

/** Draft used to measure the composer's own text cap: enough lines to pass it. */
const CAP_PROBE = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n')

/** Inspect the real pending request and locally held answer receipts without settling the Host's wait. */
async function auditApprovalContrast(page: Page, panel: Locator): Promise<void> {
  if (!workflowMatrixEnabled) return
  const original = page.viewportSize()
  if (original === null) throw new Error('Approval contrast matrix requires an explicit viewport')
  const originalTheme = await page.locator('body').getAttribute('data-ds-dark-theme')
  const output = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
  if (output !== undefined) await mkdir(output, { recursive: true })
  const records: unknown[] = []
  const scroll = panel.locator('[data-approval-scroll]')
  const card = scroll.locator('..')
  const strip = card.locator(':scope > div').first()
  const responsePath = /\/api\/respond(?:\?.*)?$/u
  try {
    for (const viewport of responsiveViewports) {
      await page.setViewportSize(viewport)
      for (const dark of [false, true]) {
        await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })))
        const inspect = async (state: string): Promise<void> => {
          await auditResponsiveControl(page, scroll, `approval/${state}/details`)
          const alert = panel.getByRole('alert')
          if (await alert.count() > 0) await auditResponsiveControl(page, alert, `approval/${state}/failure`)
          await auditResponsiveControl(page, strip, `approval/${state}/status`)
          await strip.evaluate(async (element) => {
            await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined)))
          })
          const contrast = await card.evaluate((element) => {
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 1
            const context = canvas.getContext('2d')!
            const rgba = (color: string): number[] => {
              context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1)
              return [...context.getImageData(0, 0, 1, 1).data].map(value => value / 255)
            }
            const over = (fg: number[], bg: number[]): number[] => [0, 1, 2].map(i => fg[i]! * fg[3]! + bg[i]! * (1 - fg[3]!))
            const luminance = (rgb: number[]): number => rgb.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
              .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i]!, 0)
            const nodes = [element.firstElementChild!, ...element.querySelectorAll('[data-approval-scroll] > *, [role="alert"]')]
            return nodes.map((node) => {
              const layers: Element[] = []
              for (let ancestor: Element | null = node; ancestor !== null; ancestor = ancestor.parentElement) layers.unshift(ancestor)
              let background = [1, 1, 1]
              let opacity = 1
              for (const layer of layers) {
                const style = getComputedStyle(layer)
                background = over(rgba(style.backgroundColor), background)
                opacity *= Number.parseFloat(style.opacity)
              }
              const text = rgba(getComputedStyle(node).color)
              text[3] = text[3]! * opacity
              const a = luminance(over(text, background)), b = luminance(background)
              return { text: node.textContent?.slice(0, 80), opacity, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }
            })
          })
          for (const item of contrast) {
            expect(item.opacity, `${state}: ${item.text}`).toBe(1)
            expect(item.ratio, `${state}: ${item.text}`).toBeGreaterThanOrEqual(4.5)
          }
          records.push({ viewport: viewport.name, dark, state, contrast })
          if (output !== undefined) await page.screenshot({ path: join(output, `${responsiveBrowserName}-approval-${state}-${dark ? 'dark' : 'light'}-${viewport.name}.png`), animations: 'disabled' })
        }
        await inspect('waiting-contrast')
        for (const [name, outcome] of [['Reject', 'rejected'], ['Allow once', 'allowed-once']] as const) {
          const release = Promise.withResolvers<undefined>()
          const finished = Promise.withResolvers<undefined>()
          let entered = false
          await page.route(responsePath, async (route) => {
            entered = true
            await release.promise
            try {
              await route.fulfill({ json: { accepted: false, reason: 'bad-response' } })
              finished.resolve(undefined)
            } catch (error) { finished.reject(error) }
          }, { times: 1 })
          try {
            await Promise.all([page.waitForRequest(responsePath), panel.getByRole('button', { name, exact: true }).click()])
            await expect.poll(() => card.getAttribute('data-answered')).toBe(outcome)
            await inspect(`${outcome}-echo`)
          } finally {
            release.resolve(undefined)
            if (entered) await finished.promise
            await page.unroute(responsePath)
          }
          await panel.getByRole('alert').waitFor()
          await expect.poll(() => card.getAttribute('data-answered')).toBeNull()
          await inspect(`${outcome}-failure`)
        }
      }
    }
  } catch (error) {
    if (output !== undefined) {
      await page.screenshot({ path: join(output, 'approval-contrast-failed.png'), animations: 'disabled' })
      await writeFile(join(output, 'approval-contrast-failed-geometry.json'), JSON.stringify(await scroll.evaluate((element) => {
        const ancestors = []
        for (let node: Element | null = element; node !== null; node = node.parentElement) {
          const style = getComputedStyle(node)
          const rect = node.getBoundingClientRect()
          ancestors.push({ className: node.className, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop,
            containerType: style.containerType, overflow: style.overflow, maxHeight: style.maxHeight })
        }
        return { viewport: { width: innerWidth, height: innerHeight }, ancestors }
      }), null, 2) + '\n')
    }
    throw error
  } finally {
    await page.evaluate((theme) => {
      if (theme === null) document.body.removeAttribute('data-ds-dark-theme')
      else document.body.setAttribute('data-ds-dark-theme', theme)
    }, originalTheme)
    await page.setViewportSize(original)
    if (output !== undefined) await writeFile(join(output, `approval-contrast-${responsiveBrowserName}.json`), JSON.stringify(records, null, 2) + '\n')
  }
}

describe('web e2e: approval takeover keeps its actions reachable', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 15 })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await responsiveBrowser.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('caps the long command, answers through the panel, and runs the escalated command', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-approval'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })

    // The composer's own text cap, measured on the live draft scrollport before
    // the takeover replaces it — the box that carries the cap, while the
    // textarea inside it is as tall as the whole draft. The panel's scroll
    // region must stop at the same height (the designer's requirement: one cap
    // for the composer seat), and measuring it here keeps the assertion free of
    // the px value itself.
    await input.fill(CAP_PROBE)
    const composerCap = await input.evaluate(el => el.closest('[data-input-scroll]')?.clientHeight ?? 0)
    expect(composerCap).toBeGreaterThan(0)
    await input.fill('')

    // Read-only: the mode whose denial the model escalates from. Switched
    // through the shipped access-mode chip, not a test-only override.
    await page.locator('[aria-label^="Access mode"]').click()
    await page.getByRole('menuitem', { name: 'Read only' }).click()
    await expect.poll(
      () => page.locator('[aria-label="Access mode, current: Read only"]').count(),
      { timeout: 15_000 },
    ).toBe(1)

    const settled = scaffold.whenTurnSettled(MODE === 'record' || workflowMatrixEnabled ? 240_000 : 60_000)
    await input.fill(PROMPT)
    await input.press('Enter')

    // The panel takes over the input area while the tool blocks. Its presence
    // is a STABLE waiting state (it stays until answered), so waitFor is
    // race-free.
    const panel = page.locator('[data-approval-key]')
    await panel.waitFor({ timeout: MODE === 'record' ? 180_000 : 60_000 })
    const scroll = panel.locator('[data-approval-scroll]')
    await expect.poll(() => scroll.getByText(/tok/).count(), { timeout: 15_000 }).toBeGreaterThan(0)

    if (MODE !== 'record') {
      // This golden owns the stable waiting surface; the answered golden below
      // owns the resulting transcript.
      const snapshot = await captureStableAria(page, '[data-approval-key]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

      // The uncapped-card hazard the header names, measured at the lane
      // baseline and at a short viewport, on the live panel.
      const original = page.viewportSize() ?? { width: 1680, height: 1000 }
      for (const height of [1000, 700]) {
        await page.setViewportSize({ width: 900, height })
        const geometry = await panel.evaluate((root) => {
          const region = root.querySelector<HTMLElement>('[data-approval-scroll]')
          const card = region?.parentElement ?? null
          // Role/text, not the CSS-module class names: the built client hashes those.
          const buttons = [...root.querySelectorAll<HTMLElement>('button')]
          const rows = buttons.map(button => button.getBoundingClientRect())
          return {
            buttons: buttons.length,
            capped: region === null ? 0 : region.clientHeight,
            // A scrolling region proves the cap is genuinely engaged; without
            // it every assertion below would hold vacuously.
            scrolls: region === null ? false : region.scrollHeight > region.clientHeight,
            cardBottom: card === null ? Number.NaN : card.getBoundingClientRect().bottom,
            actionsTop: Math.min(...rows.map(rect => rect.top)),
            actionsBottom: Math.max(...rows.map(rect => rect.bottom)),
            viewport: window.innerHeight,
          }
        })
        expect(geometry.buttons).toBe(2)
        expect(geometry.scrolls).toBe(true)
        // One cap for the seat: the panel's text region stops where the
        // composer draft does (sub-pixel tolerance for the shared padding).
        expect(Math.abs(geometry.capped - composerCap)).toBeLessThan(1)
        // Both buttons stay inside the card AND inside the viewport — the
        // answerable state the cap exists to guarantee.
        expect(geometry.actionsTop).toBeGreaterThan(0)
        expect(geometry.actionsBottom).toBeLessThanOrEqual(geometry.viewport)
        expect(geometry.actionsBottom).toBeLessThanOrEqual(geometry.cardBottom)
      }
      await page.setViewportSize(original)
    }

    await auditWorkflowState(page, 'approval', 'pending-long-command', panel)
    await auditApprovalContrast(page, panel)
    await panel.getByRole('button', { name: 'Allow once' }).click()

    const sessionId = await settled
    if (MODE === 'record') {
      await recordFixture(scaffold, sessionId, FIXTURE)
      return
    }
    // World state: the granted escalation is what let the command run, and the
    // panel leaves with the regular composer restored. Asserted on the world
    // and the DOM rather than through a transcript golden — the denied first
    // attempt renders the OS's own refusal ("Operation not permitted" on
    // macOS, "Read-only file system" on Linux), so the answered transcript is
    // not a platform-neutral golden surface.
    expect(JSON.stringify(sessionEvents.filter(e => e.type === 'approval/decided').at(-1)))
      .toContain('allowed-once')
    const written = await readFile(join(scaffold.workspaceCwd, 'workspace', 'notes.txt'), 'utf8')
    expect(written).toContain(TOKENS.slice(0, 64))
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(1)
    expect(await page.locator('[data-approval-key]').count()).toBe(0)
    await expect.poll(() => page.locator('textarea').first().isEnabled(), { timeout: 10_000 }).toBe(true)
    await auditWorkflowState(page, 'approval', 'allowed-and-completed', page.locator('[class*="centerCol"]'))
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 300_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl', 'ui.expected.md'])
  })
})
