// Shared plumbing for the web smoke tests (dist location and failure shots).
import { existsSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { expect } from 'vitest'

/** The built page under test; `pnpm run test:web` rebuilds it before running. */
export const DIST_INDEX = fileURLToPath(new URL('../dist/index.html', import.meta.url))

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * Browser language a page must advertise to boot into the product's Chinese
 * surface: with no stored preference the client derives its initial locale
 * from the browser, and Playwright's default browser asks for English.
 */
export const ZH_BROWSER_LOCALE = 'zh-CN'

/**
 * Open the standard browser-test page advertising English before client boot.
 * This keeps role locators and goldens deterministic while leaving the Host
 * settings document free to override the provisional browser-derived locale;
 * scenarios asserting the Chinese surface advertise
 * {@link ZH_BROWSER_LOCALE} instead.
 * @param browser - Playwright browser owning the page.
 * @param height - Viewport height; width is fixed to the lane baseline.
 * @returns the initialized page.
 */
export async function newEnglishPage(browser: Browser, height = 1000): Promise<Page> {
  return await browser.newPage({ viewport: { width: 1680, height }, locale: 'en-US' })
}

/** Fail loud on a stale checkout instead of testing yesterday's bundle. */
export function requireDist(): void {
  if (!existsSync(DIST_INDEX)) {
    throw new Error('web app dist not built — run `pnpm run build` from the repository root (`pnpm run test:web` does this first)')
  }
}

/**
 * Drive the hero's workspace picker through the composed directory dialog
 * until the live composer unlocks. A fresh world has no Workspace, so the boot
 * lands in the Workspace-trigger view state (startup auto-selection has nothing to
 * select); every scenario that types into the composer must connect one
 * first. With nothing to list, activating the textarea raises the dialog directly —
 * adding a workspace is the picker's only entry. The directory is staged here
 * and adopted through the path editor, which is idempotent across the repeated
 * connects a scenario may make; creating a folder from inside the dialog (the
 * product's other half of the same route) is covered by
 * workspace-management.e2e.ts. The default name 'workspace' keeps the session
 * header cwd at <root>/workspace, the materialization proof several scenarios
 * assert.
 * @param page - the page under test.
 * @param root - host directory the workspace folder is staged in (the scaffold's `workspaceCwd`).
 * @param name - folder name staged and adopted as the workspace.
 */
export async function connectFreshWorkspace(page: Page, root: string, name = 'workspace'): Promise<void> {
  mkdirSync(join(root, name), { recursive: true })
  await page.getByRole('textbox', { name: 'Choose workspace' }).click()
  const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Edit path' }).click()
  const pathInput = dialog.getByRole('textbox', { name: 'Edit path' })
  await pathInput.fill(join(root, name))
  await pathInput.press('Enter')
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
  // The pick connected the workspace: the blank session's live composer
  // replaces the locked placeholder and enables.
  await page.locator('textarea:enabled[placeholder="Describe what you want to build"]')
    .waitFor({ timeout: 15_000 })
}

/**
 * {@link connectFreshWorkspace} over a page that advertises
 * {@link ZH_BROWSER_LOCALE}: the English helper's anchors assume the locale
 * most other scenarios boot, so a scenario that deliberately keeps zh needs
 * the localized picker copy.
 * @param page - the browser page under test.
 * @param root - workspace parent directory.
 * @param name - directory created under `root` and connected.
 */
export async function connectFreshWorkspaceZh(page: Page, root: string, name = 'workspace'): Promise<void> {
  mkdirSync(join(root, name), { recursive: true })
  await page.getByRole('textbox', { name: '选择工作区' }).click()
  const dialog = page.getByRole('dialog', { name: '选择工作区目录' })
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: '编辑路径' }).click()
  const pathInput = dialog.getByRole('textbox', { name: '编辑路径' })
  await pathInput.fill(join(root, name))
  await pathInput.press('Enter')
  await dialog.getByRole('button', { name: '打开', exact: true }).click()
  await page.locator('textarea:enabled[placeholder="描述你想要构建的内容"]')
    .waitFor({ timeout: 15_000 })
}

/** Failure evidence goes to the gitignored .artifacts/ (repo convention). */
export async function saveFailureShot(page: Page, name: string): Promise<void> {
  const dir = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
  mkdirSync(dir, { recursive: true })
  try {
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true })
  } catch {
    // Best-effort evidence: a dead page/browser at failure time must not mask the real assertion error.
  }
}

/**
 * DOM/layout evidence for "element resolved but not visible" failures: the
 * bounding box, computed display/visibility, and attributes of every marked
 * surface (composer seat, queue dock, question card, tree rows, dialogs) plus
 * the live viewport size. Best-effort like saveFailureShot.
 * @param page - the page whose layout to record.
 * @param name - artifact basename inside `.artifacts/`.
 */
export async function saveFailureDom(page: Page, name: string): Promise<void> {
  const dir = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
  mkdirSync(dir, { recursive: true })
  try {
    const dump = await page.evaluate(() => {
      const entries: string[] = [`viewport: ${window.innerWidth}x${window.innerHeight}`]
      for (const el of document.querySelectorAll('[data-composer-seat], [data-queue-dock], [data-question-key], [role="treeitem"], [role="dialog"], [class*="composerStack"], [class*="centerCol"]')) {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        entries.push(
          `<${el.tagName.toLowerCase()} ${Array.from(el.attributes).map(a => `${a.name}=${JSON.stringify(a.value)}`).join(' ')}>`
          + ` box=${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`
          + ` display=${style.display} visibility=${style.visibility}`,
        )
      }
      return entries.join('\n')
    })
    await writeFile(`${dir}/${name}.dom.txt`, `${dump}\n`)
  } catch {
    // Best-effort evidence: a dead page/browser at failure time must not mask the real assertion error.
  }
}

/** Wait for device resolution, subject to the page bitmap allocation limit. */
export async function expectPdfResolution(canvas: Locator): Promise<void> {
  await expect.poll(() => canvas.evaluate((node) => {
    const bitmap = node as HTMLCanvasElement
    const width = Number.parseFloat(bitmap.style.getPropertyValue('--pdf-page-width'))
    const height = Number.parseFloat(bitmap.style.getPropertyValue('--pdf-page-height'))
    const expected = Math.min(bitmap.getBoundingClientRect().width * window.devicePixelRatio,
      Math.sqrt(16_777_216 * width / height))
    return Math.abs(bitmap.width - expected)
  })).toBeLessThanOrEqual(1)
}

/** Move into the bottom reveal zone and wait for the shared zoom control. */
export async function revealDocumentZoom(page: Page, preview: Locator): Promise<Locator> {
  const frame = preview.locator('[data-document-zoom-frame]')
  const bounds = await frame.boundingBox()
  if (bounds === null) throw new Error('document zoom frame has no bounds')
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 8)
  const controls = preview.locator('[data-document-zoom-controls]')
  await expect.poll(() => controls.getAttribute('data-document-zoom-visible')).toBe('true')
  return preview.getByRole('button', { name: 'Choose zoom', exact: true })
}

/** Leave the bottom reveal zone and wait for the delayed dismissal. */
export async function hideDocumentZoom(page: Page, preview: Locator): Promise<void> {
  const frame = preview.locator('[data-document-zoom-frame]')
  const bounds = await frame.boundingBox()
  if (bounds === null) throw new Error('document zoom frame has no bounds')
  await page.mouse.move(bounds.x + 8, bounds.y + 8)
  await expect.poll(() => preview.locator('[data-document-zoom-controls]').getAttribute('data-document-zoom-visible')).toBeNull()
}

/**
 * Assert a visible tooltip paints above the element a user would read through
 * it: both probes must land inside the bubble's subtree. The bubble ignores
 * pointer events by design, so the measurement enables them for its own duration.
 * @param tooltip - locator for the visible `[role="tooltip"]` bubble.
 */
export async function expectTooltipOnTop(tooltip: Locator): Promise<void> {
  expect(await tooltip.evaluate((element) => {
    const bubble = element as HTMLElement
    const rect = bubble.getBoundingClientRect()
    const previous = bubble.style.pointerEvents
    bubble.style.pointerEvents = 'auto'
    const hitsBubble = (y: number): boolean => {
      const hit = document.elementFromPoint(rect.left + rect.width / 2, y)
      return hit !== null && (hit === bubble || bubble.contains(hit))
    }
    const onTop = hitsBubble(rect.top + rect.height / 2) && hitsBubble(rect.bottom - 1)
    bubble.style.pointerEvents = previous
    return onTop
  })).toBe(true)
}

/**
 * The conversation engine's Context key format, restated here rather than
 * imported: these specs live in the Host compiler aggregate, which must not
 * reach the Client plane. The engine's own copy is
 * `conversationContextKey` in dsh-client-runtime; a drift between them makes
 * the key miss its rendered node, so the assertion fails loudly.
 * @param kind - Definition kind.
 * @param id - Definition-local business identity.
 * @returns the engine-owned Context key.
 */
export function conversationContextKey(kind: string, id: string): string {
  return `${kind.length}:${kind}${id}`
}

/**
 * Expand the settled Turn process containing a hidden descendant. The
 * process toggle precedes its folded members in DOM order, so the owning
 * control is the last `[data-turn-process]` button before the target.
 * @param page - page containing the Chat view.
 * @param target - descendant whose outer process disclosure should open.
 */
export async function expandOwningTurnProcess(_page: Page, target: Locator): Promise<void> {
  if (await target.isVisible()) return
  const owner = await target.evaluateHandle((element) => {
    let owner: Element | null = null
    for (const control of element.ownerDocument.querySelectorAll('[data-turn-process]')) {
      if (control.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) owner = control
      else break
    }
    return owner
  })
  const control = owner.asElement()
  if (control === null) return
  await control.waitForElementState('visible', { timeout: 10_000 })
  if (await control.getAttribute('aria-expanded') === 'false') await control.click()
}
