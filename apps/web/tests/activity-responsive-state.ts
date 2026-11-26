/** Activity and progress state sweeps with standalone touch target checks. */
import type { Locator, Page } from 'playwright'
import { expect } from 'vitest'
import { auditWorkflowState } from './workflow-responsive-state.ts'

/**
 * Open the recorded overview that will host the project-level panel.
 * @param page - the assembled application's project page.
 * @param marker - unique text used in the overview's prompt and recorded response.
 */
export async function openActivitySession(page: Page, marker: string): Promise<void> {
  const search = page.getByRole('button', { name: 'Search sessions' })
  if (await search.getAttribute('aria-expanded') !== 'true') await search.click()
  await page.getByRole('textbox', { name: /Search (?:sessions|computers, workspaces or conversations)…/u }).fill(marker)
  const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => result.count(), { timeout: 30_000 }).toBe(1)
  await result.click()
  await page.getByText(marker, { exact: true }).waitFor()
}

/**
 * Activate an activity action with the input method used by the current browser lane.
 * @param control - enabled action to activate.
 * @returns completion of the synthesized pointer or touch action.
 */
export function activateActivityControl(control: Locator): Promise<void> {
  return process.env.DSH_FEATURE_MATRIX === '1' ? control.tap() : control.click()
}

/**
 * Inspect an activity state at every selected touch viewport.
 * @param page - authenticated application page.
 * @param state - activity or progress state used in the evidence filenames.
 * @param surface - the visible feed whose parent also contains the activity toolbar.
 */
export async function auditActivityState(page: Page, state: string, surface: Locator): Promise<void> {
  const panel = surface.locator('..')
  await auditWorkflowState(page, 'collaboration', state, panel, [], undefined, async () => {
    const failures = await panel.locator('button:enabled, select:enabled, [role="button"]').evaluateAll(elements =>
      elements.flatMap((element) => {
        const box = element.getBoundingClientRect()
        if (box.width === 0 || box.height === 0 || element.closest('[inert]') !== null) return []
        return box.width >= 44 && box.height >= 44 ? []
          : [{ label: element.getAttribute('aria-label') ?? element.textContent, width: box.width, height: box.height }]
      }))
    expect(failures, 'Activity touch actions have at least 44×44 CSS pixels').toEqual([])
  })
}
