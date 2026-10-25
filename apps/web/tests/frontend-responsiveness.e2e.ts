/** Assembled browser coverage for preview continuity, list arrival feedback, and catalog demand. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page, type WebSocketRoute } from 'playwright'
import { expect, it } from 'vitest'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-title'
import { clientSessionKey } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const ID = 'frontend-responsiveness'
const TITLE = 'SYNTHETIC_FRONTEND_RESPONSIVENESS'
const COUNT = 1000

type BaselineMethod = 'session.list' | 'workspace.list'

function baselineGate() {
  return {
    arrived: undefined as boolean | undefined,
    release: Promise.withResolvers<undefined>(),
    requests: 0,
  }
}

async function listGeometry(region: Locator) {
  return await region.evaluate((root) => {
    const tree = root.querySelector<HTMLElement>('[role="tree"]')
    const footer = root.querySelector<HTMLElement>('[data-workspace-list-footer]')
    if (tree === null || footer === null) throw new Error('Retained list has no scroll region or reserved footer')
    const rect = (node: Element) => {
      const { x, y, width, height } = node.getBoundingClientRect()
      return { x, y, width, height }
    }
    return {
      tree: rect(tree), footer: rect(footer), scrollTop: tree.scrollTop,
      rows: Array.from(tree.querySelectorAll('[data-row-key]'), node => ({
        key: node.getAttribute('data-row-key'), rect: rect(node),
      })),
    }
  })
}

async function clickVisibleRowMenus(page: Page, tree: Locator): Promise<Locator> {
  const keys = await tree.evaluate((root) => {
    const viewport = root.getBoundingClientRect()
    return Array.from(root.querySelectorAll('[data-row-key^="session:"]')).filter((node) => {
      const rect = node.getBoundingClientRect()
      return rect.top >= viewport.top && rect.bottom <= viewport.bottom
    }).map(node => node.getAttribute('data-row-key'))
  })
  expect(keys.length).toBeGreaterThanOrEqual(2)
  let last: Locator | undefined
  for (const key of [keys[0], keys.at(-1)]) {
    if (key === null || key === undefined) throw new Error('Visible Session row has no identity')
    const row = tree.locator(`[data-row-key="${key}"]`)
    await row.hover()
    const action = row.locator('button[aria-label^="Session actions for "]')
    await action.click()
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor({ state: 'hidden' })
    expect(await action.evaluate(node => node === document.activeElement)).toBe(true)
    last = action
  }
  if (last === undefined) throw new Error('Visible row menus were not exercised')
  return last
}

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
    expect(await page.evaluate(() => {
      const raw = localStorage.getItem('dsh.conversation.workbenches.v3.local')
      return raw === null ? undefined : JSON.parse(raw) as { version: number; workbenches: { paneIds: string[] }[] }
    })).toMatchObject({ version: 3, workbenches: [{ paneIds: [] }] })
    const emptyRestores: string[] = []
    const reloadEmptyLayout = async (mode: 'single' | 'workbench'): Promise<void> => {
      const warningsBefore = consoleWatch.warnings.length
      const [sessionList, workspaceList] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/session.list'),
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace.list'),
        page.reload({ waitUntil: 'commit' }),
      ])
      expect(await sessionList.finished()).toBeNull()
      expect(await workspaceList.finished()).toBeNull()
      if (mode === 'single') {
        await expect.poll(() => row(entries[0].id).getAttribute('aria-selected')).toBe('true')
        await page.locator('textarea:enabled').last().waitFor()
        await page.locator('[data-model-trigger][aria-busy="false"]').waitFor()
      } else await page.locator('[data-workbench-empty-content]').waitFor()
      expect(catalogRequests).toBe(0)
      emptyRestores.push(`## Restored empty layout: ${mode}\n\n${await captureStableAria(page,
        mode === 'single' ? '[data-workbench-toolbar]' : '[data-workbench-empty-content]', scaffold.workspaceCwd)}`)
      acknowledgeReloadConnectionLoss(consoleWatch, warningsBefore)
    }
    await reloadEmptyLayout('single')
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
    await reloadEmptyLayout('workbench')
    for (const round of [1, 2]) {
      await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).click()
      const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
      await picker.getByRole('button', { name: `${entries[0].title} catalog ${String(round)}`, exact: true }).waitFor()
      expect(catalogRequests).toBe(round)
      if (round === 2) {
        const golden = fileURLToPath(new URL('./expected/frontend-responsiveness/catalog-demand.expected.md', import.meta.url))
        await compareOrRefreshGolden(golden, `${emptyRestores.join('\n\n')}\n\n## Fresh chooser\n\n${
          await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)}`, webSnapshotMode())
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

it.each(['empty', 'populated', 'session-failure', 'workspace-failure'] as const)(
  'shows list loading until its real baselines settle: %s',
  async (outcome) => {
    const scaffold = await launchWebScaffold({ openInApp: false })
    let browser: Browser | undefined
    let page: Page | undefined
    const gates: Record<BaselineMethod, ReturnType<typeof baselineGate>> = {
      'session.list': baselineGate(), 'workspace.list': baselineGate(),
    }
    const operations = new Set<Promise<void>>()
    const failures: unknown[] = []
    try {
      const title = 'SYNTHETIC_LIST_BASELINE_SESSION'
      let workspaceId: string | undefined
      if (outcome === 'populated') {
        const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
        workspaceId = workspace.id
        const id = await seedSession(scaffold, history('list-baseline-session', title, 1),
          'list-baseline-session', undefined, scaffold.workspaceCwd)
        await workspace.attachSession(id)
      }
      browser = await chromium.launch({ headless: true })
      page = await newEnglishPage(browser)
      page.setDefaultTimeout(30_000)
      const consoleWatch = watchConsole(page)
      const origin = new URL(scaffold.authenticatedUrl).origin
      const fault: BaselineMethod | undefined = outcome === 'session-failure' ? 'session.list'
        : outcome === 'workspace-failure' ? 'workspace.list' : undefined
      // Delay only this page's first two real Host baselines. Fault cases fail one transport delivery;
      // explicit Retry reads the real Host again, without a substituted successful catalog.
      await page.route(url => url.origin === origin
        && (url.pathname === '/api/session.list' || url.pathname === '/api/workspace.list'), async (route) => {
        const method = new URL(route.request().url()).pathname.slice('/api/'.length) as BaselineMethod
        const gate = gates[method]
        gate.requests++
        if (gate.requests > 1) { await route.continue(); return }
        const operation = (async () => {
          const response = await route.fetch()
          expect(response.ok()).toBe(true)
          gate.arrived = true
          await gate.release.promise
          if (method === fault) await route.abort('connectionfailed')
          else await route.fulfill({ response })
        })()
        operations.add(operation)
        try { await operation } catch (error) {
          failures.push(error)
          gate.arrived = false
          await route.abort().catch((abortError: unknown) => { failures.push(abortError) })
        } finally { operations.delete(operation) }
      })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
      await expect.poll(() => Object.values(gates).map(gate => gate.arrived)).toEqual([true, true])
      const tree = page.getByRole('tree', { name: 'Sessions', exact: true })
      await tree.waitFor()
      expect(await tree.getByText('No sessions yet', { exact: true }).count()).toBe(0)
      const loading = tree.getByRole('status', { name: 'Loading…', exact: true })
      await loading.waitFor()
      const expected = (name: string) => fileURLToPath(new URL(
        `./expected/frontend-responsiveness/list-${name}.expected.md`, import.meta.url,
      ))
      if (outcome === 'empty') {
        await compareOrRefreshGolden(expected('loading'),
          await captureStableAria(page, '[role="tree"]', scaffold.workspaceCwd), webSnapshotMode())
      }

      const first: BaselineMethod = outcome === 'populated' || outcome === 'workspace-failure'
        ? 'session.list' : 'workspace.list'
      const last: BaselineMethod = first === 'session.list' ? 'workspace.list' : 'session.list'
      const firstResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/${first}`)
      gates[first].release.resolve(undefined)
      await (await firstResponse).finished()
      if (outcome === 'populated') {
        const independent = tree.locator('[data-row-key="workspace:"]')
        if (await independent.getAttribute('aria-expanded') !== 'true') await independent.click()
        await expect.poll(() => independent.getAttribute('aria-expanded')).toBe('true')
        const key = clientSessionKey({ kind: 'personal' }, SessionId('list-baseline-session'))
        await tree.locator(`[data-row-key="session:${key}"]`).waitFor()
      } else await loading.waitFor()
      expect(await tree.getByText('No sessions yet', { exact: true }).count()).toBe(0)
      const lastDelivery = fault === last
        ? page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === `/api/${last}`)
        : page.waitForResponse(response => new URL(response.url()).pathname === `/api/${last}`)
          .then(response => response.finished())
      gates[last].release.resolve(undefined)
      await lastDelivery

      if (fault !== undefined) {
        const notice = tree.getByRole('alert')
        await notice.getByText('Could not load the list', { exact: true }).waitFor()
        expect(await loading.count()).toBe(0)
        expect(await tree.getByText('No sessions yet', { exact: true }).count()).toBe(0)
        if (outcome === 'session-failure') {
          await compareOrRefreshGolden(expected('failed'),
            await captureStableAria(page, '[role="tree"]', scaffold.workspaceCwd), webSnapshotMode())
        }
        const retried = page.waitForResponse(response => new URL(response.url()).pathname === `/api/${fault}`)
        await notice.getByRole('button', { name: 'Retry', exact: true }).click()
        await (await retried).finished()
        await expect.poll(() => notice.count()).toBe(0)
        expect(gates[fault].requests).toBe(2)
        expect(gates[first].requests).toBe(1)
      }
      if (outcome === 'populated') {
        await page.locator(`[data-row-key="workspace:${workspaceId}"]`).waitFor()
        await tree.getByText(title, { exact: true }).waitFor()
        expect(await tree.getByText('No sessions yet', { exact: true }).count()).toBe(0)
      } else {
        await tree.getByText('No sessions yet', { exact: true }).waitFor()
        if (outcome === 'empty') {
          await compareOrRefreshGolden(expected('empty'),
            await captureStableAria(page, '[role="tree"]', scaffold.workspaceCwd), webSnapshotMode())
        }
      }
      expect(await loading.count()).toBe(0)
      expect(consoleWatch.pageErrors).toEqual([])
      expect(consoleWatch.warnings).toEqual([])
    } catch (error) {
      failures.push(error)
    } finally {
      for (const gate of Object.values(gates)) gate.release.resolve(undefined)
      await page?.unrouteAll({ behavior: 'wait' }).catch((error: unknown) => { failures.push(error) })
      const settled = await Promise.allSettled([...operations])
      for (const result of settled) if (result.status === 'rejected') failures.push(result.reason)
      await browser?.close().catch((error: unknown) => { failures.push(error) })
      await scaffold.close().catch((error: unknown) => { failures.push(error) })
    }
    if (failures.length > 0) throw new AggregateError(failures, `list baseline ${outcome} journey failed`)
  },
)

it.each([
  { width: 1280, group: 'workspace' }, { width: 1280, group: 'flat' },
  { width: 390, group: 'workspace' }, { width: 390, group: 'flat' },
] as const)('keeps retained list geometry and actions stable at $width in $group view', async ({ width, group }) => {
  const scaffold = await launchWebScaffold({ openInApp: false })
  let browser: Browser | undefined
  let page: Page | undefined
  const gates: Record<BaselineMethod, ReturnType<typeof baselineGate>> = {
    'session.list': baselineGate(), 'workspace.list': baselineGate(),
  }
  const retryGate = baselineGate()
  const operations = new Set<Promise<void>>()
  const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []
  const failures: unknown[] = []
  try {
    const directory = join(scaffold.workspaceCwd, 'list-continuity')
    await mkdir(directory)
    const workspace = await scaffold.ctx.workspaceRegistry.create(directory)
    for (let index = 0; index < 24; index++) {
      const id = `list-continuity-${String(index).padStart(2, '0')}`
      const session = await seedSession(scaffold, history(id, `LIST_ROW_${String(index).padStart(2, '0')}`, 1),
        id, undefined, directory)
      await workspace.attachSession(session)
    }
    browser = await chromium.launch({ headless: true })
    page = await newEnglishPage(browser, 700)
    const target = page
    await target.setViewportSize({ width, height: 700 })
    await target.clock.setFixedTime(Date.UTC(2026, 9, 23, 12))
    target.setDefaultTimeout(30_000)
    const tripwire = watchConsole(target)
    const owner = new URL(scaffold.authenticatedUrl)
    // This page and ephemeral authority belong to this fixture. No other Host or browser is routed.
    await target.routeWebSocket(url => url.host === owner.host && url.pathname === '/api/events.host', (client) => {
      sockets.push({ client, server: client.connectToServer() })
    })
    await target.route(url => url.origin === owner.origin
      && (url.pathname === '/api/session.list' || url.pathname === '/api/workspace.list'), async (route) => {
      const method = new URL(route.request().url()).pathname.slice('/api/'.length) as BaselineMethod
      const gate = gates[method]
      gate.requests++
      const attempt = gate.requests
      if (attempt !== 2 && !(method === 'session.list' && attempt === 3)) {
        await route.continue()
        return
      }
      const operation = (async () => {
        const response = await route.fetch()
        expect(response.ok()).toBe(true)
        const held = attempt === 2 ? gate : retryGate
        held.arrived = true
        await held.release.promise
        if (method === 'session.list' && attempt === 2) await route.abort('connectionfailed')
        else await route.fulfill({ response })
      })()
      operations.add(operation)
      try { await operation } catch (error) {
        failures.push(error)
        gate.arrived = false
        retryGate.arrived = false
        await route.abort().catch((abortError: unknown) => { failures.push(abortError) })
      } finally { operations.delete(operation) }
    })
    await Promise.all([
      target.waitForResponse(response => new URL(response.url()).pathname === '/api/session.list'),
      target.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace.list'),
      target.goto(scaffold.authenticatedUrl, { waitUntil: 'load' }),
    ])
    const currentTitle = width === 390
      ? target.locator('[data-mobile-app-header]').getByText('LIST_ROW_23', { exact: true })
      : target.getByRole('navigation', { name: 'Session hierarchy', exact: true })
        .getByRole('button', { name: 'LIST_ROW_23', exact: true })
    await currentTitle.waitFor()
    await target.locator('textarea:enabled').last().waitFor()
    await target.locator('[data-model-trigger][aria-busy="false"]').waitFor()
    if (width === 390) {
      await target.getByRole('button', { name: 'Open sidebar', exact: true }).click()
      const drawer = target.locator('[class*="drawer"]').first()
      await expect.poll(() => drawer.evaluate(node => Math.round(node.getBoundingClientRect().x))).toBe(0)
    }
    const tree = target.getByRole('tree', { name: 'Sessions', exact: true })
    await tree.waitFor()
    if (group === 'flat') {
      await target.getByRole('button', { name: 'View options', exact: true }).click()
      await target.getByRole('menuitem', { name: 'In one list', exact: true }).click()
    } else {
      const workspaceRow = target.locator(`[data-row-key="workspace:${workspace.id}"]`)
      await workspaceRow.waitFor()
      await expect.poll(() => workspaceRow.getAttribute('aria-expanded')).toBe('true')
      const more = tree.getByRole('button', { name: /^Show \d+ more sessions$/u })
      while (await more.count() > 0) {
        const count = await tree.locator('[data-row-key^="session:"]').count()
        await more.click()
        await expect.poll(() => tree.locator('[data-row-key^="session:"]').count()).toBeGreaterThan(count)
      }
    }
    await expect.poll(() => tree.locator('[data-row-key^="session:"]').count()).toBe(24)
    const region = target.locator('[data-workspace-list-region]')
    await expect.poll(() => region.getAttribute('data-workspace-list-state')).toBe('ready')
    expect(await region.getByRole('alert').count()).toBe(0)
    expect(gates['session.list'].requests).toBe(1)
    expect(gates['workspace.list'].requests).toBe(1)
    const socket = sockets.at(-1)
    if (socket === undefined) throw new Error('The fixture Host stream was not established')
    const warningStart = tripwire.warnings.length
    await Promise.all([
      socket.client.close({ code: 1012, reason: 'Fixture list refresh' }),
      socket.server.close({ code: 1012, reason: 'Fixture list refresh' }),
    ])
    await expect.poll(() => Object.values(gates).map(gate => gate.arrived)).toEqual([true, true])
    await expect.poll(() => region.getAttribute('data-workspace-list-state')).toBe('loading')
    const scrollTop = await tree.evaluate((node) => {
      const scroll = node as HTMLElement
      scroll.scrollTop = Math.floor((scroll.scrollHeight - scroll.clientHeight) / 2)
      return scroll.scrollTop
    })
    expect(scrollTop).toBeGreaterThan(0)
    const focusedAction = await clickVisibleRowMenus(target, tree)
    const before = await listGeometry(region)
    const workspaceReply = target.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace.list')
    gates['workspace.list'].release.resolve(undefined)
    await (await workspaceReply).finished()
    const failed = target.waitForEvent('requestfailed', request => new URL(request.url()).pathname === '/api/session.list')
    gates['session.list'].release.resolve(undefined)
    await failed
    const notice = region.getByRole('alert')
    await notice.getByText('Could not load the list', { exact: true }).waitFor()
    await expect.poll(() => region.getAttribute('data-workspace-list-state')).toBe('error')
    expect(await focusedAction.evaluate(node => node === document.activeElement)).toBe(true)
    const during = await listGeometry(region)
    expect(during).toEqual(before)
    expect(during.footer.y).toBeGreaterThanOrEqual(during.tree.y + during.tree.height)
    expect(during.footer.x).toBeGreaterThanOrEqual(0)
    expect(during.footer.x + during.footer.width).toBeLessThanOrEqual(width)
    expect(during.footer.y + during.footer.height).toBeLessThanOrEqual(700)
    await clickVisibleRowMenus(target, tree)
    expect(await listGeometry(region)).toEqual(before)
    const golden = fileURLToPath(new URL(
      './expected/frontend-responsiveness/list-retained-error.expected.md', import.meta.url,
    ))
    await compareOrRefreshGolden(golden,
      await captureStableAria(target, '[data-workspace-list-footer]', scaffold.workspaceCwd), webSnapshotMode())
    await notice.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(() => retryGate.arrived).toBe(true)
    await expect.poll(() => region.getAttribute('data-workspace-list-state')).toBe('loading')
    expect(await tree.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await region.getByRole('alert').count()).toBe(0)
    expect(await listGeometry(region)).toEqual(before)
    const retried = target.waitForResponse(response => new URL(response.url()).pathname === '/api/session.list')
    retryGate.release.resolve(undefined)
    await (await retried).finished()
    await expect.poll(() => region.getAttribute('data-workspace-list-state')).toBe('ready')
    const after = await listGeometry(region)
    expect(after).toEqual(before)
    expect(await tree.evaluate(node => node === document.activeElement)).toBe(true)
    await clickVisibleRowMenus(target, tree)
    expect(await listGeometry(region)).toEqual(before)
    expect(gates['session.list'].requests).toBe(3)
    expect(gates['workspace.list'].requests).toBe(2)
    console.info('[list-footer-continuity]', JSON.stringify({ width, group, before, during, after }))
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } catch (error) {
    failures.push(error)
    if (page !== undefined) await diagnoseFrontend(page, scaffold, `footer-${String(width)}-${group}`)
      .catch((diagnosticError: unknown) => { failures.push(diagnosticError) })
  } finally {
    for (const gate of [...Object.values(gates), retryGate]) gate.release.resolve(undefined)
    await page?.unrouteAll({ behavior: 'wait' }).catch((error: unknown) => { failures.push(error) })
    const settled = await Promise.allSettled([...operations])
    for (const result of settled) if (result.status === 'rejected') failures.push(result.reason)
    await browser?.close().catch((error: unknown) => { failures.push(error) })
    await scaffold.close().catch((error: unknown) => { failures.push(error) })
  }
  if (failures.length > 0) throw new AggregateError(failures, `Retained list ${String(width)}/${group} journey failed`)
})
