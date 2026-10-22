/** Assembled browser coverage for bounded JSON previews and directory refresh continuity. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-title'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const ID = 'frontend-responsiveness'
const TITLE = 'SYNTHETIC_FRONTEND_RESPONSIVENESS'
const COUNT = 1000

function history(): string {
  const session = Session.create(SessionId(ID))
  const callId = ToolCallId('synthetic-json-output')
  const args = '{}'
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Inspect the generated search results.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title: TITLE, messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: createAssistantMessage({ source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      content: [{ type: 'tool-call', id: callId, name: 'synthetic_search', arguments: args }],
    }),
  }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'synthetic_search', arguments: args })
  const result = { status: 'ok', matches: Array.from({ length: COUNT }, (_unused, index) => ({
    path: `src/generated/module-${String(index)}.ts`, line: index + 1,
    text: `export const value${String(index)} = ${String(index)}`,
    metadata: { kind: 'source', verified: true },
  })), totals: { files: COUNT, matches: COUNT } }
  session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: JSON.stringify(result) }] }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 1700000000000,
    cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

it('keeps full JSON results reachable and directory selection stable through refresh', async () => {
  const scaffold = await launchWebScaffold()
  let browser: Browser | undefined
  const failures: unknown[] = []
  try {
    browser = await chromium.launch({ headless: true })
    await mkdir(join(scaffold.workspaceCwd, 'src'))
    await writeFile(join(scaffold.workspaceCwd, 'src', 'example.ts'), 'export const example = 1\n')
    await writeFile(join(scaffold.workspaceCwd, 'README.md'), '# Synthetic workspace\n')
    const sessionId = await seedSession(scaffold, history(), ID, undefined, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(sessionId)
    const page = await newEnglishPage(browser)
    const consoleWatch = watchConsole(page)
    page.setDefaultTimeout(30_000)
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('treeitem').first().click()
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
    expect(consoleWatch.pageErrors).toEqual([])
    expect(consoleWatch.warnings).toEqual([])
  } catch (error) { failures.push(error) } finally {
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold.close().catch((error: unknown) => failures.push(error))
  }
  if (failures.length > 0) throw new AggregateError(failures, 'frontend responsiveness journey failed')
})
