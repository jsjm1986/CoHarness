/** Durable tool results pass through real presenter registrations and every responsive layout. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { responsiveBrowser, responsiveBrowserName, responsiveMobileEmulation, responsiveViewports, expectViewportFit } from './responsive-browser.ts'
import { expandOwningTurnProcess, saveFailureShot } from './support.ts'

type Meta = Extract<SessionEvent, { type: 'tool/result' }>['data']['meta']
interface CardCase {
  id: string
  tool: string
  args: Record<string, unknown>
  output: string
  meta?: Meta
  error?: boolean
  selector?: string
}
const LONG_PATH = 'src/diagnostics/long-workspace-name/renderer/responsive-card-with-detailed-context.ts'
const LINES = Array.from({ length: 72 }, (_, index) => ({ number: index + 1, text: `export const line${index + 1} = "${'long-value-'.repeat(12)}"` }))
const CASES: readonly CardCase[] = [
  { id: 'read', tool: 'read', args: { file_path: LONG_PATH }, output: `<path>${LONG_PATH}</path>\n<type>file</type>\n<content>\n${LINES.map(line => `${line.number}: ${line.text}`).join('\n')}\n</content>`, meta: { path: LONG_PATH, offset: 1, lines: LINES, totalLines: 72, lang: 'ts' }, selector: '[data-read]' },
  { id: 'read-empty', tool: 'read', args: { file_path: 'empty.txt' }, output: '<path>empty.txt</path>\n<type>file</type>\n<content>\n\n</content>', meta: { path: 'empty.txt', offset: 1, lines: [], totalLines: 0 }, selector: '[data-read]' },
  { id: 'read-error', tool: 'read', args: { file_path: LONG_PATH }, output: 'File not found. Check the path and retry.', error: true },
  { id: 'edit', tool: 'edit', args: { file_path: LONG_PATH, old_string: 'before', new_string: 'after' }, output: 'File updated', meta: { path: LONG_PATH, diffs: [{ path: LONG_PATH, oldText: 'before\nshared', newText: 'after\nshared' }] }, selector: '[data-diff]' },
  { id: 'write-long', tool: 'write', args: { file_path: LONG_PATH, content: LINES.map(line => line.text).join('\n') }, output: 'File written', meta: { path: LONG_PATH, diffs: [{ path: LONG_PATH, oldText: '', newText: LINES.map(line => line.text).join('\n') }] }, selector: '[data-diff]' },
  { id: 'grep', tool: 'grep', args: { pattern: 'long-value', path: 'src' }, output: '72 matches; refine the query for more.', meta: { shape: 'matches', files: [{ path: LONG_PATH, matches: LINES.map(line => ({ lineNumber: line.number, line: line.text })) }], total: 72, truncated: true }, selector: '[data-search="matches"]' },
  { id: 'grep-empty', tool: 'grep', args: { pattern: 'not-present' }, output: 'No matches found.', meta: { shape: 'matches', files: [], total: 0, truncated: false }, selector: '[data-search="matches"]' },
  { id: 'glob', tool: 'glob', args: { pattern: '**/*.ts' }, output: LONG_PATH, meta: { shape: 'paths', paths: Array.from({ length: 40 }, (_, index) => `src/group-${index}/${LONG_PATH}`), total: 40, truncated: false }, selector: '[data-search="paths"]' },
  { id: 'glob-empty', tool: 'glob', args: { pattern: '**/*.absent' }, output: 'No matches found.', meta: { shape: 'paths', paths: [], total: 0, truncated: false }, selector: '[data-search="paths"]' },
  { id: 'bash', tool: 'bash', args: { command: `printf '%s' '${LONG_PATH}'`, description: 'Print a long command and output' }, output: LINES.map(line => line.text).join('\n'), selector: '[data-terminal]' },
  { id: 'bash-nonzero', tool: 'bash', args: { command: 'exit 7', description: 'Exit with status seven' }, output: 'Command stopped.\n[exit code: 7]', selector: '[data-terminal]' },
  { id: 'bash-error', tool: 'bash', args: { command: 'unavailable-command', description: 'Start a command' }, output: 'Command could not start. Verify the executable path.', error: true },
  { id: 'bash-background', tool: 'bash', args: { command: `node ${LONG_PATH}`, description: 'Start the background program', run_in_background: true }, output: 'started background job bash-responsive' },
  { id: 'web-search', tool: 'web_search', args: { queries: ['Responsive interface accessibility'] }, output: 'Search results', meta: { sources: Array.from({ length: 8 }, (_, index) => ({ url: `https://example.test/docs/${index}`, title: `Detailed accessibility result ${index}`, snippet: 'A source excerpt with enough context to wrap across narrow viewports.', publishedAt: '2026-11-16' })), truncated: true }, selector: '[data-web="search"]' },
  { id: 'web-empty', tool: 'web_search', args: { queries: ['No results fixture'] }, output: 'No results', meta: { sources: [], truncated: false }, selector: '[data-web="search"]' },
  { id: 'web-fetch', tool: 'web_fetch', args: { url: 'https://example.test/long/path/to/documentation' }, output: '# Fetched document\n\nA readable result with **structured** content.', meta: { url: 'https://example.test/long/path/to/documentation', statusCode: 200, truncated: false }, selector: '[data-web="fetch"]' },
  { id: 'todo', tool: 'todo_write', args: { todos: [{ content: 'Inspect every responsive state', status: 'completed', activeForm: 'Inspecting responsive states' }, { content: 'Verify the remaining long result cards', status: 'in_progress', activeForm: 'Verifying result cards' }] }, output: 'Todos updated' },
  { id: 'generic', tool: 'fixture_custom_tool', args: { path: LONG_PATH, nested: { enabled: true, ids: [1, 2, 3] } }, output: JSON.stringify({ status: 'ready', details: 'Generic tool output '.repeat(25) }, null, 2) },
  { id: 'generic-error', tool: 'fixture_custom_tool', args: { path: LONG_PATH }, output: 'The operation was refused. Resolve the current error before retrying.', error: true },
]

function fixture(): string {
  const session = Session.create(SessionId('tool-card-responsive-source'))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Inspect the durable tool presentation catalog.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('session/title', { title: 'Responsive tool catalog', messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    content: CASES.map(item => ({ type: 'tool-call', id: ToolCallId(item.id), name: item.tool, arguments: JSON.stringify(item.args) })),
    source: { provider: 'fixture', model: 'fixture' },
  }) }, { surfaceOp: 'append' })
  for (const item of CASES) {
    const callId = ToolCallId(item.id)
    const call = session.append('tool/call', { turn: 1, step: 1, callId, name: item.tool, arguments: JSON.stringify(item.args) })
    session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: item.output }], isError: item.error ?? false }),
      ...(item.meta === undefined ? {} : { meta: item.meta }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  }
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

describe('web e2e: responsive tool presentation catalog', () => {
  let scaffold: WebScaffold, browser: Browser
  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const session = await seedSession(scaffold, fixture(), 'tool-card-responsive-history')
    await (await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)).attachSession(session)
    browser = await responsiveBrowser.launch()
  })
  afterAll(async () => { try { await browser?.close() } finally { await scaffold?.close() } })
  it.each(responsiveViewports)('$name expands every card and retains its input/output actions', async ({ name, width, height }) => {
    const page = await browser.newPage({ viewport: { width, height }, locale: 'en-US', hasTouch: true, isMobile: responsiveMobileEmulation && width < 768, reducedMotion: 'reduce' })
    const tripwire = watchConsole(page)
    try {
      if (responsiveBrowserName === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      for (const item of CASES) {
        const card = page.locator(`[data-chat-call-id="${item.id}"]`)
        await expandOwningTurnProcess(page, card)
        const disclosure = card.locator('[data-expandable], [data-disclosure-row] > button[aria-expanded], [data-sample="bash"]').first()
        await disclosure.waitFor()
        await expectViewportFit(page, card, [disclosure])
        const toggle = async (): Promise<void> => {
          const bounds = await disclosure.boundingBox()
          if (bounds === null) throw new Error(`Tool ${item.id} has no disclosure bounds`)
          // The leading icon toggles the row; file and URL summaries retain their independent open action.
          await disclosure.tap({ position: { x: 8, y: bounds.height / 2 } })
        }
        if (await disclosure.getAttribute('aria-expanded') !== 'true') await toggle()
        await expect.poll(() => disclosure.getAttribute('aria-expanded')).toBe('true')
        if (item.selector !== undefined) await card.locator(item.selector).waitFor()
        await expectViewportFit(page, card)
        for (const action of await card.getByRole('button').all()) {
          if (await action.isVisible()) {
            try { await expectViewportFit(page, card, [action]) }
            catch (error) {
              throw new Error(`Tool ${item.id} control ${await action.getAttribute('aria-label') ?? await action.innerText()} bounds ${JSON.stringify(await action.boundingBox())}`, { cause: error })
            }
          }
        }
        const wrap = card.getByRole('button', { name: 'Wrap lines', exact: true })
        if (await wrap.count() > 0) {
          await wrap.tap()
          await expect.poll(() => wrap.getAttribute('aria-pressed')).toBe('true')
          await expectViewportFit(page, card, [wrap])
          await wrap.tap()
          await expect.poll(() => wrap.getAttribute('aria-pressed')).toBe('false')
        }
        const expand = card.getByRole('button', { name: /^Expand (?:\d+|the remaining)/ })
        if (await expand.count() > 0) {
          await expand.tap()
          const collapse = card.getByRole('button', { name: /^Collapse (?:content|diff|output|results)$/ })
          await expect.poll(() => collapse.getAttribute('aria-expanded')).toBe('true')
          await expectViewportFit(page, card, [collapse])
          await collapse.tap()
          await expect.poll(() => expand.getAttribute('aria-expanded')).toBe('false')
        }
        const copy = card.getByRole('button', { name: 'Copy', exact: true })
        if (await copy.count() > 0) {
          await page.bringToFront()
          await copy.tap()
          await card.getByRole('button', { name: 'Copied', exact: true }).waitFor()
        }
        const output = process.env.DSH_MOBILE_SCREENSHOTS
        if (output !== undefined) {
          await mkdir(output, { recursive: true })
          await disclosure.scrollIntoViewIfNeeded()
          await page.screenshot({ path: join(output, `tool-${responsiveBrowserName}-${name}-${item.id}.png`), animations: 'disabled' })
        }
        await toggle()
        await expect.poll(() => disclosure.getAttribute('aria-expanded')).toBe('false')
      }
      expect(tripwire.pageErrors).toEqual([])
      expect(await page.locator('[data-slot-error]').count()).toBe(0)
    } catch (error) { await saveFailureShot(page, `tool-catalog-${responsiveBrowserName}-${name}`); throw error }
    finally { await page.close() }
  }, 120_000)
})
