/** A browser retry recovers its own input from the real destination Host after losing both replies. */
import { fileURLToPath } from 'node:url'
import { computerBrowser } from './computer-browser.ts'
import { expect, it } from 'vitest'
import type { Page } from 'playwright'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { launchPersonalComputersFixture, personalTargets } from './personal-computers-fixture.ts'
import { compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'

async function selectComputeConversation(page: Page, submitted: string) {
  const computer = page.getByRole('region', { name: 'Compute computer', exact: true })
  const workspace = computer.getByText('Compute work', { exact: true })
  if (!(await workspace.isVisible()))
    await computer.getByRole('button', { name: 'Compute computer', exact: true }).click()
  const row = computer
    .getByText(submitted, { exact: true })
    .or(computer.getByText('Compute conversation', { exact: true }))
    .first()
  if (!(await row.isVisible())) await workspace.click()
  await row.click()
  await page.locator('[data-conversation-intent]').waitFor({ state: 'hidden' })
  return page.locator('textarea:enabled').last()
}

function receiptSlots(page: Page) {
  return page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('dsh.prompt-receipt.')))
}

it('recovers the lost admission after reload, then sends the same text independently from a copied tab', async () => {
  const reply = fileURLToPath(
    new URL('../../../examples/acp-agent/tests/snapshots/multi-turn/session.v7.jsonl', import.meta.url),
  )
  const fixture = await launchPersonalComputersFixture({ remoteReplay: { file: reply, children: [] } })
  const browser = await computerBrowser()
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 } })
  const sent: string[] = []
  const statusIds: string[] = []
  const words = 'Retain this private draft across receipt loss',
    target = personalTargets[1]!
  let offline = true
  let acceptedReplyLost = false
  let statusReplyLost = false
  let scenarioFailure: unknown
  try {
    await page.goto(fixture.url, { waitUntil: 'networkidle' })
    const editor = await selectComputeConversation(page, words)
    await editor.fill(words)
    await expect
      .poll(() =>
        fixture.draftReceipts.some(r => r.node === 1 && r.method === 'PUT' && r.status === 200 && r.hasText),
      )
      .toBe(true)
    await page.context().route('**/api/admit/v1/session.prompt?**', async (route) => {
      const req = route.request(),
        body = req.postDataJSON() as { payload: { requestId: string } }
      expect(new URL(req.url()).searchParams.get('dshRuntime')).toBe(target.runtimeId)
      sent.push(body.payload.requestId)
      const response = await route.fetch()
      const envelope: unknown = await response.json()
      expect(envelope).toEqual(expect.objectContaining({ result: { ok: true, value: { accepted: true } } }))
      if (offline) {
        await route.abort('failed')
        acceptedReplyLost = true
      } else await route.fulfill({ response })
    })
    await page.context().route('**/api/admit/v1/session.status?**', async (route) => {
      const body = route.request().postDataJSON() as { payload: { requestId: string } }
      statusIds.push(body.payload.requestId)
      if (offline) {
        await route.abort('failed')
        statusReplyLost = true
      } else await route.continue()
    })
    await editor.press('Enter')
    await expect
      .poll(() => ({ acceptedReplyLost, statusReplyLost }), { timeout: 15_000 })
      .toEqual({
        acceptedReplyLost: true,
        statusReplyLost: true,
      })
    const pendingText = await editor.inputValue()
    expect(pendingText).toBe(words)
    const record = await receiptSlots(page)
    expect(record).toHaveLength(1)
    expect(JSON.stringify(record)).not.toContain(words)
    const [copy] = await Promise.all([
      page.waitForEvent('popup'),
      page.evaluate(() => {
        window.open(location.href, '_blank')
      }),
    ])
    await copy.waitForLoadState('networkidle')
    expect(await receiptSlots(copy)).toEqual(record)
    offline = false
    await page.reload({ waitUntil: 'networkidle' })
    if (!(await editor.isVisible()) || (await editor.inputValue()) !== words) {
      await selectComputeConversation(page, words)
    }
    await expect.poll(() => editor.inputValue()).toBe(words)
    const restoredText = await editor.inputValue()
    await editor.press('Enter')
    await expect.poll(() => editor.inputValue()).toBe('')
    const submissionsAfterRetry = sent.length
    expect(submissionsAfterRetry).toBe(1)
    expect(statusIds.filter(id => id === sent[0]).length).toBeGreaterThanOrEqual(2)
    expect(await receiptSlots(copy)).toEqual(record)
    const independentEditor = await selectComputeConversation(copy, words)
    await independentEditor.fill(words)
    await independentEditor.press('Enter')
    await expect.poll(() => independentEditor.inputValue()).toBe('')
    expect(new Set(sent).size).toBe(2)
    expect(await receiptSlots(copy)).toEqual([])
    expect(await receiptSlots(page)).toEqual([])
    let durableInputs = 0
    await expect
      .poll(async () => {
        const persisted = await fixture.worlds[1]!.ctx.sessionPersistence.inspect('same-personal-session' as SessionId)
        const ids = persisted.events
          .flatMap(event =>
            event.type === 'agent/inbox/spliced'
              ? event.data.inserted
                .filter(msg => msg.content.some(block => block.type === 'text' && block.text === words))
                .map(msg => msg.source)
              : [],
          )
          .flatMap(src => (src.kind === 'user' && 'rpcId' in src ? [src.rpcId] : []))
        durableInputs = ids.length
        return ids
      })
      .toEqual(sent)
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./expected/personal-computers/recovered-prompt.expected.md', import.meta.url)),
      [
        `The pending draft reads “${pendingText}”.`,
        `After reload the draft reads “${restoredText}”.`,
        `After retry the original tab has made ${submissionsAfterRetry} submission.`,
        `After sending the same text in the copied tab the Runtime holds ${durableInputs} separate inputs.`,
      ].join('\n'),
      webSnapshotMode(),
    )
  } catch (error) {
    scenarioFailure = error
    throw error
  } finally {
    await page.close()
    await browser.close()
    try {
      await fixture.close()
    } catch (error) {
      if (!scenarioFailure) throw error
      console.error('Managed prompt replay cleanup failed after its scenario:', String(error))
    }
  }
}, 120_000)
