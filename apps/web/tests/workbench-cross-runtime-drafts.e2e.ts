/** Restore and submit independent Workbench drafts through two isolated personal Web Hosts. */
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { clientSessionKey, type ClientRuntimeTarget } from '@deepseek-ai/dsh-host-apiproxy/api'
import { SessionId } from '@deepseek-ai/dsh-session'
import { computerBrowser, type Browser, type BrowserContext } from './computer-browser.ts'
import { launchPersonalComputersFixture, personalTargets } from './personal-computers-fixture.ts'
import { compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'
import { saveFailureShot } from './support.ts'
import { expectViewportFit } from './responsive-browser.ts'

it('restores both computer panes without an orphan composer and sends each draft to its original Session', async () => {
  const file = fileURLToPath(new URL('./snapshots/lifecycle-chrome/session.jsonl', import.meta.url))
  const replay = { file, children: [] }
  const fixture = await launchPersonalComputersFixture({ workbench: true, localReplay: replay, remoteReplay: replay })
  const session = SessionId('same-personal-session')
  const workbenchName = 'Office and Compute cross-computer draft recovery'
  const owners = personalTargets.slice(0, 2).map((target, index) => ({
    target, key: clientSessionKey(target as ClientRuntimeTarget, session),
    title: index === 0 ? 'Office conversation' : 'Compute conversation',
    draft: index === 0 ? 'Keep this Office draft on Office' : 'Keep this Compute draft on Compute',
  }))
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  const failures: unknown[] = []
  try {
    browser = await computerBrowser()
    context = await browser.newContext({ locale: 'en-US', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const submissions: { runtimeId: string | null; sessionId: string }[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (request.method() !== 'POST' || url.pathname !== '/api/admit/v1/session.prompt') return
      const body = request.postDataJSON() as { payload: { sessionId: string } }
      submissions.push({ runtimeId: url.searchParams.get('dshRuntime'), sessionId: body.payload.sessionId })
    })
    const pane = (index: number) => page.locator(`[data-session-pane="${owners[index]!.key}"]`)
    const editor = (index: number) => pane(index).locator('textarea:enabled')
    const evidence: string[] = []
    try {
      await page.goto(fixture.url, { waitUntil: 'domcontentloaded' })
      // A real sidebar selection supplies the personal recovery pointer alongside the saved Workbench.
      const selected = owners[1]!
      const group = page.getByRole('region', { name: selected.target.nodeName, exact: true })
      const heading = group.getByRole('button', { name: selected.target.nodeName, exact: true })
      if (await heading.getAttribute('aria-expanded') !== 'true') await heading.click()
      const row = group.getByText(selected.title, { exact: true })
      if (!await row.isVisible()) await group.getByText('Compute work', { exact: true }).click()
      await row.click()
      const pointer = `dsh.personal.current.v1.account:7.runtime:${owners[0]!.target.runtimeId}`
      await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), pointer)).toBe(
        JSON.stringify({ sessionId: selected.key, nodeId: selected.target.nodeId }))
      await page.getByRole('button', { name: 'Select workbench', exact: true }).click()
      await page.getByRole('menuitem', { name: 'New workbench', exact: true }).click()
      const create = page.getByRole('dialog', { name: 'New workbench', exact: true })
      await create.getByRole('textbox', { name: 'Workbench name', exact: true }).fill(workbenchName)
      await create.getByRole('button', { name: 'Confirm', exact: true }).click()
      await create.waitFor({ state: 'hidden' })
      for (const [index, owner] of owners.entries()) {
        if (await pane(index).count() > 0) continue
        await page.getByRole('button', { name: 'Add conversation', exact: true }).first().click()
        const dialog = page.getByRole('dialog', { name: 'Add conversation', exact: true })
        await dialog.getByRole('button', { name: 'Workspace', exact: true }).click()
        await page.getByRole('menu').getByText(owner.target.nodeName, { exact: true }).first().click()
        await dialog.getByRole('button', { name: new RegExp(owner.title) }).click()
        await dialog.waitFor({ state: 'hidden' })
      }
      for (const [index, owner] of owners.entries()) {
        const saved = page.waitForResponse((response) => {
          const url = new URL(response.url())
          if (response.request().method() !== 'PUT' || !url.pathname.startsWith('/account/api/drafts/')
            || url.searchParams.get('dshRuntime') !== owner.target.runtimeId || response.status() !== 200) return false
          const { text } = response.request().postDataJSON() as { text: string }
          if (text === '') return false
          const saved = JSON.parse(text) as { version: number; draft: string | { text: string } }
          return saved.version === 1 && (typeof saved.draft === 'string' ? saved.draft : saved.draft.text) === owner.draft
        })
        await Promise.all([saved, editor(index).fill(owner.draft)])
      }
      await page.reload({ waitUntil: 'networkidle' })
      await expect.poll(() => page.locator('[data-conversation-intent]').count()).toBe(0)
      await expect.poll(() => page.locator('[data-session-pane]').count()).toBe(2)
      const toolbar = page.locator('[data-workbench-toolbar]')
      await toolbar.getByText(workbenchName, { exact: true }).waitFor()
      await expectViewportFit(page, toolbar)
      const spacing = await toolbar.evaluate((element) => {
        const title = element.firstElementChild!.getBoundingClientRect()
        const tools = element.querySelector('[data-workbench-tools-host]')!.getBoundingClientRect()
        const sameRow = Math.min(title.bottom, tools.bottom) > Math.max(title.top, tools.top)
        return { sameRow, gap: sameRow ? tools.left - title.right : tools.top - title.bottom }
      })
      expect(spacing.gap, JSON.stringify(spacing)).toBeGreaterThanOrEqual(spacing.sameRow ? 8 : 0)
      evidence.push(`Workbench title: ${await toolbar.getByText(workbenchName, { exact: true }).textContent()}; current-conversation controls remain separated`)
      const shots = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
      if (shots !== undefined) {
        await mkdir(shots, { recursive: true })
        await page.screenshot({ path: join(shots, 'workbench-cross-runtime-long-name-restored.png'), animations: 'disabled' })
      }
      for (const [index, owner] of owners.entries()) {
        await expect.poll(() => editor(index).inputValue()).toBe(owner.draft)
        await pane(index).locator('[data-workbench-pane-header]').getByText(owner.target.nodeName, { exact: true }).waitFor()
        expect(await editor(index).evaluate(input => (input as HTMLTextAreaElement).readOnly)).toBe(false)
        const send = pane(index).getByRole('button', { name: 'Send message', exact: true })
        await expect.poll(() => send.isEnabled()).toBe(true)
        evidence.push(`${owner.target.nodeName}: ${owner.key}; restored draft: ${await editor(index).inputValue()}; Send enabled`)
      }
      expect(await page.locator('[data-conversation-intent]').count()).toBe(0)
      expect(submissions).toEqual([])
      for (const [index] of owners.entries()) {
        const [settled] = await Promise.all([
          fixture.worlds[index]!.whenTurnSettled(),
          pane(index).getByRole('button', { name: 'Send message', exact: true }).click(),
        ])
        expect(settled).toBe(session)
        await expect.poll(() => editor(index).inputValue()).toBe('')
        await pane(index).getByText('LIGHTHOUSE', { exact: true }).waitFor()
      }
      for (const [index, owner] of owners.entries()) {
        const stored = await fixture.worlds[index]!.ctx.sessionPersistence.inspect(session)
        const userTexts = stored.events.flatMap(event => event.type === 'user/message'
          ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
        const ownedMessages = userTexts.filter(text => text === owner.draft)
        expect(ownedMessages).toHaveLength(1)
        expect(userTexts).not.toContain(owners[1 - index]!.draft)
        evidence.push(`${owner.target.nodeName}: durable user message: ${ownedMessages[0]}; reply: ${await pane(index).getByText('LIGHTHOUSE', { exact: true }).textContent()}`)
      }
      expect(submissions).toEqual(owners.map(owner => ({ runtimeId: owner.target.runtimeId, sessionId: session })))
      expect(await page.locator('[data-conversation-intent]').count()).toBe(0)
      expect(errors).toEqual([])
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/personal-computers/workbench-drafts.expected.md', import.meta.url)),
        evidence.join('\n'), webSnapshotMode())
    } catch (error) {
      await saveFailureShot(page, 'workbench-cross-runtime-drafts')
      throw error
    }
  } catch (error) { failures.push(error) }
  finally {
    for (const close of [() => context?.close(), () => browser?.close(), () => fixture.close()]) {
      try { await close() } catch (error) { failures.push(error) }
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Cross-computer Workbench draft verification failed')
})
