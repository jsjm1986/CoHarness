/** Shipped Web Host and built Client preserve restored drafts while admitting a fresh conversation. */
import { auditWorkflowState, newWorkflowPage, compareWorkflowGolden } from './workflow-responsive-state.ts'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { responsiveBrowser } from './responsive-browser.ts'
import { expect, it, onTestFinished, onTestFailed } from 'vitest'
import { installAgentExecutionAdmission } from '@deepseek-ai/dsh-agent'
import { captureStableAria, launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const mode = webSnapshotMode()
const expected = fileURLToPath(new URL('./expected/recovery-read-only/', import.meta.url))

it.skipIf(mode === 'record')('retains a restored history draft and sends only from a new conversation', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-recovery-browser-'))
  onTestFinished(() => rm(temporary, { recursive: true, force: true }))
  const override = join(temporary, 'replay.override.json')
  const reply = 'RECOVERY_NEW_CONVERSATION_ACCEPTED'
  await writeFile(override, JSON.stringify([{ kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: reply },
    { type: 'block-end', index: 0, block: { type: 'text', text: reply } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] }]))
  const host = await launchWebScaffold({ replayFixture: join(temporary, 'override-only.jsonl'), replayOverride: override, paceMs: 25 })
  onTestFinished(() => host.close())
  const seed = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v7.jsonl', import.meta.url))
  const oldId = await seedSession(host, await readFile(seed, 'utf8'), 'recovered-history')
  const workspace = await host.ctx.workspaceRegistry.create(host.workspaceCwd)
  await workspace.attachSession(oldId)
  const browser = await responsiveBrowser.launch()
  onTestFinished(() => browser.close())
  const page = await newWorkflowPage(browser)
  onTestFailed(() => saveFailureShot(page, 'recovery-read-only'))
  const tripwire = watchConsole(page)
  await page.addInitScript((id) =>{  localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id })) }, oldId)
  await page.goto(host.authenticatedUrl)
  const composer = page.locator('textarea').last()
  await expect.poll(() => composer.isEnabled()).toBe(true)
  const draft = 'This unsent draft belongs to the restored historical conversation.'
  await composer.fill(draft)
  // Install the same process-owned admission used by recovery startup after saving an ordinary tab draft.
  // The full startup/profile and immutable-inbox assembly is exercised in the recovery Runtime test.
  host.ctx.effect(() => installAgentExecutionAdmission(host.ctx, [oldId]))
  const activationRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/session.activate')) {
      const body = request.postDataJSON() as { payload: { sessionId: string } }
      activationRequests.push(body.payload.sessionId)
    }
  })
  await page.reload()
  const history = page.locator('textarea[placeholder="Restored conversation is read-only"]')
  await history.waitFor()
  expect(await history.isDisabled()).toBe(true)
  expect(await history.inputValue()).toBe(draft)
  await page.getByText('This conversation was restored from backup. History and drafts are retained. Start a new conversation to work; old tasks remain paused.', { exact: true }).waitFor()
  expect(activationRequests).not.toContain(oldId)
  await auditWorkflowState(page, 'conversation', 'restored-read-only-draft', page.locator('[data-conversation-region="composer"]'), [history])
  await mkdir(expected, { recursive: true })
  await compareWorkflowGolden(join(expected, 'history.expected.md'),
    await captureStableAria(page, '[data-conversation-region="composer"]', host.workspaceCwd), mode)
  const artifacts = process.env.HGW_TEST_UI_ARTIFACTS
  if (artifacts) {
    await mkdir(artifacts, { recursive: true })
    await page.screenshot({ path: join(artifacts, 'user-recovery-history-desktop.png'), fullPage: true })
  }
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await history.inputValue()).toBe(draft)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  if (artifacts) await page.screenshot({ path: join(artifacts, 'user-recovery-history-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1680, height: 1000 })
  await page.getByRole('button', { name: /^New session in /u }).first().click()
  const fresh = page.locator('textarea:enabled').last()
  await fresh.waitFor()
  expect(await fresh.inputValue()).toBe('')
  await fresh.fill('Confirm this new conversation can execute.')
  const settled = host.whenTurnSettled()
  await fresh.press('Enter')
  const newId = await settled
  expect(newId).not.toBe(oldId)
  await page.getByText(reply, { exact: true }).waitFor()
  await auditWorkflowState(page, 'conversation', 'restored-new-executable', page.locator('[class*="centerCol"]'), [fresh])
  await compareWorkflowGolden(join(expected, 'new-conversation.expected.md'),
    await captureStableAria(page, '[data-conversation-region="composer"]', host.workspaceCwd), mode)
  if (artifacts) await page.screenshot({ path: join(artifacts, 'user-recovery-new-conversation.png'), fullPage: true })
  await page.getByRole('treeitem').filter({ has: page.getByText('Use the read tool twice', { exact: true }) }).click()
  await history.waitFor()
  expect(await history.inputValue()).toBe(draft)
  expect(activationRequests).not.toContain(oldId)
  expect(tripwire.pageErrors).toEqual([])
})
