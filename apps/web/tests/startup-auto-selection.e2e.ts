// Built web startup selection over independently held network responses.
// Initial baselines and historical preparation show one loading status while
// no Session is current. The resident Hero and composer nodes survive default
// selection; a known-current blank retains its Hero during its own history read.
// These Host-only scenarios make no model requests.
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

  it('retains the composer nodes behind loading while an unselected blank fallback opens', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-startup-auto-selection'))
    // Runs before any page script on the reload below, so the first phase the
    // root ever renders is recorded, not just the ones after a listener attaches.
    await page.addInitScript(() => {
      const phases: string[] = []
      ;(window as unknown as { __conversationPhases: string[] }).__conversationPhases = phases
      const remember = (): void => {
        const phase = document.querySelector('div[data-phase]')?.getAttribute('data-phase')
        if (phase === null || phase === undefined) return
        if (phases[phases.length - 1] !== phase) phases.push(phase)
      }
      const observer = new MutationObserver(remember)
      observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-phase'] })
      window.addEventListener('pagehide', () => { observer.disconnect() }, { once: true })
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
    await page.evaluate(() => { localStorage.removeItem('dsh.sessions.current') })
    await page.reload({ waitUntil: 'commit' })
    await historyInFlight

    await page.waitForSelector(ROOT_PHASE, { timeout: 15_000 })
    expect(await page.locator(ROOT_PHASE).first().getAttribute('data-phase')).toBe('settling')
    expect(await page.getByRole('status', { name: 'Loading workspace', exact: true }).count()).toBe(1)
    expect(await page.locator('textarea').first().isVisible()).toBe(false)
    await page.evaluate(() => {
      ;(window as unknown as { __pendingComposer: Element | null }).__pendingComposer = document.querySelector('textarea')
    })

    releaseHistory()
    await page.locator('textarea:enabled[placeholder="Describe what you want to build"]')
      .waitFor({ timeout: 15_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningsBefore)

    await page.getByRole('status', { name: 'Loading workspace', exact: true }).waitFor({ state: 'hidden' })
    expect(await page.locator('textarea').first().isVisible()).toBe(true)
    expect(await page.evaluate(() => document.querySelector('textarea')
      === (window as unknown as { __pendingComposer: Element | null }).__pendingComposer)).toBe(true)
    expect(await recordedPhases(page)).toEqual(['settling', 'hero'])
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)
  it('ends the initial spinner on a failed Workspace baseline and shows it again during Retry', async () => {
    const retryScaffold = await launchWebScaffold({})
    let retryPage: Page | undefined
    const failedBaseline = Promise.withResolvers<undefined>()
    const retryBaseline = Promise.withResolvers<undefined>()
    let listCalls = 0
    let createCalls = 0
    try {
      retryPage = await newEnglishPage(browser)
      const targetPage = retryPage
      const logs = watchConsole(targetPage)
      targetPage.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/session.create') createCalls++
      })
      await targetPage.route(/\/api\/workspace\.list(?:\?.*)?$/, async (route) => {
        const response = await route.fetch()
        const call = ++listCalls
        if (call === 1) {
          await failedBaseline.promise
          const body = await response.json() as { result: unknown }
          body.result = { ok: false, error: { code: 'internal', message: 'Synthetic list failure', details: {} } }
          await route.fulfill({ response, json: body })
        } else {
          if (call === 2) await retryBaseline.promise
          await route.fulfill({ response })
        }
      })
      await targetPage.goto(retryScaffold.authenticatedUrl, { waitUntil: 'load' })
      const loading = targetPage.getByRole('status', { name: 'Loading workspace', exact: true })
      await loading.waitFor()
      failedBaseline.resolve(undefined)
      const error = targetPage.getByRole('alert').filter({ hasText: 'Could not load the list' })
      await error.waitFor()
      await loading.waitFor({ state: 'hidden' })
      await targetPage.getByRole('textbox', { name: 'Choose workspace', exact: true }).waitFor()
      const expected = join(REPO_ROOT, 'apps/web/tests/expected/startup-auto-selection/baseline-failed.expected.md')
      await compareOrRefreshGolden(expected,
        await captureStableAria(targetPage, '[data-row-key="list-feedback"]', retryScaffold.workspaceCwd), webSnapshotMode())
      await error.getByRole('button', { name: 'Retry', exact: true }).click()
      await loading.waitFor()
      expect(await targetPage.getByRole('textbox', { name: 'Choose workspace', exact: true }).count()).toBe(0)
      retryBaseline.resolve(undefined)
      await loading.waitFor({ state: 'hidden' })
      await targetPage.getByRole('textbox', { name: 'Choose workspace', exact: true }).waitFor()
      expect(await targetPage.getByRole('alert').count()).toBe(0)
      expect(listCalls).toBe(2)
      expect(createCalls).toBe(0)
      expect(logs.pageErrors).toEqual([])
    } catch (error) {
      if (retryPage !== undefined) await saveFailureShot(retryPage, 'web-e2e-startup-baseline-retry')
      throw error
    } finally {
      failedBaseline.resolve(undefined)
      retryBaseline.resolve(undefined)
      try {
        await retryPage?.unrouteAll({ behavior: 'wait' })
        await retryPage?.close()
      } finally { await retryScaffold.close() }
    }
  }, 120_000)

  it('opens existing project history after cold identity and both baselines without a navigation click', async () => {
    const projectScaffold = await launchWebScaffold({ workbench: true })
    let projectPage: Page | undefined
    const describeGate = Promise.withResolvers<undefined>()
    const describeRequested = Promise.withResolvers<undefined>()
    const workspaceGate = Promise.withResolvers<undefined>()
    const workspaceRequested = Promise.withResolvers<undefined>()
    const historyGate = Promise.withResolvers<undefined>()
    const historyRequested = Promise.withResolvers<undefined>()
    try {
      const id = await seedSession(projectScaffold, savedHistory(), 'project-startup-history')
      const workspace = await projectScaffold.ctx.workspaceRegistry.create(projectScaffold.workspaceCwd)
      await workspace.attachSession(id)
      projectPage = await newEnglishPage(browser)
      const targetPage = projectPage
      const targetTripwire = watchConsole(targetPage)
      const calls: string[] = []
      targetPage.on('request', (request) => { calls.push(new URL(request.url()).pathname) })
      await targetPage.addInitScript(() => { localStorage.removeItem('dsh.sessions.current') })
      // Gateway account/target declarations are external to this real Host composition.
      await targetPage.route(/\/api\/host\.describe(?:\?.*)?$/, async (route) => {
        const response = await route.fetch()
        const body = await response.json() as {
          result: { ok: true; value: { executionAuthorityRequired: boolean; runtimeTarget: { kind: 'project'; projectId: number } } }
            | { ok: false }
        }
        expect(body.result.ok).toBe(true)
        if (body.result.ok) {
          body.result.value.executionAuthorityRequired = true
          body.result.value.runtimeTarget = { kind: 'project', projectId: 7 }
        }
        describeRequested.resolve(undefined)
        await describeGate.promise
        await route.fulfill({ response, json: body })
      })
      await targetPage.route(/\/account\/api\/context(?:\?.*)?$/, route => route.fulfill({ json: {
        user: { id: 1, username: 'fixture', displayName: 'Fixture', role: 'admin' },
        scope: { kind: 'project', projectId: 7, projectName: 'Synthetic project', mode: 'rw' },
        projects: [{ projectId: 7, name: 'Synthetic project', path: projectScaffold.workspaceCwd, mode: 'rw' }],
      } }))
      await targetPage.route(/\/account\/api\/workbench\/catalog(?:\?.*)?$/, route => route.fulfill({ json: {
        personal: { id: 1, name: 'Fixture' }, personalComplete: true,
        activeRuntime: { kind: 'project', projectId: 7 },
        projects: [{ projectId: 7, name: 'Synthetic project', path: projectScaffold.workspaceCwd, mode: 'rw' }],
        items: [{ sessionId: id, runtime: { kind: 'project', projectId: 7, projectName: 'Synthetic project' },
          visibility: 'project', creatorUserId: 1, creatorDisplayName: 'Fixture', updatedAt: 1, blank: false, canWrite: true }],
      } }))
      await targetPage.route(/\/api\/workspace\.list(?:\?.*)?$/, async (route) => {
        const response = await route.fetch()
        workspaceRequested.resolve(undefined)
        await workspaceGate.promise
        await route.fulfill({ response })
      })
      let heldHistory = false
      await targetPage.route(HISTORY_ROUTE, async (route) => {
        if (heldHistory) { await route.continue(); return }
        heldHistory = true
        const response = await route.fetch()
        expect(response.status()).toBe(200)
        historyRequested.resolve(undefined)
        await historyGate.promise
        await route.fulfill({ response })
      })
      await targetPage.goto(projectScaffold.authenticatedUrl, { waitUntil: 'load' })
      await describeRequested.promise
      expect(calls.filter(path => path === '/api/session.list' || path === '/api/workspace.list')).toEqual([])
      const sessionBaseline = targetPage.waitForResponse(response => new URL(response.url()).pathname === '/api/session.list')
      describeGate.resolve(undefined)
      await Promise.all([workspaceRequested.promise, sessionBaseline])
      expect(await targetPage.getByText(SAVED_PROMPT, { exact: true }).count()).toBe(0)
      expect(calls.filter(path => path === '/api/session.history')).toEqual([])
      // Account verification and both list baselines precede history; the account-pending case covers late viewport restoration.
      await targetPage.getByRole('button', { name: 'Switch personal or project scope', exact: true })
        .getByText('Synthetic project', { exact: true }).waitFor({ timeout: 30_000 })
      expect(await targetPage.getByRole('status', { name: 'Loading workspace', exact: true }).count()).toBe(1)
      expect(await targetPage.locator('textarea[placeholder="Choose a workspace to start"]').isVisible()).toBe(false)
      const loadingExpected = join(REPO_ROOT, 'apps/web/tests/expected/startup-auto-selection/initial-loading.expected.md')
      await compareOrRefreshGolden(loadingExpected,
        await captureStableAria(targetPage, '[data-conversation-region="chat"]', projectScaffold.workspaceCwd), webSnapshotMode())
      workspaceGate.resolve(undefined)
      await historyRequested.promise
      expect(calls.filter(path => path === '/api/session.history')).toHaveLength(1)
      expect(await targetPage.getByText(SAVED_PROMPT, { exact: true }).count()).toBe(0)
      expect(await targetPage.getByRole('status', { name: 'Loading workspace', exact: true }).count()).toBe(1)
      historyGate.resolve(undefined)
      await targetPage.getByText(SAVED_PROMPT, { exact: true }).waitFor()
      await targetPage.getByText('The saved conversation is ready.', { exact: true }).waitFor()
      expect(calls.filter(path => path === '/api/session.create')).toEqual([])
      expect(projectScaffold.ctx.agents.get(id)).toBeUndefined()
      const expected = join(REPO_ROOT, 'apps/web/tests/expected/startup-auto-selection/saved-history.expected.md')
      await compareOrRefreshGolden(expected,
        await captureStableAria(targetPage, '[data-conversation-scroll]', projectScaffold.workspaceCwd), webSnapshotMode())
      expect(targetTripwire.pageErrors).toEqual([])
    } catch (error) {
      if (projectPage !== undefined) await saveFailureShot(projectPage, 'web-e2e-project-startup-selection')
      throw error
    } finally {
      describeGate.resolve(undefined)
      workspaceGate.resolve(undefined)
      historyGate.resolve(undefined)
      try {
        await projectPage?.unrouteAll({ behavior: 'wait' })
        await projectPage?.close()
      } finally { await projectScaffold.close() }
    }
  }, 120_000)

  it.each(['local', 'account', 'account pending'] as const)('reads the saved history while the real list response is held, then presents the same opening: %s', async (composition) => {
    const accountScaffold = composition === 'local' ? undefined : await launchWebScaffold({ workbench: true })
    let accountPage: Page | undefined
    let targetPage = page
    let holdContext = false
    const accountContextGate = Promise.withResolvers<undefined>()
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
          if (holdContext) await accountContextGate.promise
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
      let terminalCalls = 0
      const countHistory = (request: import('playwright').Request): void => {
        const path = new URL(request.url()).pathname
        if (path === '/api/session.history') historyCalls++
        if (path === '/api/session.historyIndex') indexCalls++
        if (path === '/api/terminal/list') terminalCalls++
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
        holdContext = composition === 'account pending'
        await targetPage.reload({ waitUntil: 'commit' })
        await listReady.promise
        await expect.poll(() => historyCalls).toBe(1)
        await expect.poll(() => historyResponse?.status()).toBe(200)
        expect((await historyResponse!.json() as { result: { ok: boolean } }).result.ok).toBe(true)
        expect(historyCalls).toBe(1)
        expect(indexCalls).toBe(0)
        expect(await targetPage.getByText(SAVED_PROMPT, { exact: true }).count()).toBe(0)
        expect(await targetPage.getByRole('status', { name: 'Loading workspace', exact: true }).count()).toBe(1)
        expect(await targetPage.getByRole('textbox', { name: 'Choose workspace', exact: true }).count()).toBe(0)
        expect(await targetPage.locator('textarea').first().isVisible()).toBe(false)
        expect(targetScaffold.ctx.agents.get(id) === undefined).toBe(true)
        listGate.resolve(undefined)
        await targetPage.getByText(SAVED_PROMPT, { exact: true }).waitFor()
        await targetPage.getByText('The saved conversation is ready.', { exact: true }).waitFor()
        if (composition === 'account pending') {
          const composer = await captureStableAria(targetPage, '[data-composer-seat]', targetScaffold.workspaceCwd)
          expect(composer).not.toContain('Retry terminal recovery')
          expect(terminalCalls).toBe(0)
          accountContextGate.resolve(undefined)
          await expect.poll(() => terminalCalls).toBe(1)
          expect(await targetPage.getByRole('button', { name: 'Retry terminal recovery', exact: true }).count()).toBe(0)
        }
        // Late account verification can reinstall the persisted viewport and
        // complete Agent-backed model reads after the opening is presented.
        if (composition !== 'account pending') {
          expect(historyCalls).toBe(1)
          expect(targetScaffold.ctx.agents.get(id) === undefined).toBe(true)
        }
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
      accountContextGate.resolve(undefined)
      try {
        await accountPage?.unrouteAll({ behavior: 'wait' })
        await accountPage?.close()
      }
      finally { await accountScaffold?.close() }
    }
  }, 120_000)

})
