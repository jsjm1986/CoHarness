/** The real sidebar file tree exposes pending, empty and failed directory reads before explicit recovery. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { expect, it } from 'vitest'
import { clientSessionKey } from '@deepseek-ai/dsh-host-apiproxy/api'
import { launchWebScaffold, seedSession, watchConsole, captureStableAria, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'
import { responsiveBrowser, responsiveBrowserName } from './responsive-browser.ts'
import { auditWorkflowState, newWorkflowPage } from './workflow-responsive-state.ts'
import { saveFailureShot } from './support.ts'

it('reads real empty directories and recovers a failed child without replacing its sidebar tab', async () => {
  const world = await launchWebScaffold({ workbench: true })
  let browser: Browser | undefined
  let page: Page | undefined
  const release = Promise.withResolvers<undefined>()
  const failures: unknown[] = []
  try {
    await mkdir(join(world.workspaceCwd, 'empty'))
    await mkdir(join(world.workspaceCwd, 'recover'))
    await writeFile(join(world.workspaceCwd, 'recover', 'restored.txt'), 'Owned sidebar file recovered.\n')
    const seed = await readFile(fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url)), 'utf8')
    const session = await seedSession(world, seed, 'sidebar-files-feedback')
    await (await world.ctx.workspaceRegistry.create(world.workspaceCwd)).attachSession(session)
    browser = await responsiveBrowser.launch()
    page = await newWorkflowPage(browser)
    const target = page
    const tripwire = watchConsole(target)
    let rootReads = 0
    let childReads = 0
    await target.route('**/api/workspaceFiles.list*', async (route) => {
      const request = route.request().postDataJSON() as { payload: { path?: string } }
      if (request.payload.path === undefined && rootReads++ === 0) await release.promise
      if (request.payload.path === 'recover' && childReads++ === 0) {
        await route.fulfill({ status: 503, body: 'Fixture directory reader is unavailable' })
      } else await route.continue()
    })
    await target.addInitScript((key) => { localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: key })) },
      clientSessionKey({ kind: 'personal' }, session))
    await target.goto(world.authenticatedUrl, { waitUntil: 'load' })
    await target.getByText('DONE', { exact: true }).waitFor()
    await target.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
    await target.locator('[data-sidebar-right-guide-entry="files"]').click()
    const tree = target.locator('[data-files-state="tree"]')
    const reload = tree.locator('[data-files-reload]')
    const loading = tree.locator('[data-files-row="loading"]')
    await loading.waitFor()
    await auditWorkflowState(target, 'sidebar-files', 'root-loading', tree, [loading, reload])
    release.resolve(undefined)
    const empty = tree.getByRole('button', { name: 'empty', exact: true })
    await empty.click()
    const emptyDirectory = empty.locator('..')
    const emptyMessage = emptyDirectory.getByText('Empty directory', { exact: true })
    await emptyMessage.waitFor()
    await auditWorkflowState(target, 'sidebar-files', 'empty-child', tree, [empty, emptyMessage])
    const recover = tree.getByRole('button', { name: 'recover', exact: true })
    await recover.click()
    const failed = tree.locator('[data-files-row="failed"]')
    await failed.waitFor()
    expect(await failed.innerText()).toContain('Read failed:')
    await auditWorkflowState(target, 'sidebar-files', 'failed-child', tree, [failed, reload])
    await reload.click()
    await failed.waitFor({ state: 'hidden' })
    const restored = tree.getByRole('button', { name: 'restored.txt', exact: true })
    await restored.waitFor()
    expect(await recover.getAttribute('aria-expanded')).toBe('true')
    expect(await empty.getAttribute('aria-expanded')).toBe('true')
    expect(childReads).toBe(2)
    await auditWorkflowState(target, 'sidebar-files', 'recovered-child', tree, [restored, reload])
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/frontend-responsiveness/sidebar-files.expected.md', import.meta.url)),
      await captureStableAria(target, '[data-files-state="tree"]', world.workspaceCwd), webSnapshotMode())
    await restored.click()
    await target.locator('[data-workspace-file-preview]').filter({ hasText: 'Owned sidebar file recovered.' }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (page !== undefined) await saveFailureShot(page, `sidebar-files-${responsiveBrowserName}`)
    failures.push(error)
  } finally {
    release.resolve(undefined)
    for (const close of [() => page?.unrouteAll({ behavior: 'wait' }), () => browser?.close(), () => world.close()]) {
      try { await close() } catch (error) { failures.push(error) }
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Sidebar file feedback verification failed')
})
