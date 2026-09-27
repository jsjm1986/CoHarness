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
const LINKED_LINE_EXPECTED = join(SNAPSHOT_DIR, 'linked-line.expected.md')
const MARKDOWN_EXPECTED = join(SNAPSHOT_DIR, 'markdown.expected.md')
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
    const linkedReply = 'DONE\n\n[Line twenty-four](links.txt#L24)\n\n[Line three](links.txt#L3)'
    const seed = (await readFile(SEED, 'utf8')).replace('"text":"DONE"', `"text":${JSON.stringify(linkedReply)}`)
    const workspaceDir = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, FILE_NAME), FIRST_CONTENT)
    const linkedLines = Array.from({ length: 32 }, (_, index) => `Line ${String(index + 1)}`)
    await writeFile(join(workspaceDir, 'links.txt'), linkedLines.join('\n'))
    await writeFile(join(workspaceDir, 'guide.md'), '# Guide\n\nPacked **markdown** preview.\n')
    await mkdir(join(workspaceDir, 'assets'), { recursive: true })
    await writeFile(join(workspaceDir, 'assets/app.js'), 'document.body.dataset.packed = "yes"\n')
    await writeFile(join(workspaceDir, 'page.html'), '<!doctype html><p>HTML body</p><script src="assets/app.js"></script>\n')
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
    await toolbar.getByRole('button', { name: 'Select workbench' }).click()
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

    const previewDialog = page.getByRole('region', { name: FILE_NAME, exact: true })
    const preview = previewDialog.locator('[data-workspace-file-preview]')
    await preview.waitFor({ timeout: 15_000 }).catch(async (error: unknown) => {
      await saveFailureShot(page, 'web-e2e-workspace-files-open')
      throw error
    })
    expect(await preview.textContent()).toBe(FIRST_CONTENT)

    expect(await page.locator('[data-sidebar-right-panel]').count()).toBe(1)
    expect(await page.getByRole('dialog', { name: FILE_NAME }).count()).toBe(0)

    await page.getByRole('button', { name: 'Line twenty-four', exact: true }).click()
    const linkedPreview = page.getByRole('region', { name: 'links.txt', exact: true }).locator('[data-workspace-file-preview]')
    await expect.poll(() => linkedPreview.textContent()).toBe(linkedLines.slice(23).join('\n'))
    const linkedSnapshot = await captureStableAria(page, 'section[aria-label="links.txt"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(LINKED_LINE_EXPECTED, linkedSnapshot, MODE)
    const fileTabs = page.locator('[data-sidebar-right-panel]').getByRole('tab')
    const tabCount = await fileTabs.count()
    await page.getByRole('button', { name: 'Line three', exact: true }).click()
    await expect.poll(() => linkedPreview.textContent()).toBe(linkedLines.slice(2).join('\n'))
    expect(await fileTabs.count()).toBe(tabCount)
    await page.locator('[data-sidebar-right-panel]').getByRole('tab', { name: /notes.txt/ }).click()
    await expect.poll(() => preview.textContent()).toBe(FIRST_CONTENT)

    // Markdown renders through the accumulated authorized read; HTML packs its
    // declared sibling assets through the same Session-scoped service into an
    // opaque sandboxed frame.
    await filesButton.click()
    await browserDialog.getByRole('treeitem', { name: 'guide.md' }).click()
    const markdownDialog = page.getByRole('region', { name: 'guide.md', exact: true })
    await markdownDialog.locator('[data-workspace-markdown] h1').waitFor({ timeout: 15_000 })
    expect(await markdownDialog.locator('[data-workspace-markdown] h1').textContent()).toBe('Guide')
    const markdownSnapshot = await captureStableAria(page, 'section[aria-label="guide.md"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MARKDOWN_EXPECTED, markdownSnapshot, MODE)

    await filesButton.click()
    await browserDialog.getByRole('treeitem', { name: 'page.html' }).click()
    const htmlDialog = page.getByRole('region', { name: 'page.html', exact: true })
    const htmlFrame = htmlDialog.locator('iframe[data-workspace-html-preview]')
    await htmlFrame.waitFor({ timeout: 15_000 })
    expect(await htmlFrame.getAttribute('sandbox')).toBe('allow-scripts')
    const packedFrame = page.frameLocator('iframe[data-workspace-html-preview]')
    await expect.poll(async () => packedFrame.locator('p').textContent(), { timeout: 15_000 }).toBe('HTML body')
    await expect.poll(async () => packedFrame.locator('body').getAttribute('data-packed'), { timeout: 15_000 }).toBe('yes')
    await page.locator('[data-sidebar-right-panel]').getByRole('tab', { name: /notes.txt/ }).click()
    await preview.waitFor({ timeout: 15_000 })

    // A present observation with a fresh version marks the open resource
    // changed; the page content stays until Reload.
    await writeFile(join(workspaceDir, FILE_NAME), SECOND_CONTENT)
    await emitObservation(sessionId, FILE_NAME, true)
    const changedBadge = previewDialog.locator('[data-workspace-file-changed]')
    await changedBadge.waitFor({ timeout: 15_000 })
    expect(await changedBadge.textContent()).toBe('This file changed. Reload to see its current content.')
    expect(await preview.textContent()).toBe(FIRST_CONTENT)
    const changedSnapshot = await captureStableAria(page, `section[aria-label="${FILE_NAME}"]`, scaffold.workspaceCwd)
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

    expect(await page.locator('[data-slot-error]').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['changed.expected.md', 'linked-line.expected.md', 'markdown.expected.md'])
  }, 120_000)
})
