/** Restore one personal selection and refresh only directory sections visible in the document. */
import { writeFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { computerBrowser } from './computer-browser.ts'
import { launchPersonalComputersFixture, personalTargets } from './personal-computers-fixture.ts'
import { clientSessionKey, type ClientRuntimeTarget } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

it('restores the offline computer after reload and transfers input only to its original conversation', async () => {
  const fixture = await launchPersonalComputersFixture()
  const browser = await computerBrowser()
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
  const [bootstrap, remote] = personalTargets
  const saved = clientSessionKey(remote as ClientRuntimeTarget, 'same-personal-session' as SessionId)
  const pointer = `dsh.personal.current.v1.account:7.runtime:${bootstrap!.runtimeId}`
  let unavailable = false
  const reads: string[] = []
  try {
    await page.route('**/api/prepare/v1/session.history*', async (route) => {
      const target = new URL(route.request().url()).searchParams.get('dshRuntime')!
      reads.push(target)
      if (unavailable && target === remote!.runtimeId) await route.fulfill({ status: 503, body: 'Offline' })
      else await route.continue()
    })
    await page.goto(fixture.url, { waitUntil: 'networkidle' })
    const group = page.getByRole('region', { name: 'Compute computer', exact: true })
    await group.getByRole('button', { name: 'Compute computer', exact: true }).click()
    await group.getByText('Compute work', { exact: true }).click()
    await group.getByText('Compute conversation', { exact: true }).click()
    const stored = () => page.evaluate(key => sessionStorage.getItem(key), pointer)
    const exact = JSON.stringify({ sessionId: saved, nodeId: remote!.nodeId })
    await expect.poll(stored).toBe(exact)
    unavailable = true
    reads.length = 0
    await page.reload({ waitUntil: 'networkidle' })
    const editor = page.locator('[data-conversation-intent]')
    await editor.getByRole('button', { name: 'Retry' }).waitFor({ timeout: 10_000 })
    expect(await editor.getAttribute('data-intent-runtime')).toBe(remote!.runtimeId)
    await editor.locator('textarea').fill('Keep this input on the Compute computer')
    await editor.locator('textarea').press('Enter')
    const unsent = await editor.locator('textarea').inputValue()
    expect(unsent).toBe('Keep this input on the Compute computer\n')
    expect(fixture.receipts.some(row => row.path === '/api/admit/v1/session.prompt')).toBe(false)
    expect(await stored()).toBe(exact)
    unavailable = false
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await editor.waitFor({ state: 'hidden' })
    await expect.poll(() => page.locator('textarea:enabled').last().inputValue()).toBe(unsent)
    expect(reads).toEqual([remote!.runtimeId, remote!.runtimeId])
  } finally { await page.close(); await browser.close(); await fixture.close() }
}, 90_000)

it('refreshes only visible expanded computer sections on page focus without starting a Runtime', async () => {
  const fixture = await launchPersonalComputersFixture()
  const browser = await computerBrowser()
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 680 } })
  try {
    await page.goto(fixture.url, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'All computers (20)' }).click()
    for (const target of personalTargets) {
      const group = page.getByRole('region', { name: target.nodeName, exact: true })
      const button = group.getByRole('button', { name: target.nodeName, exact: true })
      if (await button.getAttribute('aria-expanded') !== 'true') await button.click()
      await expect.poll(() => fixture.passive.get(target.runtimeId) ?? 0).toBeGreaterThan(0)
    }
    const top = page.getByRole('region', { name: 'Office computer', exact: true }).getByRole('button', { name: 'Office computer', exact: true })
    await top.focus()
    await top.scrollIntoViewIfNeeded()
    await page.waitForFunction(() => {
      const first = document.querySelector('section[aria-label="Office computer"]')
      const last = document.querySelector('section[aria-label="Computer 20"]')
      if (!first?.parentElement || !last) return false
      const bounds = first.parentElement.getBoundingClientRect()
      return first.getBoundingClientRect().bottom > bounds.top && last.getBoundingClientRect().top >= bounds.bottom
    })
    await page.waitForLoadState('networkidle')
    const before = new Map(fixture.passive)
    const grants = page.waitForResponse(r => new URL(r.url()).pathname === '/account/api/runtimes')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await (await grants).finished()
    await expect.poll(() => fixture.passive.get(personalTargets[0]!.runtimeId)!).toBeGreaterThan(before.get(personalTargets[0]!.runtimeId)!)
    await page.waitForLoadState('networkidle')
    const counts = personalTargets.map(target => (fixture.passive.get(target.runtimeId) ?? 0) - (before.get(target.runtimeId) ?? 0))
    const file = process.env['DSH_BROWSER_FOCUS_RECEIPT']
    const result = { computers: counts.length, requests: counts.reduce((n, count) => n + count, 0),
      targetCount: counts.filter(count => count > 0).length, perComputer: counts,
      preparations: [...fixture.preparations.values()].reduce((n, x) => n + x, 0) }
    if (file) await writeFile(file, JSON.stringify(result) + '\n', { mode: 0o600 })
    expect(result.preparations).toBe(0)
    expect(counts[19]).toBe(0)
    expect(Math.max(...counts)).toBe(1)
    expect(result.requests).toBeLessThan(20)
  } finally { await page.close(); await browser.close(); await fixture.close() }
}, 120_000)
