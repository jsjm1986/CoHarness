/** Real remote document bootstrap and tab-local draft adoption with a held node. */
import { completionBarrier } from './support.ts'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Request, Response } from 'playwright'
import { computerBrowser } from './computer-browser.ts'
import { launchPersonalComputersFixture, personalTargets } from './personal-computers-fixture.ts'
import { compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'

it('opens the recent remote messages and keeps earlier pages and drafts attached to their Session', async () => {
  const remote = personalTargets[1]!
  const sessionId = 'startup-demand-paged-history'
  const overlay = fileURLToPath(new URL('./remote-prepared-history.overlay.yml', import.meta.url))
  const fixture = await launchPersonalComputersFixture({
    deferredEntry: true, sessionIds: ['unrelated-local-history', sessionId], extraOverlayPath: overlay,
  })
  fixture.worlds[1]!.ctx.on('webserver/index-inject', (rows) => {
    rows.push({ kind: 'global', name: '__DSH_DOCUMENT_IDENTITY__', value: {
      version: 1, principalId: 7, runtimeTarget: { kind: 'personal', runtimeId: remote.runtimeId },
    } })
  })
  const browser = await computerBrowser()
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
  const releaseHistoryIndex = completionBarrier()
  const historyIndexRequested = completionBarrier()
  const entry = new URL(fixture.url)
  entry.searchParams.set('dshRuntime', remote.runtimeId)
  const older: number[] = []
  const readOlder = (request: Request): void => {
    const url = new URL(request.url())
    if (url.pathname !== '/api/session.history' || request.method() !== 'POST') return
    const { payload } = request.postDataJSON() as { payload: { sessionId: string; beforeSeq?: number } }
    if (payload.sessionId === sessionId && payload.beforeSeq !== undefined) older.push(payload.beforeSeq)
  }
  try {
    await page.route('**/api/session.historyIndex*', async (route) => {
      const request = route.request()
      const input = request.postDataJSON() as { payload?: { sessionId?: string } } | null
      if (input?.payload?.sessionId === sessionId) {
        historyIndexRequested.resolve()
        await releaseHistoryIndex.promise
      }
      await route.continue()
    })
    await page.addInitScript(({ runtimeId, session }) => {
      sessionStorage.setItem(`dsh.sessions.current.v3.7.${runtimeId}.personal`, JSON.stringify({ sessionId: session }))
    }, { runtimeId: remote.runtimeId, session: sessionId })
    page.on('request', readOlder)
    await page.goto(entry.href)
    const transcript = page.locator('[data-conversation-scroll]:visible').first()
    const recent = transcript.getByText('DONE', { exact: true })
    const earlier = transcript.getByText('Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.', { exact: true })
    const loadEarlier = transcript.getByRole('button', { name: 'Load earlier' })
    await recent.waitFor()
    await loadEarlier.waitFor()
    const earlierBeforePaging = await earlier.count()
    const initialOlderRequests = older.length
    expect(earlierBeforePaging).toBe(0)
    expect(initialOlderRequests).toBe(0)
    expect(fixture.receipts.filter(row => row.path === '/api/prepare/v1/session.history'
      && row.runtimeId === remote.runtimeId && row.status === 200)).toHaveLength(1)
    const composer = page.locator('[data-composer-seat] textarea:enabled').last()
    await composer.fill('Retain this unsent history draft')
    await loadEarlier.click()
    await earlier.waitFor()
    expect(older).toHaveLength(1)
    expect(await earlier.count()).toBe(1)
    expect(await recent.count()).toBe(1)

    const computer = page.getByRole('region', { name: 'Compute computer', exact: true })
    const row = computer.locator(`[data-row-key^="session:"][data-row-key*="${sessionId}"]`)
    if (!await row.isVisible()) await computer.getByRole('button', { name: 'Compute computer', exact: true }).click()
    await historyIndexRequested.promise
    await computer.getByRole('button', { name: 'New conversation', exact: true }).click()
    await expect.poll(() => fixture.receipts.filter(row => row.path === '/api/prepare/v1/session.create'
      && row.runtimeId === remote.runtimeId && row.status === 200).length).toBe(1)
    await page.locator('[data-conversation-intent]').waitFor({ state: 'hidden' })
    const newDraft = await composer.inputValue()
    expect(newDraft).toBe('')
    releaseHistoryIndex.resolve()
    await row.click()
    await expect.poll(() => composer.inputValue()).toBe('Retain this unsent history draft')
    await recent.waitFor()
    const submits = fixture.receipts.filter(row => row.path === '/api/admit/v1/session.prompt').length
    expect(submits).toBe(0)
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./expected/personal-computers/prepared-history-demand.expected.md', import.meta.url)),
      [
        `Recent response: ${await recent.textContent()}`,
        `Earlier prompt before paging: ${earlierBeforePaging === 0 ? 'hidden' : 'visible'}`,
        `Earlier requests before paging: ${String(initialOlderRequests)}`,
        'Earlier prompt after paging: exactly once with its latest response',
        'New conversation: ready while the previous history index was pending',
        `Draft in new conversation: ${newDraft === '' ? 'empty' : newDraft}`,
        `Draft after returning: ${await composer.inputValue()}`,
        `Submitted messages: ${String(submits)}`,
      ].join('\n'), webSnapshotMode(),
    )
  } finally {
    releaseHistoryIndex.resolve()
    await browser.close()
    await fixture.close()
  }
}, 120_000)

it.each([true, false])('loads one authorized history tail and one post-subscription settings snapshot (saved: %s)', async (saved) => {
  const remote = personalTargets[1]!
  const sessionId = 'startup-managed-history'
  const fixture = await launchPersonalComputersFixture({ deferredEntry: true, sessionIds: ['unrelated-local-history', sessionId] })
  const world = fixture.worlds[1]!
  world.ctx.on('webserver/index-inject', (rows) => {
    rows.push({ kind: 'global', name: '__DSH_DOCUMENT_IDENTITY__', value: {
      version: 1, principalId: 7, runtimeTarget: { kind: 'personal', runtimeId: remote.runtimeId },
    } })
  })
  const browser = await computerBrowser()
  const tabs = await browser.newContext({ locale: 'en-US' })
  const entry = new URL(fixture.url)
  entry.searchParams.set('dshRuntime', remote.runtimeId)
  const holdDescribe = completionBarrier()
  const describeArrived = completionBarrier()
  const holdWorkspace = completionBarrier()
  const workspaceArrived = completionBarrier()
  const holdSessionList = completionBarrier()
  const started: string[] = []
  const settingsResponses: Response[] = []
  try {
    const page = await tabs.newPage()
    if (saved) await page.addInitScript(({ id, session }) => {
      sessionStorage.setItem(`dsh.sessions.current.v3.7.${id}.personal`, JSON.stringify({ sessionId: session }))
    }, { id: remote.runtimeId, session: sessionId })
    page.on('request', (request) => { started.push(new URL(request.url()).pathname) })
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/settings.describe') settingsResponses.push(response)
    })
    await page.route('**/api/host.describe*', async (route) => {
      describeArrived.resolve()
      await holdDescribe.promise
      await route.continue()
    })
    await page.route('**/api/workspace.list*', async (route) => {
      workspaceArrived.resolve()
      await holdWorkspace.promise
      await route.continue()
    })
    if (saved) await page.route('**/api/session.list*', async (route) => {
      await holdSessionList.promise
      await route.continue()
    })
    await page.goto(entry.href)
    await describeArrived.promise
    const prompt = page.getByText('Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.', { exact: true })
    const prepared = () => fixture.receipts.filter(row => row.path === '/api/prepare/v1/session.history'
      && row.runtimeId === remote.runtimeId && row.status === 200)
    if (saved) {
      await prompt.waitFor()
      await expect.poll(() => prepared().length).toBe(1)
      const composer = page.locator('textarea:enabled').last()
      await composer.fill('Draft before Host verification')
      await composer.press('Enter')
      await expect.poll(() => composer.inputValue()).toBe('Draft before Host verification')
      expect(started.some(path => path === '/api/admit/v1/session.prompt' || path === '/api/session.prompt')).toBe(false)
      expect(fixture.draftReceipts).toHaveLength(0)
    }
    const historyVisibleBeforeDescribe = await prompt.isVisible()
    expect(historyVisibleBeforeDescribe).toBe(saved)
    // The first settings read is taken behind the subscription, including a
    // commit made before it opens. Neither Session nor Workspace content is
    // presumed from the fact that the HTML and bundle finished loading.
    await world.ctx.settings.update(settingsNamespace('ui-conversation'), { chatFontSize: 17 })
    expect(started.filter(path => path === '/api/settings.describe')).toHaveLength(0)
    holdDescribe.resolve()
    await workspaceArrived.promise
    if (saved) await expect.poll(() => prepared().length).toBe(1)
    else expect(prepared()).toHaveLength(0)
    const historyVisibleBeforeWorkspace = await prompt.isVisible()
    expect(historyVisibleBeforeWorkspace).toBe(saved)
    holdWorkspace.resolve()
    holdSessionList.resolve()
    await prompt.waitFor()
    if (saved) {
      await expect.poll(() => page.locator('textarea:enabled').last().inputValue()).toBe('Draft before Host verification')
      await expect.poll(() => fixture.draftReceipts.some(row => row.node === 1 && row.method === 'PUT' && row.status === 200 && row.hasText)).toBe(true)
    }
    await expect.poll(() => prepared().length).toBe(1)
    expect(started.filter(path => path === '/api/session.history')).toHaveLength(0)
    await expect.poll(() => settingsResponses.length).toBe(1)
    expect(started.filter(path => path === '/api/settings.describe')).toHaveLength(1)
    const chatFontSize = async (response: Response): Promise<number | undefined> => {
      const body = await response.json() as { result: { value: { namespaces: { ns: string; value: { chatFontSize?: number } }[] } } }
      return body.result.value.namespaces.find(namespace => namespace.ns === 'ui-conversation')?.value.chatFontSize
    }
    expect(await chatFontSize(settingsResponses[0]!)).toBe(17)
    await world.ctx.settings.update(settingsNamespace('ui-conversation'), { chatFontSize: 18 })
    await expect.poll(() => settingsResponses.length).toBe(2)
    expect(await chatFontSize(settingsResponses[1]!)).toBe(18)
    expect(fixture.calls.get(personalTargets[0]!.runtimeId) ?? 0).toBe(0)
    expect(world.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
    await compareOrRefreshGolden(fileURLToPath(new URL(`./expected/personal-computers/startup-${saved ? 'saved' : 'default'}-history.expected.md`, import.meta.url)),
      `History visible before Host describe: ${String(historyVisibleBeforeDescribe)}\nPrepared history while Workspace is pending: ${saved ? 'one' : 'none'}\nHistory visible before Workspace: ${String(historyVisibleBeforeWorkspace)}\nAuthorized prompt: ${await prompt.textContent()}\nPrepared history requests: ${String(prepared().length)}\nOrdinary initial history requests: 0\nSubmitted messages: 0\nHost settings first snapshot: 17 after subscription\nHost settings later snapshot: 18 after change`, webSnapshotMode())
  } finally {
    holdDescribe.resolve()
    holdWorkspace.resolve()
    holdSessionList.resolve()
    await tabs.close()
    await browser.close()
    await fixture.close()
  }
}, 120_000)

it('recovers a remote bootstrap script failure and transfers each draft to its original Session', async () => {
  const target = personalTargets[1]!
  const savedSessionId = 'startup-remote-restored'
  const fixture = await launchPersonalComputersFixture({ deferredEntry: true, sessionIds: ['startup-local-unused', savedSessionId] })
  fixture.worlds[1]!.ctx.on('webserver/index-inject', (rows) => {
    rows.push({ kind: 'global', name: '__DSH_DOCUMENT_IDENTITY__', value: {
      version: 1, principalId: 7, runtimeTarget: { kind: 'personal', runtimeId: target.runtimeId },
    } })
  })
  const browser = await computerBrowser()
  const tabs = await browser.newContext({ locale: 'en-US' })
  const entry = new URL(fixture.url)
  entry.searchParams.set('dshRuntime', target.runtimeId)
  const held = [completionBarrier(), completionBarrier()]
  const arrived = [completionBarrier(), completionBarrier()]
  const holdVendor = completionBarrier()
  const vendorAsset = /\/assets\/vendor-[a-z0-9_-]+\.js$/iu
  const evidence: string[] = []
  const browserErrors: string[] = []
  const switchAccount = completionBarrier()
  const bootstrapStatuses: number[] = []
  let speculativeBeforeBootstrap = 0
  let rejectBootstrapOnce = true
  const isBootstrapScript = (url: URL): boolean => url.pathname === '/plugins/combo.js'
    && url.search.startsWith('??@deepseek-ai/dsh-client-modules/client.js')
  try {
    const pages = await Promise.all([tabs.newPage(), tabs.newPage()])
    for (const [i, page] of pages.entries()) {
      page.on('pageerror', error => browserErrors.push(error.message))
      page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') browserErrors.push(message.text()) })
      await page.addInitScript(({ runtimeId, sessionId }) => {
        sessionStorage.setItem(`dsh.sessions.current.v3.7.${runtimeId}.personal`, JSON.stringify({ sessionId }))
      }, { runtimeId: target.runtimeId, sessionId: savedSessionId })
      await page.route(url => url.pathname === '/' && url.searchParams.get('dshBootstrap') === '1', async (route) => {
        arrived[i]!.resolve()
        await held[i]!.promise
        await route.continue()
      })
      if (i === 0) {
        page.on('request', (request) => {
          const url = new URL(request.url())
          if (url.pathname === '/plugins/combo.js' && !isBootstrapScript(url) && !bootstrapStatuses.includes(200)) {
            speculativeBeforeBootstrap++
          }
        })
        page.on('response', (response) => {
          if (isBootstrapScript(new URL(response.url()))) bootstrapStatuses.push(response.status())
        })
        await page.route(isBootstrapScript, async (route) => {
          if (rejectBootstrapOnce) {
            rejectBootstrapOnce = false
            await route.fulfill({ status: 503, contentType: 'application/json',
              headers: { 'cache-control': 'no-store' }, body: '{"error":"node-service/busy"}' })
          } else await route.continue()
        })
      }
      if (i === 0) await page.route(vendorAsset, async (route) => {
        await holdVendor.promise
        await route.continue()
      })
      await Promise.all([
        page.goto(entry.href, { waitUntil: 'commit' }),
        ...(i === 0 ? [page.waitForRequest(vendorAsset)] : []),
      ])
      const early = page.locator('[data-dsh-startup-draft]')
      const input = early.getByRole('textbox', { name: 'Unsent draft · Compute computer' })
      await input.fill(`Tab ${String(i + 1)} startup text`, { timeout: 5_000 })
      await arrived[i]!.promise
      expect(await early.getByRole('status').textContent()).toContain('Opening your workspace')
      expect(await early.getByRole('button').count()).toBe(0)
      expect(await page.locator('[data-composer-seat]').count()).toBe(0)
      if (i === 0) holdVendor.resolve()
    }
    expect(fixture.calls.get(personalTargets[0]!.runtimeId) ?? 0).toBe(0)
    const composers = pages.map(page => page.locator('[data-composer-seat] textarea:enabled'))
    for (const [i, page] of pages.entries()) {
      held[i]!.resolve()
      try {
        await expect.poll(async () => {
          const box = composers[i]!.first()
          return await box.count() ? await box.inputValue() : ''
        }, { timeout: 15_000 }).toBe(`Tab ${String(i + 1)} startup text`)
      } catch (error) {
        const status = await page.locator('[data-dsh-boot], [data-dsh-startup-draft]').allTextContents()
        const details = { status, browserErrors, receipts: fixture.receipts, draftReceipts: fixture.draftReceipts }
        throw new Error(JSON.stringify(details), { cause: error })
      }
      await page.locator('[data-dsh-startup-draft]').waitFor({ state: 'hidden' })
      evidence.push(`Tab ${String(i + 1)}: editable before remote boot, restored ${await composers[i]!.first().inputValue()}`)
    }
    await expect.poll(() => fixture.receipts.filter(row => row.path === '/api/prepare/v1/session.history'
      && row.runtimeId === target.runtimeId && row.status === 200).length).toBe(2)
    expect(bootstrapStatuses).toEqual([503, 200])
    expect(speculativeBeforeBootstrap).toBe(0)
    expect(fixture.receipts.filter(row => row.path === '/api/admit/v1/session.prompt')).toHaveLength(0)
    const withdrawn = await tabs.newPage()
    await withdrawn.route(vendorAsset, route => route.abort())
    await withdrawn.route(url => url.pathname === '/' && url.searchParams.get('dshBootstrap') === '1', async (route) => {
      await switchAccount.promise
      await route.fulfill({ status: 409, contentType: 'application/json',
        headers: { 'x-dsh-principal-id': '8' }, body: '{"error":"account-changed"}' })
    })
    await Promise.all([
      withdrawn.goto(entry.href, { waitUntil: 'commit' }),
      withdrawn.waitForEvent('requestfailed', request => vendorAsset.test(request.url())),
    ])
    const oldAccountDraft = withdrawn.locator('[data-dsh-startup-draft]')
    await oldAccountDraft.getByRole('textbox').fill('Unsent on the previous account')
    switchAccount.resolve()
    await withdrawn.getByText('The account changed while opening this Runtime').waitFor()
    await oldAccountDraft.waitFor({ state: 'hidden' })
    expect(await withdrawn.locator('[data-composer-seat]').count()).toBe(0)
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/personal-computers/deferred-entry.expected.md', import.meta.url)),
      `Tab 1: editable while rendering assets are pending\n${evidence.join('\n')}\nBootstrap transport: 503 then 200, before speculative plugin requests\nPrepared history requests: 2\nSubmitted messages: 0\nAccount switch during rendering asset failure: startup input withdrawn`, webSnapshotMode())
  } finally {
    holdVendor.resolve()
    for (const block of held) block.resolve()
    switchAccount.resolve()
    await tabs.close()
    await browser.close()
    await fixture.close()
  }
}, 120_000)
