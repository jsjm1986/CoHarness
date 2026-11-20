/** Direct-node Admin binding and execution approval through real HTTP and retained files. */
import { expect } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GovernanceRebuildGateway } from '../src/governance-rebuild-gateway.ts'
import { governanceRecoveryUiFixture } from './governance-rebuild-ui-fixture.ts'

/** Verify a nonstandard local home and enable only new conversations without launching a Runtime.
 * @param input - released governance operation, retained local directories and actual preparation worker.
 * @returns with exact local data bound and the new-conversation permission recorded.
 */
export async function exerciseGovernanceLocalUi(input: {
  gateway: GovernanceRebuildGateway; adminId: number; operationId: string; runtimeReviewId: string; root: string
  homePath: string; runtimeHome: string; advance: () => Promise<void>
}): Promise<void> {
  const fixture = await governanceRecoveryUiFixture({ ...input, local: true })
  const { page, origin, calls, failures } = fixture
  try {
    await page.goto(origin + '/admin/governance-recovery/local')
    await page.getByRole('button', { name: 'Review this Runtime', exact: true }).click()
    expect(await page.getByRole('heading', { name: 'Account login', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Open management', exact: true }).count()).toBe(0)
    await page.getByText('Select local data directories', { exact: true }).click()
    await page.getByLabel('Absolute working directory', { exact: true }).fill(input.homePath)
    await page.getByLabel('Runtime data directory (optional)', { exact: true }).fill(input.runtimeHome)
    await page.getByRole('button', { name: 'Verify selected directories', exact: true }).click()
    await page.getByRole('button', { name: 'Check restored execution configuration', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Check restored execution configuration', exact: true }).click()
    await page.getByText(/Checking restored data and plugin configuration/u).waitFor()
    await input.advance()
    await page.getByRole('button', { name: 'Refresh execution review', exact: true }).click()
    await page.getByRole('button', { name: 'Review new-conversation permission', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Review new-conversation permission', exact: true }).click()
    const review = page.locator('section[aria-label="Recovered execution permissions"]')
    await review.getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Enable new conversations', exact: true }).click()
    await page.getByText('New conversations are enabled; historical conversations remain read-only.', { exact: true }).waitFor()
    const transcript = JSON.stringify({ title: await page.getByRole('heading', { level: 1 }).innerText(),
      review: await review.ariaSnapshot(), accountControls: await page.getByRole('heading', { name: 'Account login', exact: true }).count(),
      ordinaryGlobalRequests: calls.filter(call => call.path === '/admin/api/governance-recovery').length,
    }, null, 2) + '\n'
    await fixture.capture('local-mobile-enabled', true, transcript)
    const status = await input.gateway.execution.status(input.adminId, input.runtimeReviewId)
    expect(status).toMatchObject({ status: 'new-conversations-enabled', oldSessionCount: 2, sessionsReadOnly: true, tasksSuspended: true })
    expect(calls.every(call => call.path === '/admin/api/governance-recovery/local'
      || call.path.startsWith('/admin/api/governance-recovery/' + input.operationId + '/runtimes/' + input.runtimeReviewId + '/'))).toBe(true)
    expect(failures).toEqual([])
  } catch (error) {
    if (process.env.HGW_TEST_UI_ARTIFACTS) {
      await mkdir(process.env.HGW_TEST_UI_ARTIFACTS, { recursive: true })
      await writeFile(join(process.env.HGW_TEST_UI_ARTIFACTS, 'governance-local-failure.json'), JSON.stringify({
        error: String(error), calls, page: await page.locator('body').ariaSnapshot(),
      }, null, 2) + '\n')
    }
    throw error
  } finally { await fixture.close() }
}
