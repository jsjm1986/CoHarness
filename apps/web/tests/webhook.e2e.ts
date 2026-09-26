/** Signed webhook intake through the real Web composition, Agent loop and durable Session. */
import { createHmac, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WebhookDeliveryId, WebhookRuleId, WebhookSourceId } from '@deepseek-ai/dsh-webhook'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const directory = fileURLToPath(new URL('./snapshots/webhook', import.meta.url))
const prompt = 'A signed external event requests a review.'
const reply = 'The webhook review is complete.'

/** Only the external model is controlled; Session and permission behavior remain composed. */
class WebhookModel extends LlmAdapter {
  calls: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('webhook composed delivery', () => {
  let scaffold: WebScaffold
  let browser: Browser | undefined
  const model = new WebhookModel()
  const secret = randomBytes(32).toString('hex')

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./webhook.overlay.yml', import.meta.url)),
      extraInstallAnchors: ['webhook', 'webhook-github'].map(name =>
        fileURLToPath(new URL(`../../../packages/webhook/${name}/package.json`, import.meta.url))),
    })
    scaffold.ctx.llm.registerAdapter(['webhook-fixture'], model)
    scaffold.ctx.webhookRuntime.register({
      id: WebhookRuleId('review'), kind: 'github',
      run: () => ({
        workspacePath: scaffold.workspaceCwd, title: 'Webhook review', prompt,
        agentPreset: 'standard', permissionPreset: 'workspace-write',
        model: { provider: 'webhook-fixture', model: 'fixture' },
      }),
    })
  })

  afterAll(async () => { try { await browser?.close() } finally { await scaffold?.close() } })

  it('rejects missing secrets and wrong signatures, then durably admits and displays one signed request', async () => {
    const body = JSON.stringify({ action: 'review_requested' })
    const send = (signature: string) => fetch(`${scaffold.baseUrl}/webhook-acceptance`, {
      method: 'POST', headers: {
        'content-type': 'application/json', 'x-github-event': 'pull_request',
        'x-github-delivery': 'webhook-browser-delivery', 'x-hub-signature-256': signature,
      }, body,
    })
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    const missing = await send(signature)
    expect(missing.status).toBe(503)
    await missing.text()
    await scaffold.ctx.credentials.set(credentialRef('DSH_WEBHOOK_ACCEPTANCE_SECRET'), secret)
    const invalid = await send(`sha256=${'0'.repeat(64)}`)
    expect(invalid.status).toBe(401)
    await invalid.text()
    expect(scaffold.ctx.sessions.list()).toEqual([])
    expect(model.calls).toEqual([])

    const accepted = await send(signature)
    expect(accepted.status).toBe(202)
    await accepted.text()
    await expect.poll(() => model.calls.length).toBe(1)
    const [session] = scaffold.ctx.sessions.list()
    if (session === undefined) throw new Error('Webhook created no Session')
    await expect.poll(() => session.snapshotEvents().filter(event => event.type === 'turn/end').length).toBe(1)
    const [workspace] = scaffold.ctx.workspaceRegistry.list()
    expect(workspace?.sessionIds).toEqual([session.id])
    expect(session.header.cwd).toBe(scaffold.workspaceCwd)
    const admitted = session.snapshotEvents().flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
    expect(admitted.map(message => message.source)).toMatchObject([{
      kind: 'webhook', provider: 'github', source: 'acceptance', deliveryId: 'webhook-browser-delivery', ruleId: 'review',
    }])
    await expect.poll(async () => (await scaffold.ctx.sessionPersistence.inspect(session.id)).events
      .some(event => event.type === 'assistant/message')).toBe(true)

    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    onTestFailed(() => saveFailureShot(page, 'webhook-composed'))
    const tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.getByText(reply, { exact: true }).waitFor()
    await page.locator('[data-turn-process="1"]').click()
    await page.locator('[data-context-summary]').filter({ hasText: 'github webhook handled by review' }).click()
    await page.getByText(prompt, { exact: true }).waitFor()
    expect(await page.getByText(prompt, { exact: true }).count()).toBe(1)
    await compareOrRefreshGolden(join(directory, 'notice.expected.md'),
      await captureStableAria(page, '[data-context-injection-body][data-context-form="notice"]', scaffold.workspaceCwd), webSnapshotMode())
    expect(tripwire.pageErrors).toEqual([])
    expect(await page.locator('[data-slot-error]').count()).toBe(0)
  })

  it('owns its conversation golden', async () => {
    await assertFixtureInventory(directory, ['notice.expected.md'])
  })

  it('returns the actual admitted Session to an awaited intake caller', async () => {
    const id = await scaffold.ctx.webhookRuntime.invoke(WebhookRuleId('review'), {
      kind: 'github', source: WebhookSourceId('awaited-acceptance'), deliveryId: WebhookDeliveryId('awaited-delivery'),
      receivedAt: Date.now(), event: { action: 'opened' },
    })
    expect(id).not.toBeNull()
    const session = scaffold.ctx.sessions.list().find(candidate => candidate.id === id)
    if (session === undefined) throw new Error('Admission returned a missing Session')
    expect(session.snapshotEvents().flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
      .map(message => message.source)).toMatchObject([{ kind: 'webhook', source: 'awaited-acceptance', deliveryId: 'awaited-delivery' }])
    await expect.poll(() => session.snapshotEvents().filter(event => event.type === 'turn/end').length).toBe(1)
  })
})
