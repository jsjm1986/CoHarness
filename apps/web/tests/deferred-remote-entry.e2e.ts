/** Real remote document bootstrap and tab-local draft adoption with a held node. */
import { completionBarrier } from './support.ts'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Response } from 'playwright'
import { computerBrowser } from './computer-browser.ts'
import { launchPersonalComputersFixture, personalTargets } from './personal-computers-fixture.ts'
import { compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'

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
    // The first settings read is taken behind the subscription, including a
    // commit made before it opens. Neither Session nor Workspace content is
    // presumed from the fact that the HTML and bundle finished loading.
    await world.ctx.settings.update(settingsNamespace('ui-conversation'), { chatFontSize: 17 })
    expect(started.filter(path => path === '/api/settings.describe')).toHaveLength(0)
    holdDescribe.resolve()
    await workspaceArrived.promise
    const prepared = () => fixture.receipts.filter(row => row.path === '/api/prepare/v1/session.history'
      && row.runtimeId === remote.runtimeId && row.status === 200)
    if (saved) await expect.poll(() => prepared().length).toBe(1)
    else expect(prepared()).toHaveLength(0)
    const prompt = page.getByText('Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.', { exact: true })
    const historyVisibleBeforeWorkspace = await prompt.isVisible()
    expect(historyVisibleBeforeWorkspace).toBe(false)
    holdWorkspace.resolve()
    holdSessionList.resolve()
    await prompt.waitFor()
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
      `Prepared history while Workspace is pending: ${saved ? 'one' : 'none'}\nHistory visible before Workspace: ${String(historyVisibleBeforeWorkspace)}\nAuthorized prompt: ${await prompt.textContent()}\nPrepared history requests: ${String(prepared().length)}\nOrdinary initial history requests: 0\nSubmitted messages: 0\nHost settings first snapshot: 17 after subscription\nHost settings later snapshot: 18 after change`, webSnapshotMode())
  } finally {
    holdDescribe.resolve()
    holdWorkspace.resolve()
    holdSessionList.resolve()
    await tabs.close()
    await browser.close()
    await fixture.close()
  }
}, 120_000)

it('edits two drafts before remote boot and transfers each to its original Session', async () => {
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
  const evidence: string[] = []
  const browserErrors: string[] = []
  const switchAccount = completionBarrier()
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
      await page.goto(entry.href)
      await arrived[i]!.promise
      const early = page.locator('[data-dsh-startup-draft]')
      const input = early.getByRole('textbox', { name: 'Unsent draft · Compute computer' })
      await input.fill(`Tab ${String(i + 1)} startup text`)
      expect(await early.getByRole('status').textContent()).toContain('Opening your workspace')
      expect(await early.getByRole('button').count()).toBe(0)
      expect(await page.locator('[data-composer-seat]').count()).toBe(0)
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
    expect(fixture.receipts.filter(row => row.path === '/api/prepare/v1/session.history'
      && row.runtimeId === target.runtimeId && row.status === 200)).toHaveLength(2)
    expect(fixture.receipts.filter(row => row.path === '/api/admit/v1/session.prompt')).toHaveLength(0)
    const withdrawn = await tabs.newPage()
    await withdrawn.route(url => url.pathname === '/' && url.searchParams.get('dshBootstrap') === '1', async (route) => {
      await switchAccount.promise
      await route.fulfill({ status: 409, contentType: 'application/json',
        headers: { 'x-dsh-principal-id': '8' }, body: '{"error":"account-changed"}' })
    })
    await withdrawn.goto(entry.href)
    const oldAccountDraft = withdrawn.locator('[data-dsh-startup-draft]')
    await oldAccountDraft.getByRole('textbox').fill('Unsent on the previous account')
    switchAccount.resolve()
    await withdrawn.getByText('The account changed while opening this Runtime').waitFor()
    await oldAccountDraft.waitFor({ state: 'hidden' })
    expect(await withdrawn.locator('[data-composer-seat]').count()).toBe(0)
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/personal-computers/deferred-entry.expected.md', import.meta.url)),
      `${evidence.join('\n')}\nPrepared history requests: 2\nSubmitted messages: 0\nAccount switch: startup input withdrawn`, webSnapshotMode())
  } finally {
    for (const block of held) block.resolve()
    switchAccount.resolve()
    await tabs.close()
    await browser.close()
    await fixture.close()
  }
}, 120_000)
