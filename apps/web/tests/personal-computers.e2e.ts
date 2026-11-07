/** Unified personal navigation through real independent Hosts and their shipped client plugins. @module */
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { launchPersonalComputersFixture, personalTargets } from './personal-computers-fixture.ts'
import { acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden, watchConsole, webSnapshotMode } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

it('retains a pending New Session and its origin draft across transport renewal', async () => {
  const fixture = await launchPersonalComputersFixture()
  const browser = await chromium.launch(process.env['DSH_TEST_BROWSER_EXECUTABLE'] ? { executablePath: process.env['DSH_TEST_BROWSER_EXECUTABLE'] } : {})
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
  const warnings = watchConsole(page)
  const held = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const delivered = Promise.withResolvers<undefined>()
  onTestFailed(() => saveFailureShot(page, 'personal-computers-renewal'))
  try {
    await page.goto(fixture.url, { waitUntil: 'networkidle' })
    const office = page.getByRole('region', { name: 'Office computer', exact: true })
    const heading = office.getByRole('button', { name: 'Office computer', exact: true })
    const firstRow = office.locator('[data-row-key^="session:"]').first()
    const workspaceRow = office.getByText('Office work', { exact: true })
    await expect.poll(async () => {
      // The collapsed default tracks the active computer and remounts drop
      // explicit expansion, so re-arm the click inside the poll.
      if (await heading.getAttribute('aria-expanded') !== 'true') await heading.click()
      return (await firstRow.isVisible()) || (await workspaceRow.isVisible())
    }, { timeout: 60_000 }).toBe(true)
    if (!await firstRow.isVisible()) await workspaceRow.click()
    await firstRow.click()
    const input = page.locator('textarea').first()
    await page.locator('[data-conversation-intent]').waitFor({ state: 'hidden' })
    await input.fill('Keep the original draft across transport renewal')
    await page.route(/\/api\/prepare\/v1\/session\.create(?:\?.*)?$/, async (route) => {
      const response = await route.fetch()
      held.resolve(undefined)
      await release.promise
      await route.fulfill({ response })
      delivered.resolve(undefined)
    })
    await office.getByRole('button', { name: /New session in /i }).click()
    await held.promise
    const editor = page.locator('[data-conversation-intent] textarea')
    expect(await editor.isEditable()).toBe(true)
    expect(await editor.inputValue()).toBe('')
    await editor.press('Enter')
    expect(fixture.receipts.filter(item => item.path === '/api/admit/v1/session.prompt')).toEqual([])
    await editor.fill('Text on the intended new conversation')
    const warningStart = warnings.warnings.length
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/account/api/context')
    fixture.renewEventStreams(personalTargets[0]!.runtimeId)
    await (await refreshed).finished()
    expect(await editor.isEditable()).toBe(true)
    expect(await editor.inputValue()).toBe('Text on the intended new conversation')
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/personal-computers/renewal-preparing.expected.md', import.meta.url)),
      await captureStableAria(page, '[data-conversation-intent]', fixture.worlds[0]!.workspaceCwd), webSnapshotMode())
    release.resolve(undefined)
    await delivered.promise
    await page.locator('textarea[placeholder="Describe what you want to build"]').waitFor()
    await expect.poll(() => page.locator('textarea').first().inputValue()).toBe('Text on the intended new conversation')
    expect(await page.evaluate(() => Object.entries(sessionStorage).some(([key, value]) =>
      key.startsWith('dsh.conversation.chat.') && typeof value === 'string' && value.includes('Keep the original draft across transport renewal')))).toBe(false)
    await office.getByText('Office conversation', { exact: true }).click()
    await expect.poll(() => page.locator('textarea').first().inputValue(), { timeout: 10_000 }).toBe('Keep the original draft across transport renewal')
    acknowledgeReloadConnectionLoss(warnings, warningStart)
    expect(warnings.pageErrors).toEqual([])
  } finally {
    release.resolve(undefined)
    await page.close()
    await browser.close()
    await fixture.close()
  }
}, 120_000)

it('reads project names only from the chosen computer in the authorized space picker', async () => {
  const fixture = await launchPersonalComputersFixture({ projectMetadata: true })
  const browser = await chromium.launch(process.env['DSH_TEST_BROWSER_EXECUTABLE'] ? { executablePath: process.env['DSH_TEST_BROWSER_EXECUTABLE'] } : {})
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
  try {
    await page.goto(fixture.url, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Switch personal or project scope', exact: true }).click()
    const selector = page.getByRole('group', { name: 'Switch personal or project scope', exact: true })
    const choose = selector.getByRole('combobox', { name: 'Load project names' })
    await choose.waitFor()
    expect(fixture.projectReads).toEqual([])
    expect(await selector.getByText('unverified control-plane name', { exact: true }).count()).toBe(0)
    await choose.selectOption(personalTargets[1]!.nodeId)
    await selector.getByText('Compute project', { exact: true }).waitFor()
    expect(fixture.projectReads).toEqual([[18]])
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/personal-computers/owner-projects.expected.md', import.meta.url)),
      await captureStableAria(page, '[role="group"][aria-label="Switch personal or project scope"]', fixture.worlds[0]!.workspaceCwd), webSnapshotMode())
    expect(await selector.getByText('Office project', { exact: true }).count()).toBe(0)
    expect(fixture.preparations.size).toBe(0)
    expect(fixture.calls.get(personalTargets[1]!.runtimeId) ?? 0).toBe(0)
  } finally { await browser.close(); await fixture.close() }
}, 60_000)

it('opens an authorized create tail inline and falls back on the same Session when an older node omits the page', async () => {
  const fixture = await launchPersonalComputersFixture()
  const browser = await chromium.launch(process.env['DSH_TEST_BROWSER_EXECUTABLE'] ? { executablePath: process.env['DSH_TEST_BROWSER_EXECUTABLE'] } : {})
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
  const creates: string[] = [], reads: string[] = [], unguardedReads: string[] = []
  let omit = false
  try {
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() !== 'POST' || !['/api/session.history', '/api/prepare/v1/session.history'].includes(path)) return
      const { payload } = request.postDataJSON() as { payload: { sessionId: string } }
      ;(path === '/api/session.history' ? unguardedReads : reads).push(payload.sessionId)
    })
    await page.route('**/api/prepare/v1/session.create?**', async (route) => {
      const response = await route.fetch()
      const body = await response.json() as { result: { value: { sessionId: string; initialHistory?: { records: unknown[] } } } }
      expect(body.result.value.initialHistory?.records).toBeInstanceOf(Array)
      creates.push(body.result.value.sessionId)
      if (omit) delete body.result.value.initialHistory
      await route.fulfill({ response, json: body })
    })
    await page.goto(fixture.url, { waitUntil: 'networkidle' })
    const computer = page.getByRole('region', { name: 'Compute computer', exact: true })
    await computer.getByRole('button', { name: 'Compute computer', exact: true }).click()
    for (const fallback of [false, true]) {
      omit = fallback
      const received = page.waitForResponse(r => new URL(r.url()).pathname === '/api/prepare/v1/session.create')
      await computer.getByRole('button', { name: 'New conversation', exact: true }).click()
      await received
      await page.locator('[data-conversation-intent]').waitFor({ state: 'hidden' })
      await page.locator('textarea:enabled').last().fill(fallback ? 'Fallback draft' : 'Inline draft')
      const id = creates.at(-1)
      expect(reads.filter(value => value === id)).toHaveLength(fallback ? 1 : 0)
      expect(unguardedReads.filter(value => value === id)).toHaveLength(0)
      expect(creates).toHaveLength(fallback ? 2 : 1)
    }
    expect(new Set(creates).size).toBe(2)
  } finally { await browser.close(); await fixture.close() }
}, 120_000)

it('confirms an ambiguous send on the original personal Runtime without resubmitting the turn', async () => {
  const file = fileURLToPath(new URL('./snapshots/lifecycle-chrome/session.jsonl', import.meta.url))
  const fixture = await launchPersonalComputersFixture({ remoteReplay: { file, children: [] } })
  const browser = await chromium.launch(process.env['DSH_TEST_BROWSER_EXECUTABLE'] ? { executablePath: process.env['DSH_TEST_BROWSER_EXECUTABLE'] } : {})
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
  const target = personalTargets[1]!.runtimeId
  const sends: { sessionId: string; requestId: string }[] = []
  try {
    await page.route('**/api/admit/v1/session.prompt?**', async (route) => {
      const original = route.request().postDataJSON() as { payload: { sessionId: string; requestId: string } }
      const response = await route.fetch()
      const body = await response.json() as { rpcId: string; result: unknown }
      expect(body.result).toEqual({ ok: true, value: { accepted: true } })
      const { sessionId, requestId } = original.payload
      sends.push({ sessionId, requestId })
      await route.fulfill({ response, json: { ...body, result: { ok: false, error: {
        code: 'prompt-durability-unavailable', message: 'Unconfirmed test receipt', details: { sessionId },
      } } } })
    })
    await page.goto(fixture.url, { waitUntil: 'networkidle' })
    const computer = page.getByRole('region', { name: 'Compute computer', exact: true })
    await computer.getByRole('button', { name: 'Compute computer', exact: true }).click()
    await computer.getByRole('button', { name: 'New conversation', exact: true }).click()
    await page.locator('[data-conversation-intent]').waitFor({ state: 'hidden' })
    const editor = page.locator('textarea:enabled').last()
    await editor.fill('Recover this durable message')
    const resumeFrames = await page.evaluateHandle(() => {
      const request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame
      const pending = new Map<number, FrameRequestCallback>()
      let next = -1
      window.requestAnimationFrame = (fn) => { pending.set(--next, fn); return next }
      window.cancelAnimationFrame = (id) => { if (!pending.delete(id)) cancel.call(window, id) }
      return () => {
        window.requestAnimationFrame = request
        window.cancelAnimationFrame = cancel
        for (const callback of pending.values()) request.call(window, callback)
      }
    })
    const status = await (async () => {
      try {
        const [response] = await Promise.all([
          page.waitForResponse(row => new URL(row.url()).pathname === '/api/admit/v1/session.status'),
          page.keyboard.press('Enter'),
        ])
        return response
      } finally { await resumeFrames.evaluate((resume) =>{  resume() }); await resumeFrames.dispose() }
    })()
    expect(new URL(status.url()).searchParams.get('dshRuntime')).toBe(target)
    expect(status.headers()['x-dsh-runtime-id']).toBe(target)
    expect(status.request().headers()['x-dsh-expected-principal-id']).toBe('7')
    expect(sends).toHaveLength(1)
    expect((status.request().postDataJSON() as { payload: unknown }).payload).toEqual({ ...sends[0], confirmInput: true })
    expect((await status.json() as { result: unknown }).result).toEqual({ ok: true,
      value: { state: 'accepted', inputProof: expect.stringMatching(/^[0-9a-f]{64}$/u) as object } })
    await expect.poll(() => editor.inputValue()).toBe('')
    expect(fixture.receipts.filter(row => row.path === '/api/admit/v1/session.prompt').map(row => row.runtimeId)).toEqual([target])
  } finally { await browser.close(); await fixture.close() }
}, 120_000)

it('browses twenty cold computers and keeps personal conversations, drafts and tabs independent', async () => {
  const fixture = await launchPersonalComputersFixture()
  await mkdir(fileURLToPath(new URL('../../../.artifacts/multi-computer-validation/', import.meta.url)), { recursive: true })
  const browser = await chromium.launch(process.env['DSH_TEST_BROWSER_EXECUTABLE'] ? { executablePath: process.env['DSH_TEST_BROWSER_EXECUTABLE'] } : {})
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US', colorScheme: 'dark' })
  const page = await context.newPage(), warnings = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'personal-computers'))
  try {
    await page.goto(fixture.url, { waitUntil: 'networkidle' })
    const office = page.getByRole('region', { name: 'Office computer', exact: true })
    const compute = page.getByRole('region', { name: 'Compute computer', exact: true })
    await office.waitFor()
    const composer = () => page.locator('textarea:enabled').last()
    const openOffice = async (owner: typeof page): Promise<void> => {
      const section = owner.getByRole('region', { name: 'Office computer', exact: true })
      const heading = section.getByRole('button', { name: 'Office computer', exact: true })
      const firstRow = section.locator('[data-row-key^="session:"]').first()
      const workspaceRow = section.getByText('Office work', { exact: true })
      await expect.poll(async () => {
        if (await heading.getAttribute('aria-expanded') !== 'true') await heading.click()
        return (await firstRow.isVisible()) || (await workspaceRow.isVisible())
      }, { timeout: 60_000 }).toBe(true)
      if (!await firstRow.isVisible()) await workspaceRow.click()
      await section.locator('[data-row-key^="session:"]').first().click()
    }
    await openOffice(page)
    await composer().fill('Office draft stays on Office')
    const other = await context.newPage()
    await other.goto(fixture.url, { waitUntil: 'networkidle' })
    await openOffice(other)
    await other.locator('textarea:enabled').last().fill('Independent tab draft')
    expect(fixture.calls.get(personalTargets[1]!.runtimeId) ?? 0).toBe(0)
    await compute.getByRole('button', { name: 'Compute computer', exact: true }).click()
    await compute.getByText('Compute work', { exact: true }).waitFor()
    expect(fixture.calls.get(personalTargets[1]!.runtimeId) ?? 0).toBe(0)
    expect(fixture.preparations.get(personalTargets[1]!.runtimeId) ?? 0).toBe(0)
    await compute.getByText('Compute work', { exact: true }).click()
    await compute.locator('[data-row-key^="session:"]').first().click()
    await expect.poll(() => composer().inputValue()).toBe('')
    expect(fixture.calls.get(personalTargets[1]!.runtimeId)).toBeGreaterThan(0)
    await expect.poll(() => fixture.receipts.filter(row => row.runtimeId === personalTargets[1]!.runtimeId && row.path === '/api/prepare/v1/session.history' && row.status === 200).length).toBe(1)
    expect(fixture.preparations.get(personalTargets[1]!.runtimeId) ?? 0).toBe(0)
    await composer().fill('Compute draft stays on Compute')
    expect(await other.locator('textarea:enabled').last().inputValue()).toBe('Independent tab draft')
    await office.getByText('Office conversation', { exact: true }).click()
    await expect.poll(() => composer().inputValue()).toBe('Office draft stays on Office')
    await compute.locator('[data-row-key^="session:"]').first().click()
    await expect.poll(() => composer().inputValue()).toBe('Compute draft stays on Compute')
    expect(new URL(page.url()).searchParams.get('dshRuntime')).toBe(personalTargets[0]!.runtimeId)
    const saved = await page.evaluate(() => sessionStorage.getItem('dsh.personal.current.v1.account:7.runtime:10000000-0000-4000-8000-000000000001'))
    expect(saved).toContain(personalTargets[1]!.runtimeId)
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/personal-computers/groups.expected.md', import.meta.url)),
      await captureStableAria(page, 'section[aria-label="Compute computer"]', fixture.worlds[1]!.workspaceCwd), webSnapshotMode())
    const warningStart = warnings.warnings.length
    const beforeReload = await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.endsWith('.node-draft.v1')).length)
    await page.reload({ waitUntil: 'networkidle' })
    acknowledgeReloadConnectionLoss(warnings, warningStart)
    try { await expect.poll(() => composer().inputValue(), { timeout: 10_000 }).toBe('Compute draft stays on Compute') }
    catch (error) {
      const afterReload = await page.evaluate(() => ({ pointers: Object.keys(sessionStorage).filter(key => key.endsWith('.node-draft.v1')).length,
        preparing: Boolean(document.querySelector('[data-conversation-intent]')) }))
      console.error('Acknowledged draft recovery', { beforeReload, afterReload, receipts: fixture.draftReceipts })
      throw error
    }
    expect(await other.locator('textarea:enabled').last().inputValue()).toBe('Independent tab draft')
    const desktopShot = fileURLToPath(new URL('../../../.artifacts/multi-computer-validation/personal-desktop.jpg', import.meta.url))
    await page.screenshot({ path: desktopShot, type: 'jpeg', quality: 85, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('light')
    await page.screenshot({ path: fileURLToPath(new URL('../../../.artifacts/multi-computer-validation/personal-light.jpg', import.meta.url)),
      type: 'jpeg', quality: 85, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.getByRole('button', { name: 'Switch personal or project scope', exact: true }).click()
    const spaces = page.getByRole('dialog', { name: 'Switch personal or project scope', exact: true })
    expect(await spaces.getByRole('button', { name: /^Personal/ }).count()).toBe(1)
    expect(await spaces.getByText('Office computer', { exact: true }).count()).toBe(0)
    expect(await spaces.getByText('Compute computer', { exact: true }).count()).toBe(0)
    await spaces.getByRole('button', { name: 'Close', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
    const mobileComputer = page.getByRole('region', { name: 'Compute computer', exact: true })
      .getByRole('button', { name: 'Compute computer', exact: true })
    await expect.poll(async () => (await page.locator('[data-sidebar-root]').boundingBox())?.x).toBeGreaterThanOrEqual(-0.5)
    await expect.poll(async () => (await mobileComputer.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: fileURLToPath(new URL('../../../.artifacts/multi-computer-validation/personal-mobile.jpg', import.meta.url)),
      type: 'jpeg', quality: 85, animations: 'disabled' })
    expect(warnings.pageErrors).toEqual([])
    expect(warnings.warnings).toEqual([])
  } catch (error) {
    await saveFailureShot(page, 'personal-computers')
    console.error((await page.locator('body').innerText()).slice(0, 6000))
    console.error('Isolated target receipts', fixture.receipts.slice(-20))
    throw error
  } finally {
    const results = [await context.close().then(() => ({ status: 'fulfilled' as const }), (reason: unknown) => ({ status: 'rejected' as const, reason })),
      await browser.close().then(() => ({ status: 'fulfilled' as const }), (reason: unknown) => ({ status: 'rejected' as const, reason }))]
    await fixture.close()
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length) throw new AggregateError(failures, 'Personal computer browser cleanup failed')
  }
}, 120_000)
