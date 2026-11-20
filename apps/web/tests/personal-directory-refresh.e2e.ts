/** Explicit environment refresh through the shipped client and independent Web Hosts. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { launchPersonalComputersFixture, personalTargets } from './personal-computers-fixture.ts'
import { captureStableAria, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'
import { responsiveBrowser } from './responsive-browser.ts'
import { saveFailureShot } from './support.ts'

it.skipIf(webSnapshotMode() === 'record')('refreshes a selected task environment without focus or additional Runtime preparation', async () => {
  const fixture = await launchPersonalComputersFixture({ extraOverlayPath: fileURLToPath(
    new URL('../../../packages/experimental/schedule-bundle/cordis.patch.yml', import.meta.url)) })
  let browser: Awaited<ReturnType<typeof responsiveBrowser.launch>> | undefined
  try {
    browser = await responsiveBrowser.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
    try {
      await page.addInitScript(() => { localStorage.setItem('dsh.locale', 'en') })
      await page.goto(fixture.url, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: 'Automation tasks', exact: true }).click()
      const manager = page.getByTestId('task-manager-page')
      await manager.waitFor()
      const chooser = manager.getByRole('button', { name: 'Choose task environment', exact: true })
      await chooser.click()
      await page.getByRole('menuitem', { name: 'Compute computer', exact: true }).click()
      await expect.poll(() => chooser.textContent()).toContain('Compute computer')
      const selectedPreparation = [[personalTargets[1]!.runtimeId, 1]]
      await expect.poll(() => [...fixture.preparations]).toEqual(selectedPreparation)
      const emptyCatalog = manager.getByRole('heading', { name: 'No tasks yet. Tasks created in your sessions appear here.', exact: true })
      await emptyCatalog.waitFor()
      const active = await captureStableAria(page, '[data-testid="task-manager-page"]', fixture.worlds[1]!.workspaceCwd)

      fixture.setRuntimeAvailable(1, false)
      await chooser.click()
      await page.getByRole('menuitem', { name: 'Refresh environments', exact: true }).click()
      const unavailable = manager.getByRole('status').filter({ hasText: 'This environment is currently unavailable.' })
      await unavailable.waitFor()
      expect(await manager.getByRole('button', { name: 'New', exact: true }).isDisabled()).toBe(true)
      expect(await chooser.textContent()).toContain('Compute computer')
      expect([...fixture.preparations]).toEqual(selectedPreparation)
      const offline = await captureStableAria(page, '[data-testid="task-manager-page"]', fixture.worlds[1]!.workspaceCwd)

      fixture.setRuntimeAvailable(1, true)
      await unavailable.getByRole('button', { name: 'Retry', exact: true }).click()
      await unavailable.waitFor({ state: 'hidden' })
      await emptyCatalog.waitFor()
      expect(await manager.getByRole('button', { name: 'New', exact: true }).isDisabled()).toBe(false)
      expect(await chooser.textContent()).toContain('Compute computer')
      expect([...fixture.preparations]).toEqual(selectedPreparation)
      const recovered = await captureStableAria(page, '[data-testid="task-manager-page"]', fixture.worlds[1]!.workspaceCwd)
      await compareOrRefreshGolden(fileURLToPath(new URL('./snapshots/personal-directory-refresh/availability.expected.md', import.meta.url)),
        `## Selected environment\n${active}\n\n## Explicit refresh while offline\n${offline}\n\n## Explicit retry after recovery\n${recovered}\n\nExplicit refresh and retry did not prepare another Runtime.`, webSnapshotMode())
    } catch (error) { await saveFailureShot(page, 'personal-directory-refresh'); throw error }
  } finally { try { await browser?.close() } finally { await fixture.close() } }
})
