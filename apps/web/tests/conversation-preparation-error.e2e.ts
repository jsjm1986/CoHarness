/** A real Host preset failure remains actionable without exposing its private diagnostic in the browser. */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { responsiveBrowser } from './responsive-browser.ts'
import { launchPersonalComputersFixture, personalTargets } from './personal-computers-fixture.ts'
import { captureStableAria, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'

it('retains the exact computer and draft through a real preset failure and an explicit repaired retry', async () => {
  const fixture = await launchPersonalComputersFixture()
  const target = personalTargets[1]!
  const remote = fixture.worlds[1]!
  let removePreset: (() => Promise<void>) | undefined
  let browser: Awaited<ReturnType<typeof responsiveBrowser.launch>> | undefined
  try {
    // The real preset registry records the missing local artifact; no HTTP response is synthesized.
    const privateFile = join(remote.workspaceCwd, 'private-preset-detail', 'unavailable-plugin.mjs')
    removePreset = await remote.ctx.agentPresets.register({ id: 'standard', plugins: [
      { id: 'required-private-plugin', name: pathToFileURL(privateFile).href },
    ] })
    browser = await responsiveBrowser.launch()
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, locale: 'en-US' })
    const pageErrors: string[] = []
    page.on('pageerror', (error) => { pageErrors.push(error.message) })
    const creates: Array<{ runtime: string | null; node: string | null; operation: string | undefined; body: string | null }> = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (request.method() !== 'POST' || url.pathname !== '/api/prepare/v1/session.create') return
      creates.push({ runtime: url.searchParams.get('dshRuntime'), node: url.searchParams.get('dshNode'),
        operation: request.headers()['x-dsh-operation-id'], body: request.postData() })
    })
    await page.goto(fixture.url, { waitUntil: 'networkidle' })
    const computer = page.getByRole('region', { name: 'Compute computer', exact: true })
    await computer.getByRole('button', { name: 'Compute computer', exact: true }).click()
    const [response] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/prepare/v1/session.create'),
      computer.getByRole('button', { name: 'New conversation', exact: true }).click(),
    ])
    const intent = page.locator('[data-conversation-intent]')
    await intent.locator('textarea').fill('Retain this draft on Compute')
    expect(response.status()).toBe(200)
    const result = await response.json() as { result: { ok: boolean; error: { code: string; message: string } } }
    expect(result.result.ok).toBe(false)
    expect(result.result.error.code).toBe('agent-preset-invalid')
    expect(result.result.error.message).toContain('private-preset-detail')
    await expect.poll(() => intent.getAttribute('data-intent-failure')).toBe('preset-unavailable')
    const operation = await intent.getAttribute('data-conversation-intent')
    expect(await intent.getAttribute('data-intent-runtime')).toBe(target.runtimeId)
    expect(await intent.locator('textarea').inputValue()).toBe('Retain this draft on Compute')
    expect(await intent.innerHTML()).not.toMatch(/private-preset-detail|unavailable-plugin|file:\/\/|agent-preset-invalid/)
    const golden = fileURLToPath(new URL('./expected/conversation-preparation-error/preset.expected.md', import.meta.url))
    if (webSnapshotMode() === 'refresh') await mkdir(dirname(golden), { recursive: true })
    await compareOrRefreshGolden(golden,
      await captureStableAria(page, '[data-conversation-intent]', remote.workspaceCwd), webSnapshotMode())
    expect(creates).toHaveLength(1)
    await removePreset()
    removePreset = undefined
    expect(creates).toHaveLength(1)
    await intent.getByRole('button', { name: 'Retry after checking', exact: true }).press('Enter')
    await intent.waitFor({ state: 'hidden' })
    expect(creates).toHaveLength(2)
    for (const request of creates) expect(request).toMatchObject({ runtime: target.runtimeId, node: target.nodeId, operation })
    const first = JSON.parse(creates[0]!.body!) as { payload: { sessionId: string; draftId: string } }
    const retry = JSON.parse(creates[1]!.body!) as { payload: { sessionId: string; draftId: string } }
    expect(retry.payload).toEqual({ ...first.payload, text: 'Retain this draft on Compute' })
    expect(first.payload).toMatchObject({ sessionId: `session-${operation}`, draftId: `draft-${operation}` })
    expect(await page.locator('textarea:enabled').last().inputValue()).toBe('Retain this draft on Compute')
    expect(fixture.receipts.filter(row => row.path === '/api/admit/v1/session.prompt')).toEqual([])
    expect(pageErrors).toEqual([])
  } finally {
    try { await browser?.close() } finally {
      try { await removePreset?.() } finally { await fixture.close() }
    }
  }
})
