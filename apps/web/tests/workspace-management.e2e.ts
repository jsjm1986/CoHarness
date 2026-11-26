// Web e2e scenarios: workspace management — adding a workspace through the
// composed directory dialog (its own New folder affordance is the product's
// one creation route), the dialog's path editor walking the panes with the
// typed draft, same-basename directory adoption, the rename round
// trip over the real wire (workspace.rename RPC + durable registry), the
// duplicate-name pre-check, the
// flat "In one list" view with its persisted group-by preference, the session
// hover card and row action menu, and the session archive round trip (row
// menu → workspace.archiveSession RPC → durable global set → row hidden
// across reload). Zero model calls: workspace.create/rename/archiveSession
// are host RPCs with no model involvement, and the one session row the
// flat/hover/menu/archive scenarios need comes from a seeded fixture (the
// seeded-history seed reused verbatim — no new recording).
import { responsiveBrowser, responsiveBrowserName, responsiveViewports } from './responsive-browser.ts'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, sep } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'

import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureDom, saveFailureShot } from './support.ts'
import { auditWorkflowState, compareWorkflowGolden, newWorkflowPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'
import { auditResponsiveControl } from './responsive-controls.ts'
import { captureTextContrast, expectTextContrast } from './text-contrast.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/workspace-management', import.meta.url))
// The seed is another scenario's committed fixture, reused read-only: this
// spec needs any one cold session row, not new recorded content.
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const BROWSER_EXPECTED = join(SNAPSHOT_DIR, 'directory-browser.expected.md')
const SEED_ID = 'workspace-management-web-e2e'
// Both waits exceed ui-primitives' 200ms POINTER_GRACE_MS. Keep them above
// that value if the shared setting changes.
const POINTER_TRANSIT_MS = 300
const POINTER_HOLD_MS = 600

describe('web e2e: workspace management (create / rename / flat view / hover affordances)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const auditedStates = new Set<string>()

  async function audit(state: string, surface: Locator, controls: readonly Locator[] = [], prepare?: () => Promise<void>): Promise<void> {
    if (auditedStates.has(state)) return
    await auditWorkflowState(page, 'workspace', state, surface, controls, prepare)
    auditedStates.add(state)
  }

  async function showSidebar(target = page): Promise<void> {
    const width = target.viewportSize()!.width
    const mode = width < 768 ? 'compact' : width < 1024 ? 'medium' : width < 1440 ? 'expanded' : 'wide'
    await expect.poll(() => target.locator('[data-viewport]').first().getAttribute('data-viewport')).toBe(mode)
    const open = target.getByRole('button', { name: 'Open sidebar', exact: true })
    if (await open.isVisible()) {
      if (workflowMatrixEnabled) await open.tap()
      else await open.click()
    }
  }

  async function auditSidebar(state: string): Promise<void> {
    await audit(state, page.locator('[class*="sidebarCol"], [class*="drawer"][data-open]').filter({ has: page.getByRole('button', { name: 'Add workspace' }) }), [], showSidebar)
  }

  /**
   * Raise the region header's directory dialog and drive it to a directory via
   * the path-edit affordance. Adding is the header button's only action, so
   * the click lands in the dialog with no menu in between.
   */
  async function browseTo(path: string): Promise<Locator> {
    await page.getByRole('button', { name: 'Add workspace' }).click()
    const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Edit path' }).click()
    const pathInput = dialog.locator('input[aria-label="Edit path"]')
    await pathInput.fill(path)
    await pathInput.press('Enter')
    return dialog
  }

  /**
   * Create a folder inside `parent` through the dialog and adopt it — the
   * product's only route to a brand-new workspace directory.
   */
  async function addNewFolderWorkspace(parent: string, name: string): Promise<void> {
    const dialog = await browseTo(parent)
    await dialog.getByRole('button', { name: 'New folder' }).click()
    await page.getByLabel('Folder name').fill(name)
    const create = page.getByRole('button', { name: 'Create', exact: true })
    await audit('new-folder', create.locator('xpath=ancestor::*[@role="dialog"][1]'), [create, page.getByLabel('Folder name')])
    await create.click()
    // Creating selects the new folder in the listing; Open adopts it.
    await dialog.getByRole('button', { name: 'Open', exact: true }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    await expect.poll(
      () => scaffold.ctx.workspaceRegistry.resolveByPath(join(parent, name)),
      { timeout: 10_000 },
    ).not.toBeUndefined()
  }

  /**
   * Adopt an existing directory, waiting for the adoption to settle host-side
   * (workspace registered + the flow's New-Session agent up), so later test
   * steps can't race the in-flight blank-session attach.
   */
  async function adoptDirectory(path: string, options: { waitForAgent?: boolean } = {}): Promise<void> {
    const agentsBefore = scaffold.ctx.agents.list().length
    const dialog = await browseTo(path)
    await dialog.getByRole('button', { name: 'Open', exact: true }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    await expect.poll(
      () => scaffold.ctx.workspaceRegistry.resolveByPath(path),
      { timeout: 10_000 },
    ).not.toBeUndefined()
    // First adoption births a blank Session+Agent whose workspace attach must
    // settle before a test may delete the registration; re-registration after
    // a delete mints a fresh blank Session+Agent too (no cwd-based reuse
    // exists), so callers opt in only where a fresh attach is possible.
    if (options.waitForAgent === true) {
      await expect.poll(() => scaffold.ctx.agents.list().length, { timeout: 10_000 })
        .toBeGreaterThan(agentsBefore)
    }
  }

  /**
   * Reveal and click a row action, re-hovering if a projection update replaces
   * the row before its hover-only button becomes visible. Scroll, hover, and
   * the click share one bounded retry: a projection refresh can replace the
   * row node between any two of them, dropping :hover and unmounting the
   * button for good, and a scroll/hover stall must also land in the evidence
   * dump rather than escaping the deadline.
   */
  async function clickHoverAction(row: Locator, name: string): Promise<void> {
    const button = row.getByRole('button', { name })
    if (workflowMatrixEnabled) { await button.tap(); return }
    const deadline = Date.now() + 30_000
    for (;;) {
      try {
        await row.scrollIntoViewIfNeeded({ timeout: 2_000 })
        await row.hover({ timeout: 2_000 })
        await button.click({ timeout: 2_000 })
        return
      } catch (error) {
        if (Date.now() >= deadline) {
          await saveFailureDom(page, 'web-e2e-ws-hover')
          throw error
        }
      }
    }
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // Seed one cold session (Ungrouped bucket) for the flat view + hover card.
    const sessionCwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(sessionCwd, { recursive: true })
    await writeFile(join(sessionCwd, 'a.txt'), 'alpha\n')
    await writeFile(join(sessionCwd, 'b.txt'), 'beta\n')
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SEED_ID)
    browser = await responsiveBrowser.launch()
    page = await newWorkflowPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('adds two workspaces through the dialog, each on a folder it created', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-create'))
    const add = async (name: string): Promise<void> => {
      await addNewFolderWorkspace(scaffold.workspaceCwd, name)
      // The real workspace materializes in the tree as a group row.
      await expect.poll(() => page.getByText(name, { exact: true }).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    }
    await add('alpha-ws')
    await add('beta-ws')
    // Durable on the host: both registered, newest first (create prepends),
    // each titled after the folder the dialog made.
    const titles = scaffold.ctx.workspaceRegistry.list().map(workspace => workspace.title)
    expect(titles.slice(0, 2)).toEqual(['beta-ws', 'alpha-ws'])
    await auditSidebar('workspace-created')
    if (workflowMatrixEnabled) {
      const original = page.viewportSize()!
      for (const viewport of [{ width: 568, height: 320 }, { width: 872, height: 230 }]) {
        await page.setViewportSize(viewport)
        await page.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
        }))
        await showSidebar()
        const create = page.getByRole('button', { name: 'New session in beta-ws', exact: true })
        await create.scrollIntoViewIfNeeded()
        const directory = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
        if (directory !== undefined) await page.screenshot({ path: join(directory, `workspace-new-session-${viewport.width}.png`), animations: 'disabled' })
        await create.tap()
        await page.locator('textarea:enabled').waitFor()
      }
      await page.setViewportSize(original)
      await showSidebar()
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('renames a workspace over the wire with a duplicate-name pre-check', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-rename'))
    const alphaRow = page.locator('[role="treeitem"]').filter({ hasText: 'alpha-ws' }).first()
    await clickHoverAction(alphaRow, 'Workspace actions for alpha-ws')
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const dialog = page.getByRole('dialog', { name: 'Rename workspace' })
    await dialog.waitFor({ timeout: 10_000 })
    const input = dialog.getByLabel('Workspace name')
    // Client pre-check: a name colliding with another live workspace raises
    // the inline alert and blocks the primary button before any wire call.
    await input.fill('beta-ws')
    await expect.poll(() => dialog.getByRole('alert').count(), { timeout: 5_000 }).toBe(1)
    expect(await dialog.getByRole('button', { name: 'Rename' }).isDisabled()).toBe(true)
    await audit('rename-conflict', dialog, [input, dialog.getByRole('button', { name: 'Cancel' })])
    // A fresh name goes through workspace.rename to the durable registry.
    await input.fill('gamma-ws')
    await expect.poll(() => dialog.getByRole('alert').count(), { timeout: 5_000 }).toBe(0)
    await audit('rename-valid', dialog, [input, dialog.getByRole('button', { name: 'Rename' })])
    await input.dispatchEvent('compositionstart')
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    expect(await input.isEnabled()).toBe(true)
    await input.dispatchEvent('compositionend')
    await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 })
    expect(await input.isEnabled()).toBe(true)
    expect(scaffold.ctx.workspaceRegistry.list().map(workspace => workspace.title)).toContain('alpha-ws')
    await dialog.getByRole('button', { name: 'Rename' }).click()
    await expect.poll(() => page.getByRole('dialog', { name: 'Rename workspace' }).count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => page.getByText('gamma-ws', { exact: true }).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    expect(await page.getByText('alpha-ws', { exact: true }).count()).toBe(0)
    // Host durability, then reload: the projection is rebuilt from the wire.
    expect(scaffold.ctx.workspaceRegistry.list().map(workspace => workspace.title)).toContain('gamma-ws')
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(() => page.getByText('gamma-ws', { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('deletes only the Workspace registration and keeps its current Session, folder, and log', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-delete'))
    const slotConsoleErrors: string[] = []
    const transientSlotErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error' && /slot entry crashed/i.test(message.text())) {
        slotConsoleErrors.push(message.text())
      }
    })
    await page.exposeFunction('recordDshSlotError', (key: string) => {
      if (!transientSlotErrors.includes(key)) transientSlotErrors.push(key)
    })
    await page.evaluate(() => {
      const target = window as unknown as { recordDshSlotError(key: string): Promise<void> }
      const seen = new Set<string>()
      const collect = (): void => {
        for (const node of document.querySelectorAll<HTMLElement>('[data-slot-error]')) {
          const key = node.dataset.slotError ?? ''
          if (!seen.has(key)) {
            seen.add(key)
            void target.recordDshSlotError(key)
          }
        }
      }
      new MutationObserver(collect).observe(document.documentElement, { childList: true, subtree: true })
      collect()
    })
    // Register the scaffold's existing project directory through the real UI.
    await adoptDirectory(scaffold.workspaceCwd, { waitForAgent: true })
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(scaffold.workspaceCwd)
    if (workspace === undefined) throw new Error('GUI did not register the existing project directory')
    await workspace.attachSession(SessionId(SEED_ID))
    const header = (await scaffold.ctx.sessionPersistence.listHeaders())
      .find(candidate => candidate.id === SEED_ID)
    if (header === undefined) throw new Error('seeded Session log disappeared before deletion')
    const logLocation = scaffold.ctx.sessionPersistence.locate(header)
    if (logLocation === undefined) throw new Error('JSONL persistence did not expose the seeded log path')
    expect(await readFile(join(scaffold.workspaceCwd, 'workspace', 'a.txt'), 'utf8')).toBe('alpha\n')
    await stat(logLocation.path)

    // Open the seeded (first/accounted) Session so deletion must preserve the
    // current selection while it moves into Ungrouped.
    const groupRow = page.locator('[role="treeitem"]').filter({ hasText: workspace.title }).first()
    await groupRow.waitFor({ timeout: 10_000 })
    // The header row is wrapped by its HoverCard anchor span, so the section
    // is the nearest groupSection ancestor, not the immediate parent.
    const groupSection = groupRow.locator('xpath=ancestor::*[contains(@class, "groupSection")][1]')
    await expect.poll(async () => {
      const count = await groupSection.locator('[role="treeitem"]').count()
      if (count < 2 && await groupRow.getAttribute('aria-expanded') !== 'true') {
        await groupRow.click()
        await page.waitForTimeout(50)
      }
      return await groupSection.locator('[role="treeitem"]').count()
    }, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    const seededRow = groupSection.locator('[role="treeitem"]').nth(1)
    await seededRow.click()
    await expect.poll(() => seededRow.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')

    await clickHoverAction(groupRow, `Workspace actions for ${workspace.title}`)
    await page.getByRole('menuitem', { name: 'Delete workspace' }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete workspace' })
    await dialog.waitFor({ timeout: 10_000 })
    const copy = await dialog.textContent()
    expect(copy).toContain('workspace list')
    expect(copy).toContain('folder and session logs will be kept')
    expect(copy).toContain('sessions will appear under “Independent sessions”')
    await audit('delete-confirmation', dialog, [dialog.getByRole('button', { name: 'Delete workspace' }), dialog.getByRole('button', { name: 'Cancel' })])
    await dialog.getByRole('button', { name: 'Delete workspace' }).click()
    await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(0)

    expect(scaffold.ctx.workspaceRegistry.get(workspace.id)).toBeUndefined()
    await expect.poll(
      () => page.getByRole('button', { name: `Workspace actions for ${workspace.title}` }).count(),
      { timeout: 10_000 },
    ).toBe(0)
    await expect.poll(() => page.getByText('Independent sessions', { exact: true }).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1)
    // The Ungrouped bucket collapses by default; disclose it so the retained
    // session row is rendered before asserting it kept the selection.
    const ungrouped = page.getByRole('treeitem', { name: /^Independent sessions/ })
    if (await ungrouped.getAttribute('aria-expanded') !== 'true') await ungrouped.click()
    await expect.poll(
      () => page.locator('[role="treeitem"][aria-selected="true"]').count(),
      { timeout: 10_000 },
    ).toBe(1)
    expect(await readFile(join(scaffold.workspaceCwd, 'workspace', 'a.txt'), 'utf8')).toBe('alpha\n')
    await stat(logLocation.path)
    expect((await scaffold.ctx.sessionPersistence.inspect(SessionId(SEED_ID))).events.length).toBeGreaterThan(0)

    // Re-registering the exact deleted path immediately, without a reload, is
    // a supported reversible flow. It creates a fresh Workspace id and does
    // NOT re-adopt the retained (non-blank) Session. A new blank Session is
    // created only after the user explicitly starts one in this flow.
    await adoptDirectory(scaffold.workspaceCwd)
    await expect.poll(
      () => scaffold.ctx.workspaceRegistry.resolveByPath(scaffold.workspaceCwd),
      { timeout: 10_000 },
    ).not.toBeUndefined()
    const reregistered = await scaffold.ctx.workspaceRegistry.resolveByPath(scaffold.workspaceCwd)
    expect(reregistered?.id).toBeDefined()
    expect(reregistered?.id).not.toBe(workspace.id)
    expect(reregistered?.sessionIds).not.toContain(SEED_ID)
    await expect.poll(() => page.getByText('Independent sessions', { exact: true }).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1)
    expect(await readFile(join(scaffold.workspaceCwd, 'workspace', 'a.txt'), 'utf8')).toBe('alpha\n')
    await stat(logLocation.path)

    // Restore the deleted-registry state so reload still verifies deletion
    // persistence independently of the successful re-registration above.
    if (reregistered === undefined) throw new Error('same-path re-registration did not materialize')
    await scaffold.ctx.workspaceRegistry.delete(reregistered.id)
    await expect.poll(
      () => page.getByRole('button', { name: `Workspace actions for ${reregistered.title}` }).count(),
      { timeout: 10_000 },
    ).toBe(0)

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(() => page.getByText('Independent sessions', { exact: true }).count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1)
    await expect.poll(
      () => page.locator('[role="treeitem"][aria-selected="true"]').count(),
      { timeout: 15_000 },
    ).toBe(1)
    expect(scaffold.ctx.workspaceRegistry.get(workspace.id)).toBeUndefined()
    expect(await readFile(join(scaffold.workspaceCwd, 'workspace', 'a.txt'), 'utf8')).toBe('alpha\n')
    await stat(logLocation.path)
    expect((await scaffold.ctx.sessionPersistence.inspect(SessionId(SEED_ID))).events.length).toBeGreaterThan(0)

    expect(transientSlotErrors).toEqual([])
    expect(slotConsoleErrors).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('reuses a deleted title for a different new directory without any transient error surface', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-reuse-title'))
    const title = 'same-name'
    const oldPath = join(scaffold.workspaceCwd, 'adopted', title)
    await mkdir(oldPath, { recursive: true })
    const transientErrors: string[] = []
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await page.exposeFunction('recordDshTransientWorkspaceError', (message: string) => {
      if (!transientErrors.includes(message)) transientErrors.push(message)
    })
    await page.evaluate(() => {
      const target = window as unknown as {
        recordDshTransientWorkspaceError(message: string): Promise<void>
      }
      const collect = (): void => {
        for (const node of document.querySelectorAll<HTMLElement>('[data-slot-error], [role="alert"]')) {
          const message = node.dataset.slotError ?? node.textContent?.trim() ?? ''
          if (message !== '') void target.recordDshTransientWorkspaceError(message)
        }
      }
      new MutationObserver(collect).observe(document.documentElement, { childList: true, subtree: true })
      collect()
    })

    await adoptDirectory(oldPath)
    await expect.poll(
      () => scaffold.ctx.workspaceRegistry.resolveByPath(oldPath),
      { timeout: 10_000 },
    ).not.toBeUndefined()
    const oldWorkspace = await scaffold.ctx.workspaceRegistry.resolveByPath(oldPath)
    if (oldWorkspace === undefined) throw new Error('old same-name Workspace was not registered')

    const oldRow = page.locator('[role="treeitem"]').filter({ hasText: title }).first()
    await clickHoverAction(oldRow, `Workspace actions for ${title}`)
    await page.getByRole('menuitem', { name: 'Delete workspace' }).click()
    await page.getByRole('dialog', { name: 'Delete workspace' })
      .getByRole('button', { name: 'Delete workspace' }).click()
    await expect.poll(() => scaffold.ctx.workspaceRegistry.get(oldWorkspace.id), { timeout: 10_000 }).toBeUndefined()

    await addNewFolderWorkspace(scaffold.workspaceCwd, title)
    const fresh = scaffold.ctx.workspaceRegistry.list().find(workspace => workspace.title === title)
    expect(fresh?.id).toBeDefined()
    expect(fresh?.id).not.toBe(oldWorkspace.id)
    expect(fresh?.path).toBe(join(scaffold.workspaceCwd, title))
    expect(transientErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('switches to the flat "In one list" view and persists the preference', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-flat'))
    // Grouped default: workspace group rows render (the seeded session sits
    // under Ungrouped; the created workspaces are empty groups).
    await expect.poll(() => page.getByText('Workspaces', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    // Grouping and ordering moved into the View options menu.
    await page.getByRole('button', { name: 'View options' }).click()
    await page.getByRole('menuitem', { name: 'In one list' }).click()
    // Flat mode: the section label flips and the seeded session is a
    // top-level row with no group headers above it.
    await expect.poll(() => page.getByText('Sessions', { exact: true }).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    await expect.poll(() => page.getByText('Independent sessions', { exact: true }).count(), { timeout: 5_000 }).toBe(0)
    await expect.poll(() => page.locator('[role="treeitem"]').count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    expect(await page.evaluate(() => localStorage.getItem('dsh.workspace.view.v5'))).toContain('flat')
    await auditSidebar('flat-list')
    // Persisted across reload; then restore grouped for inter-spec hygiene.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(() => page.getByText('Independent sessions', { exact: true }).count(), { timeout: 15_000 }).toBe(0)
    await page.getByRole('button', { name: 'View options' }).click()
    await page.getByRole('menuitem', { name: 'WorkSpace', exact: true }).click()
    await expect.poll(() => page.getByText('Independent sessions', { exact: true }).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('matches the directory-browser dialog aria golden at a staged directory', async () => {
    // A staged subtree under the scaffold cwd keeps the listing deterministic
    // (normalizeAria scrubs the cwd), and pointing the in-process host's HOME
    // at the cwd collapses the breadcrumb ancestry into the Home crumb — no
    // machine-specific path segments or real $HOME contents enter the golden.
    const staged = join(scaffold.workspaceCwd, 'browse-golden')
    await mkdir(join(staged, 'alpha'), { recursive: true })
    await mkdir(join(staged, 'beta'), { recursive: true })
    // homedir() reads HOME on POSIX and USERPROFILE on Windows: root both
    // at the scaffold cwd so the golden's ancestry collapses everywhere.
    const realHome = process.env.HOME
    const realUserProfile = process.env.USERPROFILE
    process.env.HOME = scaffold.workspaceCwd
    process.env.USERPROFILE = scaffold.workspaceCwd
    try {
      const dialog = await browseTo(staged)
      await expect.poll(() => dialog.getByText('alpha', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
      await audit('directory-browser', dialog, [dialog.getByRole('button', { name: 'Open', exact: true }), dialog.getByRole('button', { name: 'New folder' })])
      if (workflowMatrixEnabled) {
        const original = page.viewportSize()!
        for (const viewport of [{ width: 568, height: 320 }, { width: 872, height: 230 }]) {
          await page.setViewportSize(viewport)
          const folder = dialog.getByRole('button', { name: 'alpha', exact: true })
          await folder.scrollIntoViewIfNeeded()
          expect((await folder.boundingBox())!.height).toBeGreaterThanOrEqual(44)
          const directory = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
          if (directory !== undefined) await page.screenshot({ path: join(directory, `workspace-folder-${viewport.width}.png`), animations: 'disabled' })
          await folder.tap()
          await dialog.getByRole('button', { name: 'browse-golden', exact: true }).click()
          await expect.poll(() => dialog.getByRole('button', { name: 'alpha', exact: true }).count()).toBe(1)
        }
        await page.setViewportSize(original)
      }
      const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
      try {
        await compareWorkflowGolden(BROWSER_EXPECTED, snapshot, MODE)
      } finally {
        await dialog.getByRole('button', { name: 'Cancel' }).click()
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
      }
    } finally {
      if (realHome === undefined) delete process.env.HOME
      else process.env.HOME = realHome
      if (realUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = realUserProfile
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('walks the panes with the typed path: deeper past a separator, back up on erase, whole on a miss', async () => {
    // The panes must track the draft without leaving the editor, so the
    // typed text and what is listed under it never disagree.
    // Staged by this scenario itself (mkdir is recursive and idempotent), so
    // running it alone through -t sees the same tree the assertions describe.
    const staged = join(scaffold.workspaceCwd, 'browse-golden')
    await mkdir(join(staged, 'alpha', 'only-under-alpha'), { recursive: true })
    await mkdir(join(staged, 'beta'), { recursive: true })
    const dialog = await browseTo(staged)
    await expect.poll(() => dialog.getByText('alpha', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await dialog.getByRole('button', { name: 'Edit path' }).click()
    const path = dialog.getByLabel('Edit path')
    // A directory part no pane lists: the panes walk to it, landing the
    // ordinary two-pane Miller view (level | its children) with the editor
    // still up and the draft intact.
    await path.fill(`${join(staged, 'alpha')}${sep}`)
    await expect.poll(() => dialog.getByText('only-under-alpha', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => dialog.getByRole('list').count(), { timeout: 10_000 }).toBe(2)
    expect(await path.inputValue()).toBe(`${join(staged, 'alpha')}${sep}`)
    await audit('path-deep-directory', dialog, [path])
    // Erasing back past the separator walks the panes up, so the level being
    // typed is the last pane again (its children no longer stand to its
    // right) and the tail filters it.
    await path.fill(`${staged}${sep}al`)
    await expect.poll(() => dialog.getByText('only-under-alpha', { exact: true }).count(), { timeout: 10_000 }).toBe(0)
    expect(await dialog.getByText('alpha', { exact: true }).count()).toBe(1)
    expect(await dialog.getByText('beta', { exact: true }).count()).toBe(0)
    await expect.poll(() => dialog.getByRole('list').count(), { timeout: 10_000 }).toBe(2)
    await audit('path-filter', dialog, [path])
    // A tail nobody matches is a name still being spelled: the level shows
    // whole instead of emptying under it.
    await path.fill(`${staged}${sep}zzz`)
    await expect.poll(() => dialog.getByText('beta', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    expect(await dialog.getByText('alpha', { exact: true }).count()).toBe(1)
    await audit('path-no-match', dialog, [path])
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, workflowMatrixEnabled ? 180_000 : 60_000)

  /**
   * Expand Ungrouped and return its seeded session row. The only visible child
   * is the non-blank persisted Session; the blank Session created while
   * adopting the Workspace stays hidden.
   * @param target - the page owning the sidebar.
   * @returns the session row locator, already present.
   */
  async function seededSessionRow(target = page) {
    const ungroupedRow = target.getByText('Independent sessions', { exact: true }).locator('..').locator('..')
    const ungroupedSection = ungroupedRow.locator('..')
    // Initial-current auto-expansion can race this gesture; converge on
    // expanded rather than assuming which update wins first.
    await expect.poll(async () => {
      if (await ungroupedRow.getAttribute('aria-expanded') !== 'true') {
        await target.getByText('Independent sessions', { exact: true }).click()
        await target.waitForTimeout(50)
      }
      return await ungroupedRow.getAttribute('aria-expanded')
    }, { timeout: 5_000 }).toBe('true')
    // The workspace adoption flow keeps one provisional blank New Session in
    // the same account as the seeded visible session. Select the first row
    // that advertises a copyable title instead of relying on the blank row's
    // position; blank rows intentionally have no HoverCard button.
    const candidates = ungroupedSection.locator('[role="treeitem"]')
      .filter({ has: target.locator('button[aria-label^="Session actions for "]') })
    const count = await candidates.count()
    let row: Locator | undefined
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index)
      const title = await candidate.locator('[class*="title"]').innerText().catch(() => '')
      if (title !== '' && title !== 'New Session') {
        row = candidate
        break
      }
    }
    if (row === undefined) throw new Error('Ungrouped has no visible seeded Session row')
    await row.waitFor({ timeout: 10_000 })
    return row
  }

  it('shows the session hover card after a dwell on the row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-hover'))
    // Dwell on the seeded row; the card opens after a 500ms hover delay,
    // portaled to body. The seed has no stored title and unnamed rows carry
    // no copy affordance, so a rename supplies the title this scenario copies.
    const sessionRow = await seededSessionRow()
    await clickHoverAction(sessionRow, 'Session actions for Untitled')
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const renameDialog = page.getByRole('dialog', { name: 'Rename session' })
    const renameInput = renameDialog.getByLabel('Session name')
    await renameInput.fill('Hover card title')
    await audit('session-rename', renameDialog, [renameInput, renameDialog.getByRole('button', { name: 'Rename' })])
    await renameInput.dispatchEvent('compositionstart')
    await renameInput.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    expect(await renameInput.isEnabled()).toBe(true)
    await renameInput.dispatchEvent('compositionend')
    await renameInput.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 })
    expect(await renameInput.isEnabled()).toBe(true)
    await renameDialog.getByRole('button', { name: 'Rename' }).click()
    await expect.poll(() => renameDialog.count(), { timeout: 10_000 }).toBe(0)
    const rowTitle = 'Hover card title'
    await expect.poll(() => sessionRow.locator('[class*="title"]').innerText(), { timeout: 10_000 }).toBe(rowTitle)
    await sessionRow.hover()
    // Card content: the full title plus the completed/idle status line (no
    // aria role — text anchors are the stable selector). Seeded fixtures may
    // carry a settled turn, which the current renderer labels Completed.
    const status = page.getByText(/^(Idle|Completed)$/, { exact: true })
    await expect.poll(() => status.count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(1)
    // The card is REACHABLE: it sits 8px off the row, so getting to it means
    // crossing ground that belongs to neither. Hovering it must not dismiss
    // it — the hazard this scenario pins.
    const card = page.getByRole('button', { name: `Copy: ${rowTitle}` })
    await card.hover()
    await page.waitForTimeout(POINTER_HOLD_MS)
    expect(await status.count()).toBeGreaterThanOrEqual(1)
    // The full title is the card's primary value: activating anywhere on the
    // card writes it through the browser clipboard and localizes the success
    // feedback through the English locale seat.
    if (responsiveBrowserName !== 'firefox') {
      await page.context().grantPermissions(responsiveBrowserName === 'webkit' ? ['clipboard-read'] : ['clipboard-read', 'clipboard-write'])
    }
    const cardHeight = (await card.boundingBox())?.height
    await card.click()
    const copied = page.getByRole('status').getByText('Copied', { exact: true })
    await copied.waitFor({ timeout: 5_000 })
    await page.waitForTimeout(POINTER_HOLD_MS)
    expect((await card.boundingBox())?.height).toBe(cardHeight)
    expect(await copied.isVisible()).toBe(true)
    if (responsiveBrowserName !== 'firefox') expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(rowTitle)
    // Leaving anchor and card together closes it after the grace.
    await page.getByRole('button', { name: 'Settings' }).hover()
    await expect.poll(() => card.count(), { timeout: 5_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  async function previewWitness() {
    const previewPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    onTestFinished(async () => { await previewPage.close() })
    onTestFailed(() => saveFailureShot(previewPage, 'workspace-hovercard-witness'))
    const console = watchConsole(previewPage)
    await previewPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const key = await (await seededSessionRow(previewPage)).getAttribute('data-row-key')
    if (key === null) throw new Error('Preview Session has no row key')
    const row = previewPage.locator(`[data-row-key=${JSON.stringify(key)}]`)
    await row.hover()
    await row.locator('button[aria-label^="Session actions for "]').click()
    await previewPage.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    const dialog = previewPage.getByRole('dialog', { name: 'Rename session', exact: true })
    await dialog.getByLabel('Session name').fill('Preview witness title')
    await dialog.getByRole('button', { name: 'Rename', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => row.locator('[class*="title"]').innerText()).toBe('Preview witness title')
    const card = previewPage.getByRole('button', { name: 'Copy: Preview witness title', exact: true })
    await previewPage.mouse.move(0, 0)
    await card.waitFor({ state: 'hidden' })
    return { previewPage, row, card, console }
  }

  it('keeps the Session preview within narrow pointer windows and reachable across its anchor gap', async () => {
    const { previewPage, row, card, console } = await previewWitness()
    const reveal = async (): Promise<void> => {
      await showSidebar(previewPage)
      await row.hover()
      await card.waitFor()
    }
    if (workflowMatrixEnabled) {
      await auditWorkflowState(previewPage, 'workspace-hovercard', 'narrow-pointer-preview', card, [], reveal)
    } else {
      for (const viewport of [{ width: 320, height: 568 }, { width: 872, height: 230 }]) {
        await previewPage.setViewportSize(viewport)
        await reveal()
        await auditResponsiveControl(previewPage, card, 'Session preview in a narrow pointer window')
      }
    }
    await card.hover()
    await previewPage.waitForTimeout(POINTER_HOLD_MS)
    expect(await card.isVisible()).toBe(true)
    await previewPage.keyboard.press('Escape')
    await card.waitFor({ state: 'hidden' })
    expect(console.pageErrors).toEqual([])
  }, workflowMatrixEnabled ? 180_000 : 60_000)

  it('opens the Session preview from keyboard focus and keeps it while its copy action is focused', async () => {
    const { previewPage, row, card, console } = await previewWitness()
    if (responsiveBrowserName !== 'firefox') {
      await previewPage.context().grantPermissions(responsiveBrowserName === 'webkit' ? ['clipboard-read'] : ['clipboard-read', 'clipboard-write'])
    }
    await previewPage.getByRole('button', { name: 'Settings', exact: true }).focus()
    await previewPage.keyboard.press('Tab')
    await row.focus()
    await card.waitFor({ timeout: 5_000 })
    await previewPage.keyboard.press(responsiveBrowserName === 'webkit' ? 'Alt+Tab' : 'Tab')
    await previewPage.mouse.move(0, 0)
    await previewPage.waitForTimeout(POINTER_HOLD_MS)
    expect(await card.evaluate(element => element === document.activeElement)).toBe(true)
    await auditResponsiveControl(previewPage, card, 'Keyboard Session preview')
    await card.press('Enter')
    await previewPage.getByRole('status').getByText('Copied', { exact: true }).waitFor()
    if (responsiveBrowserName !== 'firefox') expect(await previewPage.evaluate(() => navigator.clipboard.readText())).toBe('Preview witness title')
    await previewPage.keyboard.press('Escape')
    await card.waitFor({ state: 'hidden' })
    expect(await row.evaluate(element => element === document.activeElement)).toBe(true)
    await previewPage.keyboard.press(responsiveBrowserName === 'webkit' ? 'Alt+Tab' : 'Tab')
    expect(await row.evaluate(element => element === document.activeElement)).toBe(false)
    expect(console.pageErrors).toEqual([])
  }, 60_000)

  it('keeps an open row menu up while the pointer moves between trigger and list', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-row-menu'))
    const sessionRow = await seededSessionRow()
    // The trigger is display:none until its row hovers.
    const trigger = sessionRow.locator('button[aria-label^="Session actions for "]')
    const triggerName = await trigger.getAttribute('aria-label')
    if (triggerName === null) throw new Error('seeded Session row has no actions label')
    await clickHoverAction(sessionRow, triggerName)
    const item = page.getByRole('menuitem', { name: 'Rename' })
    await item.waitFor({ timeout: 5_000 })
    await audit('session-actions', page.getByRole('menu'), [], async () => {
      const width = page.viewportSize()!.width
      const frame = page.locator('[data-viewport]').first()
      const mode = width < 768 ? 'compact' : width < 1024 ? 'medium' : width < 1440 ? 'expanded' : 'wide'
      await expect.poll(() => frame.getAttribute('data-viewport'), { message: `row menu frame at ${width}px` }).toBe(mode)
      // Each viewport opens the menu from its current sidebar presentation.
      // Crossing the drawer breakpoint can dismiss the previous owner.
      if (await item.isVisible()) {
        await page.keyboard.press('Escape')
        await item.waitFor({ state: 'hidden', timeout: 5_000 })
      }
      await showSidebar()
      await expect.poll(() => frame.getAttribute('data-sidebar-collapsed'), { message: `row menu sidebar at ${width}px` }).toBeNull()
      await trigger.tap({ timeout: 5_000 })
      await item.waitFor({ state: 'visible', timeout: 5_000 })
    })
    if (workflowMatrixEnabled) {
      await page.keyboard.press('Escape')
      expect(tripwire.pageErrors).toEqual([])
      return
    }
    // Into the list, then back up to the trigger across the 4px gap below it:
    // without the gap-crossing grace, that return trip fires the list's
    // pointerleave and closes the menu — a hesitating pointer loses it.
    // Order matters — clicking leaves the pointer ON the trigger, so entering
    // the list has to come first for the return to be a real departure.
    await item.hover()
    await page.waitForTimeout(POINTER_TRANSIT_MS)
    await trigger.hover()
    await page.waitForTimeout(POINTER_HOLD_MS)
    expect(await page.getByRole('menuitem', { name: 'Rename' }).count()).toBe(1)
    // ...and back down into the list, which must still be there to enter.
    await item.hover()
    await page.waitForTimeout(POINTER_HOLD_MS)
    expect(await page.getByRole('menuitem', { name: 'Rename' }).count()).toBe(1)
    // Pointer-leave dismissal still applies once the pointer genuinely leaves.
    await page.getByRole('button', { name: 'Settings' }).hover()
    await expect.poll(() => page.getByRole('menuitem', { name: 'Rename' }).count(), { timeout: 5_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('archives the seeded session from its row menu, hiding it durably across reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-archive'))
    // The seeded session lives under Ungrouped (expanded by the hover-card
    // test's gesture; converge again for order independence).
    const ungroupedRow = page.getByText('Independent sessions', { exact: true }).locator('..').locator('..')
    const ungroupedSection = ungroupedRow.locator('..')
    await expect.poll(async () => {
      if (await ungroupedRow.getAttribute('aria-expanded') !== 'true') {
        await page.getByText('Independent sessions', { exact: true }).click()
        await page.waitForTimeout(50)
      }
      return await ungroupedRow.getAttribute('aria-expanded')
    }, { timeout: 5_000 }).toBe('true')
    // Anchor on session rows (the rows carrying a session actions button),
    // not a positional index, and assert the single-stray assumption loudly
    // so a fixture gaining a second stray fails here instead of archiving
    // the wrong row. CSS attribute match, not getByRole: the button is
    // display:none until its row hovers, and role queries skip hidden nodes.
    const sessionRows = ungroupedSection.locator('[role="treeitem"]')
      .filter({ has: page.locator('button[aria-label^="Session actions for "]') })
    await expect.poll(() => sessionRows.count(), { timeout: 10_000 }).toBe(1)
    const sessionRow = sessionRows.first()
    await sessionRow.click()
    await expect.poll(() => sessionRow.getAttribute('aria-selected')).toBe('true')
    const rowTitle = await sessionRow.locator('[class*="title"]').innerText()
    const sessionTitles = () => ungroupedSection.locator('[role="treeitem"][aria-selected] [class*="title"]').allTextContents()
    const titlesBefore = await sessionTitles()
    expect(titlesBefore).toContain(rowTitle)
    const retainedTitles = titlesBefore.filter(title => title !== rowTitle)
    // Row menu: hover reveals the actions button; Archive session commits
    // without a confirmation dialog (non-destructive: log + accounting stay).
    const durableIds = (await scaffold.ctx.sessionPersistence.listHeaders()).map(header => header.id).sort()
    const originalViewport = page.viewportSize()
    if (originalViewport === null) throw new Error('Workspace acceptance requires an explicit viewport')
    try {
      for (const viewport of workflowMatrixEnabled ? responsiveViewports : [originalViewport]) {
        await page.setViewportSize(viewport)
        await showSidebar()
        await seededSessionRow()
        await clickHoverAction(sessionRow, `Session actions for ${rowTitle}`)
        await page.getByRole('menuitem', { name: 'Archive session' }).click()
        const toast = page.getByRole('status').filter({ has: page.getByRole('button', { name: 'undo', exact: true }) })
        const undo = toast.getByRole('button', { name: 'undo', exact: true })
        const filter = toast.getByRole('button', { name: 'filter archived sessions', exact: true })
        await undo.waitFor()
        await auditResponsiveControl(page, undo, 'Workspace archive Undo')
        await auditResponsiveControl(page, filter, 'Workspace archive filter')
        const readings = await captureTextContrast(page, [{ label: 'undo', text: undo }, { label: 'filter', text: filter }],
          `workspace-archive-actions-${viewport.width}x${viewport.height}`)
        if (!workflowMatrixEnabled) {
          await undo.hover()
          readings.push(...await captureTextContrast(page, [{ label: 'undo-hover', text: undo }], 'workspace-archive-action-hover'))
        }
        await undo.click()
        await expect.poll(() => [...scaffold.ctx.workspaceRegistry.archivedSessionIds]).not.toContain(SessionId(SEED_ID))
        await sessionRow.waitFor({ state: 'visible' })
        expect((await scaffold.ctx.sessionPersistence.listHeaders()).map(header => header.id).sort()).toEqual(durableIds)
        expectTextContrast(readings)
      }
    } finally { await page.setViewportSize(originalViewport) }
    await showSidebar()
    await clickHoverAction(sessionRow, `Session actions for ${rowTitle}`)
    await page.getByRole('menuitem', { name: 'Archive session' }).click()
    // The active archive opens a client-local draft before the next message creates a Session.
    await expect.poll(() => page.getByText(rowTitle, { exact: true }).count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => page.locator('[role="treeitem"][aria-selected="true"]').count()).toBe(0)
    await expect.poll(() => page.locator('[data-composer-seat] textarea:enabled').inputValue()).toBe('')
    expect((await scaffold.ctx.sessionPersistence.listHeaders()).map(header => header.id).sort()).toEqual(durableIds)
    for (const title of retainedTitles) await expect.poll(() => page.getByText(title, { exact: true }).count()).toBeGreaterThan(0)
    // Durable on the host: the registry-global set carries the id while the
    // session log itself stays in persistence untouched.
    expect([...scaffold.ctx.workspaceRegistry.archivedSessionIds]).toEqual([SessionId(SEED_ID)])
    await auditSidebar('session-archived')
    expect((await scaffold.ctx.sessionPersistence.listHeaders()).map(header => header.id)).toContain(SessionId(SEED_ID))
    // Reload: the hidden state is rebuilt from the workspace.list baseline.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(() => page.getByText('Workspaces', { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    // The archive set and unrelated selection both survive the fresh baseline.
    expect(await page.getByText(rowTitle, { exact: true }).count()).toBe(0)
    await expect.poll(sessionTitles, { timeout: 10_000 }).toEqual(retainedTitles)
    expect(tripwire.pageErrors).toEqual([])
  }, workflowMatrixEnabled ? 240_000 : 90_000)

  it('restores an archived session through the Settings Archived sessions page', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-unarchive'))
    // Precondition through the host: archive is idempotent, so the scenario
    // holds whether or not the row-menu archive test ran first. The dialog
    // polls below carry the client-side frame propagation wait.
    await scaffold.ctx.workspaceRegistry.archiveSession(SessionId(SEED_ID))
    // The real composition: Settings dialog → Archived sessions section →
    // workspace.unarchiveSession RPC → durable set → sidebar row returns.
    await page.getByRole('button', { name: 'Settings' }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Archived sessions' }).click()
    const rows = dialog.getByRole('list').locator('li')
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBe(1)
    const rowTitle = await rows.first().locator('[class*="title"]').innerText()
    expect(await rows.first().innerText()).toContain('Ungrouped')
    await audit('archived-sessions', dialog, [rows.first().getByRole('button', { name: `Unarchive ${rowTitle}` })])
    await rows.first().getByRole('button', { name: `Unarchive ${rowTitle}` }).click()
    // Durable on the host: the id leaves the registry-global set and the
    // session log is untouched.
    await expect.poll(() => [...scaffold.ctx.workspaceRegistry.archivedSessionIds], { timeout: 10_000 }).toEqual([])
    expect((await scaffold.ctx.sessionPersistence.listHeaders()).map(header => header.id)).toContain(SessionId(SEED_ID))
    await expect.poll(() => dialog.getByText('No archived sessions.', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await audit('archived-empty', dialog, [dialog.getByRole('button', { name: 'Close', exact: true })])
    await page.keyboard.press('Escape')
    // The restored row is visible again in the sidebar's Ungrouped bucket.
    // (The archive dialog keeps the host display label while the sidebar row
    // renders the localized label, so identity is asserted by row key.)
    await seededSessionRow()
    const restored = page.locator(`[data-row-key^="session:"][data-row-key*="${SEED_ID}"]`)
    await restored.waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('opens folders with identical basenames as distinct workspaces', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-duplicate-basename'))
    const firstPath = join(scaffold.workspaceCwd, 'same-basename-a', 'xx')
    const secondPath = join(scaffold.workspaceCwd, 'same-basename-b', 'xx')
    await mkdir(firstPath, { recursive: true })
    await mkdir(secondPath, { recursive: true })

    await adoptDirectory(firstPath, { waitForAgent: true })
    await adoptDirectory(secondPath, { waitForAgent: true })

    const matchingWorkspaces = scaffold.ctx.workspaceRegistry.list()
      .filter(workspace => workspace.title === 'xx')
    expect(matchingWorkspaces.map(workspace => workspace.path).sort())
      .toEqual([firstPath, secondPath].sort())
    await expect.poll(
      () => page.locator('button[aria-label="Workspace actions for xx"]').count(),
      { timeout: 10_000 },
    ).toBe(2)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', async () => {
    expect(tripwire.warnings).toEqual([])
    // The directory-browser aria golden is this spec's one owned artifact;
    // the seed it reuses is owned (and inventory-guarded) by seeded-history.
    await assertFixtureInventory(SNAPSHOT_DIR, ['.gitkeep', 'directory-browser.expected.md'])
  })
})
