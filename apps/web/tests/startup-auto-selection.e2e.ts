// Web e2e scenario: startup auto-selection keeps the hero on screen.
//
// A page load with a workspace already registered runs
// `WorkspaceRuntime.startInitialSelection`: it opens the most recent
// workspace's history, falling back to its blank session when no history
// exists. `openState` flips to `loading` the
// moment `open()` lands; driving `data-phase=settling` on the conversation
// root from that flip would hide the composer seat and the header
// (`visibility:hidden`) for the whole `session.history` round-trip — the
// center column blanks and repaints like a full-page refresh on every launch.
//
// The unit spec pins the phase condition over hand-built stores. What only the
// assembled application can show is that the path a user actually takes
// reaches it: the real selection service, the real client session opening over
// the real /api transport, and a real browser deciding what is painted.
// The initial Workspace pick also records the resident Hero/composer nodes and
// proves that opening the first blank Session fallback fills the strict outlets
// without replacing those nodes.
//
// The round-trip against a loopback host is far too fast to observe, so this
// scenario HOLDS the `session.history` response open in the browser's network
// handler and asserts the visible frame while it is in flight. That wait is
// what makes the assertions non-vacuous: without the phase exemption, the held
// window is exactly when `settling` would be painted and the composer hidden.
//
// Zero model calls: registering a workspace and opening its blank fallback are
// Host operations with no model involvement. A stray stream would fail loud
// with NO_ADAPTER.
import { join } from 'node:path'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

/** Wire path of the history round-trip the conversation root waits out (POST /api/session.history). */
const HISTORY_ROUTE = /\/api\/session\.history(?:\?.*)?$/

/**
 * The conversation root's own phase attribute. `div` disambiguates it from the
 * composer textarea, which carries an unrelated `data-phase` of its own.
 */
const ROOT_PHASE = 'div[data-phase]'

/** Every distinct `data-phase` the conversation root shows, in order, across one page load. */
function recordedPhases(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __conversationPhases: string[] }).__conversationPhases)
}

const SAVED_ID = 'startup-saved-history'
const SAVED_PROMPT = 'Show the saved conversation.'

/** A closed synthetic conversation restored without an Agent or model request. */
function savedHistory(): string {
  const session = Session.create(SessionId(SAVED_ID))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: SAVED_PROMPT }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: createAssistantMessage({ source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      content: [{ type: 'text', text: 'The saved conversation is ready.' }],
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 1700000000000,
    cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

describe('web e2e: startup auto-selection', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps the resident Hero and composer nodes when the first Workspace session appears', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-first-workspace-stable-tree'))
    await page.locator(`${ROOT_PHASE}[data-phase="hero"]`).waitFor({ timeout: 15_000 })
    const headline = page.locator('[data-phase]').getByText('COHARNESS', { exact: true })
    const brandHitbox = headline.locator('xpath=preceding-sibling::span[1]')
    const brandMark = brandHitbox.locator('svg')
    expect(await brandMark.evaluate(node => getComputedStyle(node).color))
      .toBe(await headline.evaluate(node => getComputedStyle(node).color))
    await brandHitbox.hover()
    expect(await brandMark.evaluate(node => getComputedStyle(node).animationName)).not.toBe('none')
    await page.evaluate(() => {
      const refs = {
        root: document.querySelector('div[data-phase="hero"]'),
        workspaceChip: document.querySelector('[aria-label="Choose workspace"]'),
        scrollBody: document.querySelector('[data-conversation-scroll]'),
        composerSeat: document.querySelector('[data-composer-seat]'),
        textarea: document.querySelector('textarea'),
      }
      if (Object.values(refs).some(node => node === null)) throw new Error('incomplete initial Hero tree')
      ;(window as unknown as { __heroTree: typeof refs }).__heroTree = refs
    })

    // A registered Workspace is the precondition for the reload case below;
    // this first connection is also the no-Workspace → Workspace path.
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'startup-auto-selection')

    expect(await page.evaluate(() => {
      const before = (window as unknown as { __heroTree: Record<string, Element> }).__heroTree
      return {
        phase: document.querySelector('div[data-phase]')?.getAttribute('data-phase'),
        root: document.querySelector('div[data-phase="hero"]') === before.root,
        workspaceChip: document.querySelector('[aria-label="Choose workspace"]') === before.workspaceChip,
        scrollBody: document.querySelector('[data-conversation-scroll]') === before.scrollBody,
        composerSeat: document.querySelector('[data-composer-seat]') === before.composerSeat,
        textarea: document.querySelector('textarea') === before.textarea,
        textareaEnabled: !(document.querySelector('textarea') as HTMLTextAreaElement).disabled,
      }
    })).toEqual({
      phase: 'hero',
      root: true,
      workspaceChip: true,
      scrollBody: true,
      composerSeat: true,
      textarea: true,
      textareaEnabled: true,
    })
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('keeps the hero and the composer on screen while the auto-selected blank session opens', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-startup-auto-selection'))
    // Runs before any page script on the reload below, so the first phase the
    // root ever renders is recorded, not just the ones after a listener attaches.
    await page.addInitScript(() => {
      const phases: string[] = []
      ;(window as unknown as { __conversationPhases: string[] }).__conversationPhases = phases
      setInterval(() => {
        const phase = document.querySelector('div[data-phase]')?.getAttribute('data-phase')
        if (phase === null || phase === undefined) return
        if (phases[phases.length - 1] !== phase) phases.push(phase)
      }, 8)
    })

    let releaseHistory = (): void => {}
    const historyHeld = new Promise<void>((resolve) => { releaseHistory = resolve })
    let historyRequested = (): void => {}
    const historyInFlight = new Promise<void>((resolve) => { historyRequested = resolve })
    let gated = false
    await page.route(HISTORY_ROUTE, async (route) => {
      // Only the auto-selection's own round-trip is held; later pages must not
      // deadlock behind a gate this test has already released.
      if (gated) { await route.continue(); return }
      gated = true
      historyRequested()
      await historyHeld
      await route.continue()
    })

    const warningsBefore = tripwire.warnings.length
    await page.reload({ waitUntil: 'commit' })
    await historyInFlight

    // The frame a user sees while the session is still opening: hero phase, the
    // hero title, and a composer that is actually painted (`settling` hides the
    // seat with `visibility:hidden`, which Playwright reports as not visible).
    await page.waitForSelector(ROOT_PHASE, { timeout: 15_000 })
    expect(await page.locator(ROOT_PHASE).first().getAttribute('data-phase')).toBe('hero')
    expect(await page.locator('[data-phase]').getByText('COHARNESS').isVisible()).toBe(true)
    expect(await page.locator('textarea').first().isVisible()).toBe(true)

    releaseHistory()
    // The auto-selected blank session parks the composer on its workspace
    // prompt until a workspace is chosen; waiting for that stable state
    // proves the composer resolved instead of hanging on the open.
    await page.locator('textarea[placeholder="Choose a workspace to start"]')
      .waitFor({ timeout: 15_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningsBefore)

    // Settling is not merely absent from the frame sampled above: the root
    // never entered it at any point of the load.
    expect(await recordedPhases(page)).toEqual(['hero'])
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)
  it.each(['local', 'account'] as const)('reads the saved history while the real list response is held, then presents the same opening: %s', async (composition) => {
    const accountScaffold = composition === 'account' ? await launchWebScaffold({ workbench: true }) : undefined
    let accountPage: Page | undefined
    let targetPage = page
    try {
      const targetScaffold = accountScaffold ?? scaffold
      if (accountScaffold !== undefined) targetPage = accountPage = await newEnglishPage(browser)
      const targetTripwire = accountScaffold === undefined ? tripwire : watchConsole(targetPage)
      if (accountScaffold !== undefined) {
        // The Gateway owns account metadata; Host APIs, both WebSockets and the
        // complete Workbench/authority/persistence consumers run unchanged.
        await targetPage.route(/\/api\/host\.describe(?:\?.*)?$/, async (route) => {
          const response = await route.fetch()
          const body = await response.json() as {
            result: { ok: true; value: { executionAuthorityRequired: boolean; runtimeTarget: { kind: 'personal' } } } | { ok: false }
          }
          expect(body.result.ok).toBe(true)
          if (body.result.ok) {
            body.result.value.executionAuthorityRequired = true
            body.result.value.runtimeTarget = { kind: 'personal' }
          }
          await route.fulfill({ response, json: body })
        })
        await targetPage.route(/\/account\/api\/context(?:\?.*)?$/, async (route) => {
          await route.fulfill({ json: {
            user: { id: 1, username: 'fixture', displayName: 'Fixture', role: 'admin' },
            scope: { kind: 'personal' }, projects: [],
          } })
        })
        await targetPage.route(/\/account\/api\/workbench\/catalog(?:\?.*)?$/, async (route) => {
          await route.fulfill({ json: {
            personal: { id: 1, name: 'Fixture' }, personalComplete: true, activeRuntime: { kind: 'personal' }, projects: [],
            items: [{ sessionId: SAVED_ID, runtime: { kind: 'personal' }, visibility: 'personal', title: 'Saved fixture',
              creatorUserId: 1, creatorDisplayName: 'Fixture', updatedAt: 1, blank: false, canWrite: true }],
          } })
        })
        await targetPage.goto(accountScaffold.authenticatedUrl, { waitUntil: 'load' })
        await targetPage.waitForSelector('[class*="frame"]')
      }
      const id = await seedSession(targetScaffold, savedHistory(), SAVED_ID)
      const workspace = await targetScaffold.ctx.workspaceRegistry.create(targetScaffold.workspaceCwd)
      await workspace.attachSession(id)
      await targetPage.evaluate((sessionId) => {
        localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }))
      }, id)
      const listGate = Promise.withResolvers<undefined>()
      const listReady = Promise.withResolvers<undefined>()
      let historyCalls = 0
      let historyResponse: import('playwright').Response | undefined
      const observeHistory = (response: import('playwright').Response): void => {
        if (new URL(response.url()).pathname !== '/api/session.history'
          || (response.request().postDataJSON() as { payload: { sessionId: string } }).payload.sessionId !== id) return
        historyResponse = response
      }
      let indexCalls = 0
      const countHistory = (request: import('playwright').Request): void => {
        const path = new URL(request.url()).pathname
        if (path === '/api/session.history') historyCalls++
        if (path === '/api/session.historyIndex') indexCalls++
      }
      targetPage.on('request', countHistory)
      targetPage.on('response', observeHistory)
      const listRoute = /\/api\/session\.list(?:\?.*)?$/
      const listReads: Promise<void>[] = []
      await targetPage.route(listRoute, (route) => {
        const read = (async (): Promise<void> => {
          const response = await route.fetch()
          listReady.resolve(undefined)
          await listGate.promise
          await route.fulfill({ response })
        })()
        listReads.push(read)
        return read
      })
      const warningsBefore = targetTripwire.warnings.length
      try {
        await targetPage.reload({ waitUntil: 'commit' })
        await listReady.promise
        await expect.poll(() => historyCalls).toBe(1)
        await expect.poll(() => historyResponse?.status()).toBe(200)
        expect((await historyResponse!.json() as { result: { ok: boolean } }).result.ok).toBe(true)
        expect(historyCalls).toBe(1)
        expect(indexCalls).toBe(0)
        expect(await targetPage.getByText(SAVED_PROMPT, { exact: true }).count()).toBe(0)
        expect(await targetPage.locator('textarea').first().isVisible()).toBe(true)
        expect(targetScaffold.ctx.agents.get(id)).toBeUndefined()
        listGate.resolve(undefined)
        await targetPage.getByText(SAVED_PROMPT, { exact: true }).waitFor()
        await targetPage.getByText('The saved conversation is ready.', { exact: true }).waitFor()
        expect(historyCalls).toBe(1)
        expect(targetScaffold.ctx.agents.get(id)).toBeUndefined()
        const expected = join(REPO_ROOT, 'apps/web/tests/expected/startup-auto-selection')
        await compareOrRefreshGolden(join(expected, 'saved-history.expected.md'),
          await captureStableAria(targetPage, '[data-conversation-scroll]', targetScaffold.workspaceCwd), webSnapshotMode())
        acknowledgeReloadConnectionLoss(targetTripwire, warningsBefore)
        expect(targetTripwire.pageErrors).toEqual([])
      } finally {
        listGate.resolve(undefined)
        targetPage.off('request', countHistory)
        targetPage.off('response', observeHistory)
        await targetPage.unroute(listRoute)
        await Promise.all(listReads)
      }
    } catch (error) {
      await saveFailureShot(targetPage, `web-e2e-startup-saved-history-${composition}`)
      throw error
    } finally {
      try { await accountPage?.close() }
      finally { await accountScaffold?.close() }
    }
  }, 120_000)

})
