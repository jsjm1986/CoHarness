/** Real Host mod rendering and actions remain usable in the assembled composer. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {} from '@deepseek-ai/dsh-experimental-claude-code-mods'
import type { Browser } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { captureStableAria, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { responsiveBrowser } from './responsive-browser.ts'
import { auditWorkflowState, compareWorkflowGolden, newWorkflowPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'
import { REPO_ROOT, saveFailureShot } from './support.ts'

let scaffold: WebScaffold
let browser: Browser
let scratch: string
let releaseAction: (() => void) | undefined
const sessionId = 'responsive-mods-band'

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-mods-band-'))
  const plugins = ['claude-code-mods', 'client-ui-claude-code-mods']
  const overlay = join(scratch, 'mods.patch.yml')
  await writeFile(overlay, '- insert:\n' + plugins.map(name =>
    `    - id: responsive-${name}\n      name: '@deepseek-ai/dsh-experimental-${name}'\n`).join(''))
  scaffold = await launchWebScaffold({ extraOverlayPath: [overlay],
    extraInstallAnchors: plugins.map(name => join(REPO_ROOT, 'packages/experimental', name, 'package.json')) })
  await seedSession(scaffold, await readFile(join(REPO_ROOT, 'apps/web/tests/snapshots/seeded-history/seed.jsonl'), 'utf8'), sessionId)
  await scaffold.ctx.plugin({ inject: ['claudeCodeMods'], apply(ctx) {
    let completed = 0
    ctx.effect(() => ctx.claudeCodeMods.add({ name: 'responsive-band', register(on) {
      on('ui.render', { component: 'AbovePrompt' }, ($, event) => {
        const { Box, Text, Button } = $.ui.resolve(event)
        return Box({ flexDirection: 'row', gap: 2, border: true, children: [
          Text({ children: `Reviewed ${completed} changes. Keep the original draft while working through the shared review.`, color: 'cyan' }),
          Button({ label: 'Review next change', hotkey: 'R', onPress: async () => {
            await new Promise<void>((resolve) => { releaseAction = resolve })
            completed++
          } }),
          Button({ label: 'Show action failure', onPress: () => { throw new Error('This review action could not be completed.') } }),
          Button({ label: 'Unavailable action', disabled: true }),
        ] })
      })
    } }))
  } })
  browser = await responsiveBrowser.launch()
}, 120_000)

afterAll(async () => {
  releaseAction?.()
  try { await browser?.close() } finally {
    try { await scaffold?.close() } finally { if (scratch) await rm(scratch, { recursive: true, force: true }) }
  }
})

it('preserves the draft through mod actions, pending feedback and recoverable failure', async () => {
  const page = await newWorkflowPage(browser)
  const tripwire = watchConsole(page)
  await page.addInitScript((id) => { if (window === window.top) localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id })) }, sessionId)
  try {
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    const band = page.getByRole('group', { name: 'Claude Code mods', exact: true })
    await band.waitFor()
    const input = page.locator('[data-composer-card] textarea:enabled')
    await input.fill('Keep this unsent review draft.')
    await auditWorkflowState(page, 'claude-mods', 'ready', band)
    await band.getByRole('button', { name: 'Review next change', exact: false }).click()
    await expect.poll(() => band.locator('[aria-busy="true"]').count()).toBe(1)
    expect(await band.getByRole('button', { name: 'Show action failure', exact: true }).isDisabled()).toBe(true)
    await auditWorkflowState(page, 'claude-mods', 'pending', band)
    releaseAction?.()
    await band.getByText(/^Reviewed 1 changes\./u).waitFor()
    await band.getByRole('button', { name: 'Show action failure', exact: true }).click()
    const failure = band.getByRole('status')
    await failure.waitFor()
    expect(await failure.textContent()).toContain('This review action could not be completed.')
    await auditWorkflowState(page, 'claude-mods', 'action-failure', band)
    expect(await input.inputValue()).toBe('Keep this unsent review draft.')
    await compareWorkflowGolden(join(REPO_ROOT, 'apps/web/tests/expected/mods-band/ui.expected.md'),
      await captureStableAria(page, '[role="group"][aria-label="Claude Code mods"]', scaffold.workspaceCwd), webSnapshotMode())
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    await saveFailureShot(page, 'mods-band-responsive')
    throw error
  } finally { releaseAction?.(); await page.close() }
}, workflowMatrixEnabled ? 180_000 : 60_000)
