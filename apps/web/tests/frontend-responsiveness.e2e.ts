/** Assembled browser coverage for preview continuity and workbench catalog demand. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-title'
import { clientSessionKey } from '@deepseek-ai/dsh-host-apiproxy/api'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const ID = 'frontend-responsiveness'
const TITLE = 'SYNTHETIC_FRONTEND_RESPONSIVENESS'
const COUNT = 1000

/** Capture only this scaffold's synthetic world before browser teardown. */
async function diagnoseFrontend(page: Page, scaffold: WebScaffold, name: string): Promise<void> {
  const parent = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, `frontend-${name}-`))
  const rpc = async (method: string): Promise<unknown> => {
    const response = await scaffold.hostFetch(`/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'diagnose', method, payload: {} }),
    })
    return { status: response.status, result: await response.json() as unknown }
  }
  const writes = await Promise.allSettled([
    page.screenshot({ path: join(directory, 'page.png') }),
    page.locator('body').ariaSnapshot().then(value => writeFile(join(directory, 'page.aria.txt'), value.slice(0, 40_000))),
    page.evaluate(() => Array.from(document.querySelectorAll('[data-row-key], [role="treeitem"]'), node => ({
      key: node.getAttribute('data-row-key'), role: node.getAttribute('role'),
      expanded: node.getAttribute('aria-expanded'), selected: node.getAttribute('aria-selected'),
      text: node.textContent?.slice(0, 300),
    }))).then(value => writeFile(join(directory, 'rows.json'), JSON.stringify(value, null, 2))),
    Promise.all([rpc('session.list'), rpc('workspace.list'), rpc('host.describe')])
      .then(value => writeFile(join(directory, 'host.json'), JSON.stringify(value, null, 2).replaceAll(scaffold.workspaceCwd, '<WORKSPACE>'))),
  ])
  console.info('Synthetic frontend failure diagnostics:', directory, writes.map(result => result.status))
}

/** Wait for the real baseline and active conversation before expanding its Workspace. */
async function openFrontendWorkspace(page: Page, url: string, workspaceId: string): Promise<void> {
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/session.list')),
    page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/workspace.list')),
    page.goto(url),
  ])
  await page.locator('textarea:enabled').last().waitFor()
  await page.locator('[data-model-trigger][aria-busy="false"]').waitFor()
  const workspace = page.locator(`[data-row-key="workspace:${workspaceId}"]`)
  await workspace.waitFor()
  if (await workspace.getAttribute('aria-expanded') !== 'true') await workspace.click()
  await expect.poll(() => workspace.getAttribute('aria-expanded')).toBe('true')
}

function history(id = ID, title = TITLE, count = COUNT): string {
  const session = Session.create(SessionId(id))
  const callId = ToolCallId('synthetic-json-output')
  const args = '{}'
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Inspect the generated search results.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title, messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: createAssistantMessage({ source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      content: [{ type: 'tool-call', id: callId, name: 'synthetic_search', arguments: args }],
    }),
  }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'synthetic_search', arguments: args })
  const result = { status: 'ok', matches: Array.from({ length: count }, (_unused, index) => ({
    path: `src/generated/module-${String(index)}.ts`, line: index + 1,
    text: `export const value${String(index)} = ${String(index)}`,
    metadata: { kind: 'source', verified: true },
  })), totals: { files: count, matches: count } }
  session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: JSON.stringify(result) }] }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 1700000000000,
    cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

it('keeps full JSON results reachable and directory selection stable through refresh', async () => {
  const scaffold = await launchWebScaffold({ workbench: true, openInApp: false })
  let browser: Browser | undefined
  let diagnose = async (): Promise<void> => {}
  const failures: unknown[] = []
  try {
    browser = await chromium.launch({ headless: true })
    await mkdir(join(scaffold.workspaceCwd, 'src'))
    await writeFile(join(scaffold.workspaceCwd, 'src', 'example.ts'), 'export const example = 1\n')
    const longText = Array.from({ length: 5000 }, (_unused, index) => index === 4999
      ? 'Line05000 SYNTHETIC_LONG_END'
      : `Line${String(index + 1).padStart(5, '0')} ${'synthetic preview text '.repeat(4)}`).join('\n') + '\n'
    await writeFile(join(scaffold.workspaceCwd, 'src', 'long-text.txt'), longText)
    await writeFile(join(scaffold.workspaceCwd, 'README.md'), '# Synthetic workspace\n')
    const sessionId = await seedSession(scaffold, history(), ID, undefined, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(sessionId)
    const page = await newEnglishPage(browser)
    diagnose = () => diagnoseFrontend(page, scaffold, 'preview')
    const consoleWatch = watchConsole(page)
    page.setDefaultTimeout(30_000)
    await openFrontendWorkspace(page, scaffold.authenticatedUrl, workspace.id)
    const session = page.getByRole('treeitem').filter({ hasText: TITLE })
    await session.waitFor()
    await session.click()
    await page.locator('textarea:enabled').last().waitFor()
    await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
    await page.locator('tr[data-kind="tool"]').first().click()
    const details = page.getByRole('complementary', { name: 'Event details' })
    await details.getByRole('tab', { name: 'Result', exact: true }).click()
    const tree = details.getByRole('tree', { name: 'Result JSON' })
    await tree.waitFor()
    // The preview includes only the first five items; explicit expansion retains every result.
    await expect.poll(() => tree.textContent()).toContain('module-4.ts')
    expect(await tree.textContent()).not.toContain('module-5.ts')
    const topRows = tree.locator(':scope > [role="treeitem"]')
    const matchRow = await topRows.count() > 0 ? topRows.nth(1) : tree.getByRole('treeitem').nth(1)
    await matchRow.getByRole('button', { name: 'Expand', exact: true }).first().click()
    await expect.poll(() => tree.getByRole('treeitem').count()).toBeGreaterThanOrEqual(COUNT + 3)
    expect(await tree.textContent()).toContain('module-999.ts')
    await matchRow.getByRole('button', { name: 'Collapse', exact: true }).first().click()
    expect(await tree.textContent()).not.toContain('module-999.ts')
    await details.getByRole('button', { name: 'Close details' }).click()
    await page.getByRole('tab', { name: 'Chat', exact: true }).click()
    const entry = page.locator('[data-sidebar-right-guide-entry="files"]')
    if (await entry.count() === 0) {
      await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
      if (await entry.count() === 0) await page.getByRole('button', { name: 'New tab', exact: true }).click()
    }
    await entry.click()
    const files = page.locator('[data-files-state="tree"]')
    const source = files.locator('[data-files-entry="directory"]').filter({ hasText: 'src' }).getByRole('button').first()
    await source.click()
    await files.getByRole('button', { name: 'example.ts', exact: true }).waitFor()
    const [response] = await Promise.all([
      page.waitForResponse((response) => {
        if (!new URL(response.url()).pathname.endsWith('/workspaceFiles.list')) return false
        const body = response.request().postDataJSON() as { payload?: { path?: string } }
        return body.payload?.path === 'src'
      }),
      files.locator('[data-files-reload]').click(),
    ])
    expect(response.ok()).toBe(true)
    expect(await response.json()).toMatchObject({ result: { ok: true } })
    await expect.poll(() => source.getAttribute('aria-expanded')).toBe('true')
    await files.getByRole('button', { name: 'example.ts', exact: true }).waitFor()
    await files.getByRole('button', { name: 'long-text.txt', exact: true }).click()
    const preview = page.locator('[data-workspace-file-preview]')
    await expect.poll(() => preview.evaluate(node => node.textContent?.includes('SYNTHETIC_LONG_END') ?? false)).toBe(true)
    expect(await preview.evaluate(node => node.textContent?.startsWith('Line00001') ?? false)).toBe(true)
    const textRegion = page.getByRole('region', { name: 'src/long-text.txt', exact: true })
    expect(await textRegion.getByRole('button', { name: 'Next page', exact: true }).isDisabled()).toBe(true)
    expect(await textRegion.getByRole('button', { name: 'Previous page', exact: true }).isDisabled()).toBe(true)
    const golden = fileURLToPath(new URL('./expected/frontend-responsiveness/long-text-end.expected.md', import.meta.url))
    await compareOrRefreshGolden(golden, await captureStableAria(
      page, 'section[aria-label="src/long-text.txt"] > div:first-child', scaffold.workspaceCwd,
    ), webSnapshotMode())
    expect(consoleWatch.pageErrors).toEqual([])
    expect(consoleWatch.warnings).toEqual([])
  } catch (error) { failures.push(error); await diagnose().catch((diagnosticError: unknown) => failures.push(diagnosticError)) } finally {
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold.close().catch((error: unknown) => failures.push(error))
  }
  if (failures.length > 0) throw new AggregateError(failures, 'frontend responsiveness journey failed')
})

it('reads the workbench catalog for chooser demand while ordinary Session switching remains independent', async () => {
  const scaffold = await launchWebScaffold({ workbench: true, openInApp: false })
  let browser: Browser | undefined
  let diagnose = async (): Promise<void> => {}
  const failures: unknown[] = []
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const entries = [
      { id: 'catalog-demand-a', title: 'SYNTHETIC_CATALOG_DEMAND_A' },
      { id: 'catalog-demand-b', title: 'SYNTHETIC_CATALOG_DEMAND_B' },
    ] as const
    for (const entry of entries) {
      const id = await seedSession(scaffold, history(entry.id, entry.title, 1), entry.id, undefined, scaffold.workspaceCwd)
      await workspace.attachSession(id)
    }
    browser = await chromium.launch({ headless: true })
    const page = await newEnglishPage(browser)
    const catalogNow = Date.UTC(2026, 9, 23, 12)
    await page.clock.setFixedTime(catalogNow)
    diagnose = () => diagnoseFrontend(page, scaffold, 'catalog')
    const consoleWatch = watchConsole(page)
    page.setDefaultTimeout(30_000)
    let catalogRequests = 0
    const catalogTargets: (string | null)[] = []
    // The standalone Host supplies the real Session transport; this exact route supplies its missing Gateway directory.
    await page.route(url => url.pathname === '/account/api/workbench/catalog', async (route) => {
      catalogRequests += 1
      catalogTargets.push(new URL(route.request().url()).searchParams.get('dshTarget'))
      await route.fulfill({ contentType: 'application/json', json: {
        personalComplete: true, personal: { id: 1, name: 'Synthetic account' }, activeRuntime: { kind: 'personal' }, projects: [],
        items: entries.map(entry => ({ sessionId: entry.id, title: `${entry.title} catalog ${String(catalogRequests)}`,
          runtime: { kind: 'personal' }, visibility: 'personal', creatorUserId: 1, creatorDisplayName: 'Synthetic account',
          updatedAt: catalogNow - 60_000, blank: false, canWrite: true })),
      } })
    })
    await openFrontendWorkspace(page, scaffold.authenticatedUrl, workspace.id)
    await expect.poll(() => page.locator('[data-row-key^="session:"]').count()).toBe(2)
    const renderedKeys = await page.locator('[data-row-key^="session:"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-row-key')))
    expect(renderedKeys).toEqual(expect.arrayContaining(entries.map(entry => `session:${clientSessionKey({ kind: 'personal' }, SessionId(entry.id))}`)))
    const row = (id: string) => page.locator(`[data-row-key="session:${clientSessionKey({ kind: 'personal' }, SessionId(id))}"]`)
    const modelResponse = (id: string) => page.waitForResponse((response) => {
      if (!new URL(response.url()).pathname.endsWith('/session.models')) return false
      const request = response.request().postDataJSON() as { payload?: { sessionId?: string } }
      return request.payload?.sessionId === id
    })
    if (await row(entries[0].id).getAttribute('aria-selected') === 'true') await row(entries[0].id).click()
    else await Promise.all([modelResponse(entries[0].id), row(entries[0].id).click()])
    await expect.poll(() => row(entries[0].id).getAttribute('aria-selected')).toBe('true')
    await page.locator('textarea:enabled').last().waitFor()
    await page.locator('[data-model-trigger][aria-busy="false"]').waitFor()
    expect(catalogRequests).toBe(0)
    for (const entry of [entries[1], entries[0], entries[1], entries[0]]) {
      await Promise.all([
        modelResponse(entry.id),
        row(entry.id).click(),
      ])
      await expect.poll(() => row(entry.id).getAttribute('aria-selected')).toBe('true')
      await page.locator('[data-model-trigger][aria-busy="false"]').waitFor()
      expect(catalogRequests).toBe(0)
    }
    const toolbar = page.locator('[data-workbench-toolbar]')
    await toolbar.getByRole('button', { name: 'Select workbench', exact: true }).click()
    await page.getByRole('menuitem', { name: /My workbench/u }).click()
    await page.locator('[data-workbench-empty-content]').waitFor()
    expect(catalogRequests).toBe(0)
    for (const round of [1, 2]) {
      await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).click()
      const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
      await picker.getByRole('button', { name: `${entries[0].title} catalog ${String(round)}`, exact: true }).waitFor()
      expect(catalogRequests).toBe(round)
      if (round === 2) {
        const golden = fileURLToPath(new URL('./expected/frontend-responsiveness/catalog-demand.expected.md', import.meta.url))
        await compareOrRefreshGolden(golden, await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
      }
      await picker.getByRole('button', { name: 'Close picker', exact: true }).click()
      await picker.waitFor({ state: 'hidden' })
      expect(catalogRequests).toBe(round)
    }
    expect(catalogTargets).toEqual(['personal', 'personal'])
    expect(consoleWatch.pageErrors).toEqual([])
    expect(consoleWatch.warnings).toEqual([])
  } catch (error) { failures.push(error); await diagnose().catch((diagnosticError: unknown) => failures.push(diagnosticError)) } finally {
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold.close().catch((error: unknown) => failures.push(error))
  }
  if (failures.length > 0) throw new AggregateError(failures, 'workbench catalog demand journey failed')
})
