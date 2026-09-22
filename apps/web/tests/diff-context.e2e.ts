/** Real file edits and browser rendering share exact or bounded replacement counts. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, expandTurnProcesses,
  fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const EXACT_DIR = fileURLToPath(new URL('./snapshots/diff-context', import.meta.url))
const BOUNDED_DIR = fileURLToPath(new URL('./snapshots/diff-bounded', import.meta.url))
// The ACP owner retains its live recording. The bounded script is authored upstream;
// both replace only model responses while this browser scenario executes the real tools.
const EXACT_FIXTURE = fileURLToPath(new URL('../../../examples/acp-agent/tests/snapshots/fs-edit/session.jsonl', import.meta.url))
const BOUNDED_FIXTURE = join(BOUNDED_DIR, 'session.v3.jsonl')
const UNTOUCHED = Buffer.from('unrelated file\r\nkeep these bytes\n', 'utf8')
const settings = (prefix: string): string =>
  ['shared heading', ...Array.from({ length: 129 }, (_, index) => `${prefix} setting ${index}`), ''].join('\n')

const CASES = [
  {
    name: 'diff-context', fixture: EXACT_FIXTURE, snapshotDir: EXACT_DIR, file: 'config.txt',
    before: 'mode=DEBUG\nlevel=info\n', after: 'mode=RELEASE\nlevel=info\n',
    totals: '+1 -1', shared: 'level=info', bounded: false, inventory: ['ui.expected.md'],
  },
  {
    name: 'diff-bounded', fixture: BOUNDED_FIXTURE, snapshotDir: BOUNDED_DIR, file: 'large.txt',
    before: settings('old'), after: settings('new'), totals: '+130 -130', shared: 'shared heading',
    bounded: true, inventory: ['session.v3.jsonl', 'ui.expected.md'],
  },
]

// These model scripts are read-only references, so record belongs to their owners.
describe.skipIf(MODE === 'record').each(CASES)('web e2e: $name', (scenario) => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let prompt: string
  const events: SessionEvent[] = []

  beforeAll(async () => {
    const prompts = fixtureUserPrompts(await readFile(scenario.fixture, 'utf8'))
    if (prompts.length !== 1 || prompts[0] === undefined) throw new Error(`${scenario.name} must have one drive prompt`)
    prompt = prompts[0]
    scaffold = await launchWebScaffold({ replayFixture: scenario.fixture })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
    const workspace = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, scenario.file), scenario.before)
    await writeFile(join(workspace, 'untouched.txt'), UNTOUCHED)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  it('executes the edit and preserves its counts through row and card expansion', async () => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-${scenario.name}`))
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('textarea').first()
    await input.fill(prompt)
    await input.press('Enter')
    await settled

    const workspace = join(scaffold.workspaceCwd, 'workspace')
    expect(await readFile(join(workspace, scenario.file), 'utf8')).toBe(scenario.after)
    expect(await readFile(join(workspace, 'untouched.txt'))).toEqual(UNTOUCHED)
    const calls = events.filter(event => event.type === 'tool/call')
    expect(calls.map(event => event.data.name)).toEqual(['read', 'edit'])
    const editCall = calls.find(event => event.data.name === 'edit')
    if (editCall === undefined) throw new Error('the replayed turn did not execute edit')
    const result = events.find(event => event.type === 'tool/result'
      && event.data.message.source.callId === editCall.data.callId)
    if (result?.type !== 'tool/result') throw new Error('the real edit produced no durable result')
    expect(result.data.message.content[0].isError).toBe(false)
    expect(result.data.meta).toEqual({
      diffs: [{ path: scenario.file, oldText: scenario.before.slice(0, -1), newText: scenario.after.slice(0, -1) }],
    })

    await page.getByText('DONE', { exact: true }).waitFor()
    await expandTurnProcesses(page)
    const edit = page.locator('[data-tool="edit"]')
    const disclosure = edit.locator('[data-expandable]')
    await expect.poll(() => disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(await disclosure.textContent()).toContain(scenario.totals)
    expect(await edit.locator('[data-diff]').count()).toBe(0)
    await disclosure.getByText('Edit', { exact: true }).click()
    await expect.poll(() => disclosure.getAttribute('aria-expanded')).toBe('true')
    const card = edit.locator('[data-diff]')
    await card.waitFor()
    expect(await card.getByText(scenario.shared, { exact: true }).count()).toBe(1)
    expect(await card.textContent()).toContain(`${scenario.totals} · 1 file`)
    const snapshot = await captureStableAria(page, '[data-tool="edit"]', scaffold.workspaceCwd)

    if (scenario.bounded) {
      await card.getByRole('button', { name: /^Expand \d+ more diff lines$/ }).click()
      expect(await card.getByText(scenario.shared, { exact: true }).count()).toBe(2)
      expect(await card.locator('[class*="_del_"]').count()).toBe(130)
      expect(await card.locator('[class*="_add_"]').count()).toBe(130)
      expect(await card.locator('[class*="_context_"]').count()).toBe(0)
    } else {
      expect(await card.locator('[class*="_context_"]').allTextContents()).toEqual(['level=info'])
      expect(await card.locator('[class*="_del_"]').allTextContents()).toEqual(['mode=DEBUG'])
      expect(await card.locator('[class*="_add_"]').allTextContents()).toEqual(['mode=RELEASE'])
    }
    expect(await card.textContent()).toContain(`${scenario.totals} · 1 file`)
    await disclosure.getByText('Edit', { exact: true }).click()
    await expect.poll(() => disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(await edit.locator('[data-diff]').count()).toBe(0)
    expect(await disclosure.textContent()).toContain(scenario.totals)
    await assertFixtureInventory(scenario.snapshotDir, scenario.inventory)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await compareOrRefreshGolden(join(scenario.snapshotDir, 'ui.expected.md'), snapshot, MODE)
  })
})
