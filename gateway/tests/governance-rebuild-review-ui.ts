/** Browser review against the real imported governance database and restricted HTTP dispatcher. */
import { expect } from 'vitest'
import { governanceRecoveryUiFixture } from './governance-rebuild-ui-fixture.ts'
import type { GovernanceRebuildGateway } from '../src/governance-rebuild-gateway.ts'

/** Exercise responsive account review, stale revisions and release without starting a Runtime.
 * @param input - imported database services and exact fixture identities.
 * @returns after reviewed member login is released and Runtime holds remain independently controlled.
 */
export async function exerciseGovernanceRebuildUi(input: {
  gateway: GovernanceRebuildGateway; adminId: number; operationId: string; root: string
  memberUserId: string; sourceNodeId: string; targetNodeId: string; verifyReleased: () => Promise<void>
}): Promise<void> {
  const fixture = await governanceRecoveryUiFixture(input)
  const { page, context, origin, calls, failures } = fixture
  try {
    const original = (await input.gateway.review.status(input.adminId))!
    const sourceName = original.nodes.find(row => row.nodeId === input.sourceNodeId)!.name
    const capture = async (stage: string, mobile: boolean) => {
      const currentForm = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Current review', exact: true }) })
      const transcript = JSON.stringify({ title: await page.getByRole('heading', { level: 1 }).innerText(),
        states: await page.locator('p[role="status"]').allTextContents(),
        form: await currentForm.count() ? await currentForm.ariaSnapshot() : null,
        ordinaryAdmin: await page.getByRole('link', { name: 'Open Admin', exact: true }).count(),
        sourceRestoreButton: await page.getByRole('button', { name: 'Review computer ' + sourceName, exact: true }).count(),
        oldWorkNotice: await page.getByText(/old history remains read-only and old inbox work and schedules stay suspended/u).count(),
      }, null, 2) + '\n'
      await fixture.capture(stage, mobile, transcript)
    }
    await page.goto(origin + '/admin/governance-recovery')
    await page.getByRole('button', { name: 'Review account closed-member', exact: true }).click()
    expect(await page.getByRole('heading', { name: 'closed-member', exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Tab')
    expect(await page.getByRole('combobox', { name: 'Account login', exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
    await page.getByRole('combobox', { name: 'Account login', exact: true }).selectOption('restore')
    await page.getByLabel('New password', { exact: false }).fill('fresh-ui-member-password')
    await page.getByRole('checkbox', { name: 'I have reviewed this subject and the effects above', exact: true }).check()
    const before = (await input.gateway.review.status(input.adminId))!
    const other = await context.newPage()
    await other.goto(origin + '/admin/governance-recovery')
    const targetName = before.nodes.find(row => row.nodeId === input.targetNodeId)!.name
    await other.getByRole('button', { name: 'Review computer ' + targetName, exact: true }).click()
    await other.getByRole('checkbox', { name: 'I have reviewed this subject and the effects above', exact: true }).check()
    await other.getByRole('button', { name: 'Confirm review', exact: true }).click()
    await other.getByText('Review revision 2', { exact: true }).waitFor()
    await other.close()
    expect(await page.getByLabel('New password', { exact: false }).inputValue()).toBe('fresh-ui-member-password')
    await page.getByRole('button', { name: 'Confirm review', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'The review revision changed.' }).waitFor()
    expect(await page.getByLabel('New password', { exact: false }).inputValue()).toBe('fresh-ui-member-password')
    await capture('desktop-conflict', false)
    await page.getByRole('button', { name: 'Refresh review status', exact: true }).click()
    await page.getByText('Review revision 2', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Use the newly reviewed revision', exact: true }).click()
    await page.getByRole('checkbox', { name: 'I have reviewed this subject and the effects above', exact: true }).check()
    await page.getByRole('button', { name: 'Confirm review', exact: true }).click()
    await page.getByText('Review revision 3', { exact: true }).waitFor()
    expect((await input.gateway.review.status(input.adminId))!.accounts.find(row => row.userId === input.memberUserId)?.decision).toBe('restore')
    await expect(input.gateway.review.reviewNode(input.adminId, input.operationId, input.sourceNodeId, {
      confirm: input.operationId, revision: '3', decision: 'restore' })).rejects.toMatchObject({ code: 'peer-backup/governance-source-quarantined' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Open management', exact: true }).click()
    await capture('mobile-release', true)
    const form = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Current review', exact: true }) })
    for (const checkbox of await form.getByRole('checkbox').all()) await checkbox.check()
    await page.getByRole('button', { name: 'Confirm review', exact: true }).click()
    await page.getByRole('link', { name: 'Open Admin', exact: true }).waitFor()
    await capture('mobile-released', true)
    await page.emulateMedia({ colorScheme: 'dark' })
    await capture('mobile-released-dark', true)
    expect((await input.gateway.review.status(input.adminId))!.state).toBe('released')
    await input.verifyReleased()
    expect(calls.every(call => call.path.startsWith('/admin/api/governance-recovery'))).toBe(true)
    expect(calls.some(call => call.method === 'POST' && call.status === 409)).toBe(true)
    expect(failures).toEqual([])

  } finally { await fixture.close() }
}
