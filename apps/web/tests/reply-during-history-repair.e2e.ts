/** A real Host's resumed reply reaches the browser while its history repair is pending. */
import { fileURLToPath } from 'node:url'
import type { Browser, WebSocketRoute } from 'playwright'
import { expect, it } from 'vitest'
import { createUserMessage, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { launchPersonalComputersFixture, personalTargets } from './personal-computers-fixture.ts'
import { responsiveBrowser } from './responsive-browser.ts'
import { compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { completionBarrier, newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const GOLDEN = fileURLToPath(new URL('./expected/reply-during-history-repair.expected.md', import.meta.url))
const PREFIX = 'The original response survives'
const INTERMEDIATE = ' the history'
const LAST_CHUNK = ' wait.'
const SUFFIX = INTERMEDIATE + LAST_CHUNK
const PROVIDER = 'web-reconnect-controlled'

class PausedReply extends LlmAdapter {
  readonly advance = completionBarrier()
  readonly resume = completionBarrier()
  private calls = 0

  constructor(private readonly prime = true, private readonly holdIntermediate = false) { super() }

  get attempts(): number { return this.calls }

  override async *stream(): AsyncIterable<StreamChunk> {
    const priming = this.calls++ === 0 && this.prime
    const first = priming ? 'A prior reply is already saved.' : PREFIX
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: first }
    if (!priming) {
      if (this.holdIntermediate) {
        await this.advance.promise
        yield { type: 'text-delta', index: 0, text: INTERMEDIATE }
      }
      await this.resume.promise
      yield { type: 'text-delta', index: 0, text: this.holdIntermediate ? LAST_CHUNK : SUFFIX }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: priming ? first : first + SUFFIX } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.skipIf(MODE === 'record').each([false, true])('shows the reply with reconnect history held (title changed: %s)', async (renameWhileOffline) => {
  const host = await launchWebScaffold()
  const adapter = new PausedReply()
  const releaseHistory = completionBarrier()
  const allowReconnect = completionBarrier()
  let browser: Browser | undefined
  try {
    host.ctx.effect(() => host.ctx.llm.registerAdapter([PROVIDER], adapter), 'web reconnect adapter')
    const sessionId = SessionId('reply-during-history-repair')
    const handle = await host.ctx.agents.create({
      sessionId,
      meta: { cwd: host.workspaceCwd },
      agentOptions: { provider: PROVIDER, model: 'fixture' },
    })
    const workspace = await host.ctx.workspaceRegistry.create(host.workspaceCwd)
    await workspace.attachSession(sessionId)
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Prepare the prior history.' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    browser = await responsiveBrowser.launch()
    const page = await newEnglishPage(browser)
    const chat = page.locator(`[data-conversation-session*="${sessionId}"]`)
    const origin = new URL(host.authenticatedUrl).origin
    const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []
    let recovering = false
    let historyReads = 0
    let subscribed = false
    let canonicalDelivered = false
    await page.routeWebSocket(url => url.origin.replace(/^ws/, 'http') === origin && url.pathname === '/api/events.mux', async (client) => {
      if (recovering) await allowReconnect.promise
      const server = client.connectToServer()
      sockets.push({ client, server })
      server.onMessage((message) => {
        client.send(message)
        if (!recovering || typeof message !== 'string' || !message.includes(sessionId)) return
        if (message.includes('"type":"session/subscribed"')) subscribed = true
        if (message.includes('"type":"assistant/message"')) canonicalDelivered = true
      })
    })
    await page.route(url => url.origin === origin && url.pathname === '/api/session.history', async (route) => {
      if (recovering && route.request().postData()?.includes(sessionId)) {
        historyReads++
        await releaseHistory.promise
      }
      await route.fallback()
    })
    await page.goto(host.authenticatedUrl, { waitUntil: 'load' })
    const workspaceRow = page.getByRole('treeitem').first()
    await workspaceRow.waitFor()
    if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
    if (!(await chat.isVisible())) {
      await page.locator(`[data-row-key^="session:"][data-row-key*="${sessionId}"]`).click({ timeout: 10_000 })
    }
    try { await chat.getByText('A prior reply is already saved.', { exact: true }).waitFor({ timeout: 10_000 }) }
    catch (error) { await saveFailureShot(page, 'reply-during-history-repair'); throw error }
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Keep the reply visible across reconnection.' }],
      source: { kind: 'user' },
    }))
    await chat.getByText(PREFIX, { exact: true }).waitFor()
    const initial = sockets.at(-1)
    if (initial === undefined) throw new Error('No browser event stream was established')
    recovering = true
    await initial.client.close({ code: 1012, reason: 'Reply reconnect fixture' })
    await initial.server.close({ code: 1012, reason: 'Reply reconnect fixture' })
    if (renameWhileOffline) {
      handle.agent.session.append('session/title', {
        title: 'Generated during reconnect',
        messageSeqs: [],
        source: { kind: 'fallback' },
      })
    }
    allowReconnect.resolve()
    await expect.poll(() => ({ historyReads, subscribed }), { timeout: 10_000 })
      .toEqual({ historyReads: 1, subscribed: true })
    adapter.resume.resolve()
    await expect.poll(() => canonicalDelivered, { timeout: 10_000 }).toBe(true)
    const reply = chat.getByText(PREFIX + SUFFIX, { exact: true })
    await reply.waitFor({ timeout: 10_000 })
    expect(await reply.count()).toBe(1)
    await compareOrRefreshGolden(GOLDEN, await reply.ariaSnapshot(), MODE)
    expect(historyReads).toBe(1)
    releaseHistory.resolve()
    await handle.agent.whenIdle()
    expect(adapter.attempts).toBe(2)
  } finally {
    allowReconnect.resolve()
    releaseHistory.resolve()
    adapter.resume.resolve()
    try { await browser?.close() } finally { await host.close() }
  }
}, 60_000)

it.skipIf(MODE === 'record').each([
  'title already received', 'only title missed', 'title and predecessor missed',
] as const)('shows the remote reply while Host status is held (%s)', async (scenario) => {
  const allowHost = completionBarrier()
  const allowMux = completionBarrier()
  const allowHistory = completionBarrier()
  const adapter = new PausedReply(false, scenario === 'title already received')
  const remote = personalTargets[1]!
  const sessionId = SessionId('managed-reply-reconnect')
  const title = 'Generated during reconnect'
  let recovering = false
  let requestedHost = false
  let requestedMux = false
  const fixture = await launchPersonalComputersFixture({
    deferredEntry: true, sessionIds: ['unrelated-local-history', sessionId],
    beforeEventUpgrade(runtimeId, path) {
      if (!recovering || runtimeId !== remote.runtimeId) return undefined
      if (path === '/api/events.host') { requestedHost = true; return allowHost.promise }
      if (path === '/api/events.mux') { requestedMux = true; return allowMux.promise }
      return undefined
    },
  })
  let browser: Browser | undefined
  try {
    const host = fixture.worlds[1]!
    host.ctx.effect(() => host.ctx.llm.registerAdapter([PROVIDER], adapter), 'managed Web reconnect adapter')
    const handle = await host.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: PROVIDER, model: 'fixture' } })
    handle.agent.session.append('model/selection', { provider: PROVIDER, model: 'fixture' })
    host.ctx.on('webserver/index-inject', (rows) => {
      rows.push({ kind: 'global', name: '__DSH_DOCUMENT_IDENTITY__', value: {
        version: 1, principalId: 7, runtimeTarget: { kind: 'personal', runtimeId: remote.runtimeId },
      } })
    })
    browser = await responsiveBrowser.launch()
    const page = await newEnglishPage(browser)
    const target = new URL(fixture.url)
    target.searchParams.set('dshRuntime', remote.runtimeId)
    const chat = page.locator(`[data-conversation-session*="${sessionId}"]`)
    const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []
    const resumedFrames: Array<'baseline' | 'title'> = []
    let canonicalDelivered = false
    await page.routeWebSocket(url => url.pathname === '/api/events.mux' && url.searchParams.get('dshRuntime') === remote.runtimeId,
      (client) => {
        const replacement = recovering
        const server = client.connectToServer()
        sockets.push({ client, server })
        server.onMessage((message) => {
          client.send(message)
          if (!replacement || typeof message !== 'string' || !message.includes(sessionId)) return
          if (message.includes('"type":"session/subscribed"') && message.includes('"activeAttempt"')) resumedFrames.push('baseline')
          if (message.includes('"type":"session/title"') && message.includes(title)) resumedFrames.push('title')
          if (message.includes('"type":"assistant/message"')) canonicalDelivered = true
        })
      })
    let ordinaryRecoveryReads = 0
    let preparedRecoveryReads = 0
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (!recovering || url.searchParams.get('dshRuntime') !== remote.runtimeId || !request.postData()?.includes(sessionId)) return
      if (url.pathname === '/api/session.history') ordinaryRecoveryReads++
    })
    await page.route(url => url.pathname === '/api/prepare/v1/session.history' && url.searchParams.get('dshRuntime') === remote.runtimeId,
      async (route) => {
        if (recovering && route.request().postData()?.includes(sessionId)) {
          preparedRecoveryReads++
          await allowHistory.promise
        }
        await route.fallback()
      })
    await page.addInitScript(({ id, session }) => {
      sessionStorage.setItem(`dsh.sessions.current.v3.7.${id}.personal`, JSON.stringify({ sessionId: session }))
    }, { id: remote.runtimeId, session: sessionId })
    await page.goto(target.href)
    await chat.getByText('DONE', { exact: true }).waitFor({ timeout: 10_000 })
    await page.getByRole('region', { name: remote.nodeName, exact: true }).waitFor()
    const draft = page.locator('textarea:enabled').last()
    await draft.fill('Keep this draft on its computer.')
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue across the lost connection.' }], source: { kind: 'user' } }))
    await chat.getByText(PREFIX, { exact: true }).waitFor()
    if (scenario === 'title already received') {
      handle.agent.session.append('session/title', { title, messageSeqs: [], source: { kind: 'fallback' } })
      adapter.advance.resolve()
      await chat.getByText(PREFIX + INTERMEDIATE, { exact: true }).waitFor({ timeout: 5_000 })
    }
    const initial = sockets.at(-1)
    if (initial === undefined) throw new Error('No managed conversation stream was established')
    recovering = true
    await initial.client.close({ code: 1012, reason: 'Managed reply reconnect fixture' })
    await initial.server.close({ code: 1012, reason: 'Managed reply reconnect fixture' })
    await expect.poll(() => requestedMux, { timeout: 5_000 }).toBe(true)
    if (scenario === 'title and predecessor missed') {
      handle.agent.session.append('session/title', { title: 'Earlier offline title', messageSeqs: [], source: { kind: 'fallback' } })
    }
    if (scenario !== 'title already received') {
      handle.agent.session.append('session/title', { title, messageSeqs: [], source: { kind: 'fallback' } })
    }
    allowMux.resolve()
    await expect.poll(() => ({ requestedHost, frames: resumedFrames.length }), { timeout: 5_000 })
      .toEqual({ requestedHost: true, frames: 2 })
    adapter.resume.resolve()
    const reply = chat.getByText(PREFIX + SUFFIX, { exact: true })
    if (scenario === 'title and predecessor missed') {
      await expect.poll(() => ({ canonicalDelivered, preparedRecoveryReads }), { timeout: 5_000 })
        .toEqual({ canonicalDelivered: true, preparedRecoveryReads: 1 })
      expect(await reply.count()).toBe(0)
      allowHistory.resolve()
    }
    await reply.waitFor({ timeout: 5_000 })
    expect(await reply.count()).toBe(1)
    expect(await draft.inputValue()).toBe('Keep this draft on its computer.')
    expect(ordinaryRecoveryReads).toBe(0)
    if (scenario !== 'only title missed') expect(preparedRecoveryReads).toBe(scenario === 'title already received' ? 0 : 1)
    expect(resumedFrames).toEqual(['baseline', 'title'])
    expect(fixture.calls.get(personalTargets[0]!.runtimeId) ?? 0).toBe(0)
    await compareOrRefreshGolden(GOLDEN, await reply.ariaSnapshot(), MODE)
    allowHistory.resolve()
    allowHost.resolve()
    await handle.agent.whenIdle()
    expect(adapter.attempts).toBe(1)
  } finally {
    allowHost.resolve()
    allowMux.resolve()
    allowHistory.resolve()
    adapter.advance.resolve()
    adapter.resume.resolve()
    try { await browser?.close() } finally { await fixture.close() }
  }
}, 60_000)
