/** Unified personal navigation through real independent Hosts and their shipped client plugins. @module */
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { launchPersonalComputersFixture, personalTargets } from './personal-computers-fixture.ts'
import { acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden, watchConsole, webSnapshotMode } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

it('retains a pending New Session and its origin draft across transport renewal', async () => {
  const fixture = await launchPersonalComputersFixture()
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
  const warnings = watchConsole(page)
  const held = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const delivered = Promise.withResolvers<undefined>()
  onTestFailed(() => saveFailureShot(page, 'personal-computers-renewal'))
  try {
    await page.goto(fixture.url, { waitUntil: 'networkidle' })
    const office = page.getByRole('region', { name: 'Office computer', exact: true })
    await office.getByRole('button', { name: 'Office computer', exact: true }).click()
    await office.getByText('Office work', { exact: true }).click()
    await office.locator('[data-row-key^="session:"]').first().click()
    const input = page.locator('textarea').first()
    await input.fill('Keep the original draft across transport renewal')
    await page.route(/\/api\/session\.create(?:\?.*)?$/, async (route) => {
      const response = await route.fetch()
      held.resolve(undefined)
      await release.promise
      await route.fulfill({ response })
      delivered.resolve(undefined)
    })
    await office.getByRole('button', { name: /New session in /i }).click()
    await held.promise
    expect(await input.isDisabled()).toBe(true)
    const warningStart = warnings.warnings.length
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/account/api/context')
    fixture.renewEventStreams(personalTargets[0]!.runtimeId)
    await (await refreshed).finished()
    await page.getByRole('button', { name: 'Select model, current DeepSeek-V4-Flash', exact: true }).waitFor()
    expect(await input.isDisabled()).toBe(true)
    expect(await input.inputValue()).toBe('Keep the original draft across transport renewal')
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/personal-computers/renewal-preparing.expected.md', import.meta.url)),
      await captureStableAria(page, 'textarea', fixture.worlds[0]!.workspaceCwd), webSnapshotMode())
    release.resolve(undefined)
    await delivered.promise
    await page.locator('textarea[placeholder="Describe what you want to build"]').waitFor()
    expect(await page.locator('textarea').first().inputValue()).toBe('')
    expect(await page.evaluate(() => Object.entries(sessionStorage).some(([key, value]) =>
      key.startsWith('dsh.conversation.chat.') && String(value).includes('Keep the original draft across transport renewal')))).toBe(true)
    acknowledgeReloadConnectionLoss(warnings, warningStart)
    expect(warnings.pageErrors).toEqual([])
  } finally {
    release.resolve(undefined)
    await page.close()
    await browser.close()
    await fixture.close()
  }
}, 120_000)

it('browses twenty cold computers and keeps personal conversations, drafts and tabs independent', async () => {
  const fixture = await launchPersonalComputersFixture()
  await mkdir(fileURLToPath(new URL('../../../.artifacts/multi-computer-validation/', import.meta.url)), { recursive: true })
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US', colorScheme: 'dark' })
  const page = await context.newPage(), warnings = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'personal-computers'))
  try {
    await page.goto(fixture.url, { waitUntil: 'networkidle' })
    const office = page.getByRole('region', { name: 'Office computer', exact: true })
    const compute = page.getByRole('region', { name: 'Compute computer', exact: true })
    await office.waitFor()
    const composer = () => page.locator('textarea:enabled').last()
    const openOffice = async (owner: typeof page): Promise<void> => {
      const section = owner.getByRole('region', { name: 'Office computer', exact: true })
      const heading = section.getByRole('button', { name: 'Office computer', exact: true })
      if (await heading.getAttribute('aria-expanded') !== 'true') await heading.click()
      if (!await section.locator('[data-row-key^="session:"]').first().isVisible()) await section.getByText('Office work', { exact: true }).click()
      await section.locator('[data-row-key^="session:"]').first().click()
    }
    await openOffice(page)
    await composer().fill('Office draft stays on Office')
    const other = await context.newPage()
    await other.goto(fixture.url, { waitUntil: 'networkidle' })
    await openOffice(other)
    await other.locator('textarea:enabled').last().fill('Independent tab draft')
    expect(fixture.calls.get(personalTargets[1]!.runtimeId) ?? 0).toBe(0)
    await compute.getByRole('button', { name: 'Compute computer', exact: true }).click()
    await compute.getByText('Compute work', { exact: true }).waitFor()
    expect(fixture.calls.get(personalTargets[1]!.runtimeId) ?? 0).toBe(0)
    expect(fixture.preparations.get(personalTargets[1]!.runtimeId) ?? 0).toBe(0)
    await compute.getByText('Compute work', { exact: true }).click()
    await compute.locator('[data-row-key^="session:"]').first().click()
    await expect.poll(() => composer().inputValue()).toBe('')
    expect(fixture.calls.get(personalTargets[1]!.runtimeId)).toBeGreaterThan(0)
    expect(fixture.preparations.get(personalTargets[1]!.runtimeId)).toBe(1)
    await composer().fill('Compute draft stays on Compute')
    expect(await other.locator('textarea:enabled').last().inputValue()).toBe('Independent tab draft')
    await office.locator('[data-row-key^="session:"]').first().click()
    await expect.poll(() => composer().inputValue()).toBe('Office draft stays on Office')
    await compute.locator('[data-row-key^="session:"]').first().click()
    await expect.poll(() => composer().inputValue()).toBe('Compute draft stays on Compute')
    expect(new URL(page.url()).searchParams.get('dshRuntime')).toBe(personalTargets[0]!.runtimeId)
    const saved = await page.evaluate(() => sessionStorage.getItem('dsh.personal.current.v1.account:7.runtime:10000000-0000-4000-8000-000000000001'))
    expect(saved).toContain(personalTargets[1]!.runtimeId)
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/personal-computers/groups.expected.md', import.meta.url)),
      await captureStableAria(page, 'section[aria-label="Compute computer"]', fixture.worlds[1]!.workspaceCwd), webSnapshotMode())
    const warningStart = warnings.warnings.length
    await page.reload({ waitUntil: 'networkidle' })
    acknowledgeReloadConnectionLoss(warnings, warningStart)
    await expect.poll(() => composer().inputValue()).toBe('Compute draft stays on Compute')
    expect(await other.locator('textarea:enabled').last().inputValue()).toBe('Independent tab draft')
    const desktopShot = fileURLToPath(new URL('../../../.artifacts/multi-computer-validation/personal-desktop.jpg', import.meta.url))
    await page.screenshot({ path: desktopShot, type: 'jpeg', quality: 85, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('light')
    await page.screenshot({ path: fileURLToPath(new URL('../../../.artifacts/multi-computer-validation/personal-light.jpg', import.meta.url)),
      type: 'jpeg', quality: 85, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.getByRole('button', { name: 'Switch personal or project scope', exact: true }).click()
    const spaces = page.getByRole('group', { name: 'Switch personal or project scope', exact: true })
    expect(await spaces.getByRole('button', { name: /^Personal/ }).count()).toBe(1)
    expect(await spaces.getByText('Office computer', { exact: true }).count()).toBe(0)
    expect(await spaces.getByText('Compute computer', { exact: true }).count()).toBe(0)
    await spaces.getByRole('button', { name: 'Close', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
    const mobileComputer = page.getByRole('region', { name: 'Compute computer', exact: true })
      .getByRole('button', { name: 'Compute computer', exact: true })
    await expect.poll(async () => (await page.locator('[data-sidebar-root]').boundingBox())?.x).toBeGreaterThanOrEqual(-0.5)
    await expect.poll(async () => (await mobileComputer.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: fileURLToPath(new URL('../../../.artifacts/multi-computer-validation/personal-mobile.jpg', import.meta.url)),
      type: 'jpeg', quality: 85, animations: 'disabled' })
    expect(warnings.pageErrors).toEqual([])
    expect(warnings.warnings).toEqual([])
  } catch (error) {
    await saveFailureShot(page, 'personal-computers')
    console.error((await page.locator('body').innerText()).slice(0, 6000))
    throw error
  } finally {
    const results = [await context.close().then(() => ({ status: 'fulfilled' as const }), (reason: unknown) => ({ status: 'rejected' as const, reason })),
      await browser.close().then(() => ({ status: 'fulfilled' as const }), (reason: unknown) => ({ status: 'rejected' as const, reason }))]
    await fixture.close()
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length) throw new AggregateError(failures, 'Personal computer browser cleanup failed')
  }
}, 120_000)
