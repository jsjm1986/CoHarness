/** Workbench lookup and same-operation creation in a real browser attached to two isolated Web Hosts. */
import { appendFile } from 'node:fs/promises'
import { type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { clientSessionKey, type ClientRuntimeTarget } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { computerBrowser } from './computer-browser.ts'
import { launchPersonalComputersFixture, personalTargets } from './personal-computers-fixture.ts'

const compute = personalTargets[1]!
const projectName = 'Compute project'
const projectTitle = 'Quarterly release on Compute'

async function workbench(run: (page: Page, fixture: Awaited<ReturnType<typeof launchPersonalComputersFixture>>) => Promise<void>) {
  const fixture = await launchPersonalComputersFixture({ workbench: true, projectMetadata: true })
  let browser: Browser | undefined
  try {
    browser = await computerBrowser()
    const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 } })
    await page.addInitScript((runtime) => {
      sessionStorage.setItem('dsh.conversation.workbenches.tab.v1.account%3A7.' + runtime,
        JSON.stringify({ version: 3, mode: 'workbench', activeId: 'acceptance', workbenches: [
          { id: 'acceptance', name: 'Acceptance', paneIds: [], paneRatios: [], updatedAt: 1 },
        ] }))
    }, personalTargets[0]!.runtimeId)
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Add conversation', exact: true }).first().click({ timeout: 25000 })
    await run(page, fixture)
  } finally {
    try { await browser?.close() } finally { await fixture.close() }
  }
}
async function scope(page: Page, name: RegExp) {
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Workspace', exact: true }).click()
  await page.getByRole('menu').getByText(name).first().click()
}
async function measurement(data: Record<string, unknown>) {
  const file = process.env['DSH_WORKBENCH_CONTINUITY_RECEIPT']
  if (file) await appendFile(file, JSON.stringify(data) + '\n', { mode: 0o600 })
}
it('finds an already displayed project and personal conversation from All spaces without starting another Runtime', async () => {
  await workbench(async (page, fixture) => {
    const project = { kind: 'project', projectId: 18, projectName, nodeId: compute.nodeId, nodeName: compute.nodeName,
      runtimeId: '30000000-0000-4000-8000-000000000002' }
    const deepTitle = 'Cross-page receipt outside the first page'
    const denied = 'revoked lookup'
    // This project has an authorized metadata directory and no execution Host in the two-computer fixture.
    await page.route('**/account/api/workbench/rows?**', async (route) => {
      const address = new URL(route.request().url()).searchParams
      if (address.get('dshRuntime') !== project.runtimeId) return route.continue()
      if (address.get('dshTarget') !== 'project:18' || route.request().headers()['x-dsh-expected-principal-id'] !== '7' || address.get('q') === denied) {
        await route.fulfill({ status: 403, json: { error: 'forbidden' } })
        return
      }
      const deep = address.get('cursor') === 'next-authorized-page', searched = address.get('q') === 'Cross-page'
      await route.fulfill({ json: { runtimeId: project.runtimeId, workspaces: [], nextCursor: searched && !deep ? 'next-authorized-page' : null, items: [
        { sessionId: deep ? 'q-only-project' : 'same-personal-session', title: deep ? deepTitle : projectTitle, runtime: project, cwd: '/srv/compute/owned',
          visibility: 'private', creatorUserId: 7, creatorDisplayName: 'Lin', updatedAt: 1, canWrite: true, blank: false },
      ] } })
    })
    const dialog = page.getByRole('dialog')
    await scope(page, /^Compute computer$/)
    await dialog.getByRole('button', { name: /Compute conversation/ }).waitFor()
    await scope(page, /^(?:#18|Compute project)$/)
    await dialog.getByRole('button', { name: new RegExp(projectTitle) }).waitFor()
    await scope(page, /^All spaces$/)
    await dialog.getByRole('button', { name: new RegExp(projectTitle) }).waitFor()
    const start = performance.now(), counts = fixture.receipts.length
    await dialog.getByRole('textbox', { name: 'Search conversations or paths' }).fill(projectTitle)
    await dialog.getByText('Loading conversation directory…').waitFor({ state: 'hidden' })
    const projectMatches = await dialog.getByRole('button', { name: new RegExp(projectTitle) }).count()
    await measurement({ action: 'search-all', projectMatches, elapsedMs: Math.round(performance.now() - start),
      rowsRequests: fixture.receipts.slice(counts).filter(item => item.path === '/account/api/workbench/rows').length })
    expect(projectMatches).toBe(1)
    await dialog.getByRole('textbox', { name: 'Search conversations or paths' }).fill('Compute conversation')
    await dialog.getByRole('button', { name: /Compute conversation/ }).waitFor()
    await dialog.getByRole('button', { name: 'Choose a space', exact: true }).click()
    await page.getByRole('menu').getByText(/^Compute computer$/).first().click()
    await dialog.getByRole('button', { name: /Compute conversation/ }).waitFor()
    await expect.poll(() => dialog.getByText('Searched loaded conversations.', { exact: false }).count()).toBe(0)
    await scope(page, /^(?:#18|Compute project)$/)
    const search = dialog.getByRole('textbox', { name: 'Search conversations or paths' })
    await search.fill('Cross-page')
    await dialog.getByRole('button', { name: 'More conversations' }).click()
    await dialog.getByRole('button', { name: new RegExp(deepTitle) }).waitFor()
    await scope(page, /^All spaces$/)
    await dialog.getByRole('button', { name: new RegExp(deepTitle) }).waitFor()
    await scope(page, /^(?:#18|Compute project)$/)
    const [refused] = await Promise.all([
      page.waitForResponse(row => new URL(row.url()).searchParams.get('q') === denied),
      search.fill(denied),
    ])
    expect(refused.status()).toBe(403)
    await expect.poll(() => dialog.getByRole('button', { name: 'New conversation', exact: true }).isEnabled()).toBe(false)
    await scope(page, /^All spaces$/)
    await search.fill(deepTitle)
    await dialog.getByText('Searched loaded conversations.', { exact: false }).waitFor()
    expect(await dialog.getByRole('button', { name: new RegExp(deepTitle) }).count()).toBe(0)
    for (const target of personalTargets.slice(2)) expect(fixture.calls.get(target.runtimeId) ?? 0).toBe(0)
  })
}, 60000)

it('uses the created conversation receipt on its computer and verifies an independent selection', async () => {
  await workbench(async (page, fixture) => {
    const dialog = page.getByRole('dialog')
    const office = personalTargets[0]!
    const pane = (target: ClientRuntimeTarget, id: SessionId) => page.locator(`[data-session-pane="${clientSessionKey(target, id)}"]`)
    const previous = pane(office as ClientRuntimeTarget, 'same-personal-session' as SessionId).locator('textarea')
    await scope(page, /^Office computer$/)
    await dialog.getByRole('button', { name: /Office conversation/ }).click()
    await previous.fill('Keep this Office draft')
    await page.getByRole('button', { name: 'Add conversation', exact: true }).first().click()
    await scope(page, /^Compute computer$/)
    await dialog.getByRole('button', { name: /Compute conversation/ }).waitFor()
    const start = performance.now(), from = fixture.receipts.length
    const [response] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/prepare/v1/session.create'),
      dialog.getByRole('button', { name: 'New conversation', exact: true }).click(),
    ])
    const body = await response.json() as {
      result: { ok: boolean; value: { sessionId: SessionId; workspace: { path: string }; initialHistory: unknown } }
    }
    expect(new URL(response.url()).searchParams.get('dshRuntime')).toBe(compute.runtimeId)
    expect(body.result.value?.workspace.path).toBe(fixture.worlds[1]!.workspaceCwd)
    expect(body.result.value?.initialHistory).toBeDefined()
    await dialog.waitFor({ state: 'hidden' })
    const editor = pane(compute as ClientRuntimeTarget, body.result.value.sessionId).locator('textarea')
    await editor.waitFor()
    let editable = false
    try {
      await editor.fill('A draft in the new Compute conversation', { timeout: 3500 })
      editable = true
    } finally {
      await measurement({ action: 'create-pane', editable, elapsedMs: Math.round(performance.now() - start),
        siblingDraftPreserved: await previous.inputValue() === 'Keep this Office draft',
        historyReads: fixture.receipts.slice(from).filter(row => row.runtimeId === compute.runtimeId && row.path === '/api/prepare/v1/session.history').length })
    }
    expect(await previous.inputValue()).toBe('Keep this Office draft')
    const requests = fixture.receipts.slice(from).filter(row => row.runtimeId === compute.runtimeId)
    const historyReads = requests.filter(row => row.path === '/api/prepare/v1/session.history').length
    await measurement({ action: 'create-to-editable', elapsedMs: Math.round(performance.now() - start), historyReads,
      createCount: requests.filter(row => row.path === '/api/prepare/v1/session.create').length })
    expect(historyReads).toBe(0)
    await page.getByRole('button', { name: 'Add conversation', exact: true }).first().click()
    await scope(page, /^Compute computer$/)
    const next = fixture.receipts.length
    await dialog.getByRole('button', { name: /Compute conversation/ }).click()
    await dialog.waitFor({ state: 'hidden' })
    expect(await editor.inputValue()).toBe('A draft in the new Compute conversation')
    expect(await previous.inputValue()).toBe('Keep this Office draft')
    expect(fixture.receipts.slice(next).some(row => row.runtimeId === compute.runtimeId && row.path === '/api/prepare/v1/session.history')).toBe(true)
  })
}, 60000)
