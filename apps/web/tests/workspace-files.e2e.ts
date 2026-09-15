// Web e2e: Workspace file browsing — the real browser enters the workbench
// over a non-loopback authority, opens the cloud file browser for the active
// pane's Session, and converges on Host `workspace-file-changed` frames driven
// by real fs/observed emissions: a present observation raises the changed
// badge without clobbering the open page, Reload re-stats and re-reads the new
// version, and an absent observation surfaces the disappearance on the next
// read. The Session is a seeded cold log resumed through the production agent
// path, so the frame's session, ACL, and canonical-path checks all run for
// real.
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/workspace-files', import.meta.url))
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const CHANGED_EXPECTED = join(SNAPSHOT_DIR, 'changed.expected.md')
const MODE = webSnapshotMode()
const FILE_NAME = 'notes.txt'
const FIRST_CONTENT = 'alpha line\n'
const SECOND_CONTENT = 'beta line\n'

describe('web e2e: Workspace file browsing and Host change convergence', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  afterEach(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    browser = undefined
    const closing = scaffold
    scaffold = undefined
    await closing?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'workspace-files teardown failed')
  })

  /**
   * Emit one authoritative fs/observed row for `path` under the live Session's
   * cwd, through the same Host-side event the Agent tools emit.
   */
  async function emitObservation(sessionId: SessionId, path: string, present: boolean): Promise<void> {
    const host = scaffold!
    const fs = host.ctx.get('fs')
    const session = host.ctx.sessions.get(sessionId)
    if (fs === undefined || session === undefined || session.header.cwd === undefined) {
      throw new Error('workspace-files e2e: fs capability or live Session missing')
    }
    const target = await fs.resolve(path, { cwd: session.header.cwd })
    host.ctx.emit('fs/observed', target, present
      ? { kind: 'present', version: FsVersion(`e2e-${String(Date.now())}`) }
      : { kind: 'absent' }, { agent: { session } })
  }

  it.skipIf(MODE === 'record')('browses, previews, and converges on Host change frames', async () => {
    scaffold = await launchWebScaffold({
      workbench: true,
      remoteAuthority: 'app.localhost',
    })
    const seed = await readFile(SEED, 'utf8')
    const workspaceDir = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, FILE_NAME), FIRST_CONTENT)
    const workspace = await scaffold.ctx.workspaceRegistry.create(workspaceDir)
    const sessionId = await seedSession(scaffold, seed, 'ws-files', undefined, workspaceDir)
    await workspace.attachSession(sessionId)
    await scaffold.ctx.agents.resume({
      resumeSessionId: sessionId,
      setup: agentCtx => scaffold!.ctx.agentPresets.mount(agentCtx).then(() => undefined),
    })

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-files'))
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    const toolbar = page.locator('[data-workbench-toolbar]')
    await toolbar.waitFor({ timeout: 30_000 })
    await toolbar.getByRole('button', { name: '选择工作台' }).click()
    await page.getByRole('menuitem', { name: /我的工作台/ }).click()
    await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
    await picker.getByRole('button', { name: /Use the read tool twice/ }).click()
    await picker.waitFor({ state: 'hidden' })
    await page.locator('[data-session-pane]').waitFor({ timeout: 30_000 })

    // The toolbar advertises file browsing only for a connected remote
    // authority; the active pane supplies the Session address.
    const filesButton = toolbar.getByRole('button', { name: 'Workspace files' })
    await filesButton.waitFor({ timeout: 15_000 })
    await filesButton.click()
    const browserDialog = page.getByRole('dialog', { name: 'Workspace files' })
    await browserDialog.waitFor({ timeout: 10_000 })
    await browserDialog.getByRole('treeitem', { name: FILE_NAME }).click()

    const previewDialog = page.getByRole('dialog', { name: FILE_NAME })
    const preview = previewDialog.locator('[data-workspace-file-preview]')
    await expect.poll(() => preview.textContent(), { timeout: 15_000 }).toBe(FIRST_CONTENT)

    // A present observation with a fresh version marks the open resource
    // changed; the page content stays until Reload.
    await writeFile(join(workspaceDir, FILE_NAME), SECOND_CONTENT)
    await emitObservation(sessionId, FILE_NAME, true)
    const changedBadge = previewDialog.locator('[data-workspace-file-changed]')
    await changedBadge.waitFor({ timeout: 15_000 })
    expect(await changedBadge.textContent()).toBe('This file changed. Reload to see its current content.')
    expect(await preview.textContent()).toBe(FIRST_CONTENT)
    const changedSnapshot = await captureStableAria(page, `[role="dialog"][aria-label="${FILE_NAME}"]`, scaffold.workspaceCwd)
    await compareOrRefreshGolden(CHANGED_EXPECTED, changedSnapshot, MODE)

    await previewDialog.getByRole('button', { name: 'Reload' }).click()
    await expect.poll(() => preview.textContent(), { timeout: 15_000 }).toBe(SECOND_CONTENT)
    await expect.poll(() => changedBadge.count()).toBe(0)

    // An absent observation converges the same way; the next read surfaces the
    // disappearance instead of stale content.
    await rm(join(workspaceDir, FILE_NAME))
    await emitObservation(sessionId, FILE_NAME, false)
    await changedBadge.waitFor({ timeout: 15_000 })
    await previewDialog.getByRole('button', { name: 'Reload' }).click()
    await previewDialog.locator('[role="alert"]').waitFor({ timeout: 15_000 })

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['changed.expected.md'])
  }, 120_000)
})
