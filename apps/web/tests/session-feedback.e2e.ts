/** Session feedback dialog over the shipped command, Remote, and durable event path. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  launchWebScaffold, seedSession, watchConsole, captureStableAria, compareOrRefreshGolden,
  assertFixtureInventory, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const DIRECTORY = fileURLToPath(new URL('./snapshots/session-feedback', import.meta.url))
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const SESSION = SessionId('session-feedback-dialog')

describe('web e2e: Session feedback dialog', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const sessionId = await seedSession(scaffold, await readFile(SEED, 'utf8'), SESSION)
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(sessionId)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
  })
  afterAll(async () => {
    try { await browser?.close() }
    finally { await scaffold?.close() }
  })

  it('opens from the bare command and records the category without a model turn', async () => {
    if (scaffold === undefined) throw new Error('Web scaffold unavailable')
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-feedback'))
    const tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.getByText('DONE', { exact: true }).waitFor()
    const input = page.locator('textarea').first()
    await input.fill('/feedback')
    await input.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Submit feedback', exact: true })
    await dialog.waitFor()
    await expect.poll(() => input.inputValue()).toBe('')
    const session = scaffold.ctx.sessions.get(SESSION)
    if (session === undefined) throw new Error('Displayed Session unavailable')
    expect(session.snapshotEvents().filter(event => event.type === 'feedback/record')).toHaveLength(0)
    await dialog.getByRole('button', { name: 'Product features and interaction', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'Feedback details' }).fill('The sidebar needs a clearer label.')
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(DIRECTORY, 'dialog.expected.md'), snapshot, webSnapshotMode())
    await page.route('**/api/sessionFeedback/record', route => route.abort('connectionfailed'), { times: 1 })
    await dialog.getByRole('button', { name: 'Submit', exact: true }).click()
    await page.getByRole('alert').getByText('Could not save feedback', { exact: true }).waitFor()
    expect(await dialog.getByRole('textbox', { name: 'Feedback details' }).inputValue()).toBe('The sidebar needs a clearer label.')
    expect(session.snapshotEvents().filter(event => event.type === 'feedback/record')).toHaveLength(0)
    await dialog.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect.poll(() => dialog.count()).toBe(0)
    await page.getByRole('alert').getByText('Thanks for your feedback', { exact: true }).waitFor()
    expect(session.snapshotEvents().filter(event => event.type === 'feedback/record').map(event => event.data)).toEqual([
      { category: 'product-interaction', text: 'The sidebar needs a clearer label.' },
    ])
    expect(session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    expect(await page.locator('[data-slot-error]').count()).toBe(0)
  })

  it('owns only its dialog golden', async () => {
    await assertFixtureInventory(DIRECTORY, ['dialog.expected.md'])
  })
})
