/** Account verification shares initial reads and withholds private layouts through real Host reconnection. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type Request, type WebSocketRoute } from 'playwright'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v7.jsonl', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./expected/account-init-reconnect/ready.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const PREVIEW = 'section[aria-label="readiness.md"]'
let scaffold: WebScaffold | undefined
let browser: Browser | undefined
let page: Page | undefined
const releaseContexts = new Set<() => void>()

interface LayoutReadProbe {
  phase: 'idle' | 'held' | 'released'
  held: number
  released: number
}

afterEach(async () => {
  for (const release of releaseContexts) release()
  releaseContexts.clear()
  const failures: unknown[] = []
  // A canceled routed request can keep fulfill pending until its owning browser closes.
  await browser?.close().catch((error: unknown) => failures.push(error))
  browser = undefined
  page = undefined
  await scaffold?.close().catch((error: unknown) => failures.push(error))
  scaffold = undefined
  if (failures.length > 0) throw new AggregateError(failures, 'Account initialization and reconnect fixture teardown failed')
})

async function accountFixture(name: string) {
  scaffold = await launchWebScaffold({ workbench: true })
  const host = scaffold
  await writeFile(join(host.workspaceCwd, 'readiness.md'), '# Saved preview ready\n\nAccount-owned content from the real Host reader.\n')
  await writeFile(join(host.workspaceCwd, 'other-account.md'), '# Other account only\n\nThis fixture belongs to another account.\n')
  const seed = (await readFile(await selectedSessionFixture(SEED), 'utf8'))
    .replace('"text":"DONE"', '"text":"[Open saved preview](readiness.md)"')
  const sessionId = await seedSession(host, seed, `account-init-reconnect-${name}`)
  const workspace = await host.ctx.workspaceRegistry.create(host.workspaceCwd)
  await workspace.attachSession(sessionId)
  browser = await chromium.launch()
  page = await newEnglishPage(browser)
  const target = page
  target.setDefaultTimeout(30_000)
  onTestFailed(() => saveFailureShot(target, `account-init-reconnect-${name}`))
  const tripwire = watchConsole(target)
  const owner = new URL(host.authenticatedUrl)
  const contextRequests: Request[] = []
  const failedContexts: Request[] = []
  const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []
  let descriptions = 0
  let heldContext: {
    requested: PromiseWithResolvers<undefined>
    gate: PromiseWithResolvers<undefined>
  } | undefined
  target.on('requestfailed', (request) => {
    const url = new URL(request.url())
    if (url.origin === owner.origin && url.pathname === '/account/api/context') failedContexts.push(request)
  })
  await target.routeWebSocket(url => url.host === owner.host && url.pathname === '/api/events.host'
    && url.searchParams.get('dshTarget') === 'personal', (client) => {
    sockets.push({ client, server: client.connectToServer() })
  })
  // Gateway identity and catalog metadata are external inputs; Host APIs, sockets and file readers remain real.
  await target.route(url => url.origin === owner.origin && url.pathname === '/api/host.describe', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as {
      result: { ok: true; value: { executionAuthorityRequired: boolean; runtimeTarget: { kind: 'personal' } } } | { ok: false }
    }
    expect(body.result.ok).toBe(true)
    if (body.result.ok) {
      body.result.value.executionAuthorityRequired = true
      body.result.value.runtimeTarget = { kind: 'personal' }
    }
    await route.fulfill({ response, json: body })
    descriptions++
  })
  await target.route(url => url.origin === owner.origin && url.pathname === '/account/api/context', async (route) => {
    contextRequests.push(route.request())
    const pending = heldContext
    if (pending !== undefined) {
      pending.requested.resolve(undefined)
      await pending.gate.promise
    }
    if (route.request().failure() !== null) return
    await route.fulfill({ headers: { 'x-dsh-principal-id': '1' }, json: {
      user: { id: 1, username: 'fixture', displayName: 'Fixture', role: 'admin' },
      scope: { kind: 'personal' }, projects: [],
    } })
  })
  await target.route(url => url.origin === owner.origin && url.pathname === '/account/api/workbench/catalog', async (route) => {
    await route.fulfill({ headers: { 'x-dsh-principal-id': '1' }, json: {
      personal: { id: 1, name: 'Fixture' }, personalComplete: true, activeRuntime: { kind: 'personal' }, projects: [],
      items: [{ sessionId, runtime: { kind: 'personal' }, visibility: 'personal', title: 'Saved preview fixture',
        creatorUserId: 1, creatorDisplayName: 'Fixture', updatedAt: 1, blank: false, canWrite: true }],
    } })
  })
  await target.addInitScript((id) => {
    if (window !== window.top) return
    Object.assign(window, {
      __DSH_DOCUMENT_IDENTITY__: { version: 1, principalId: 1, runtimeTarget: { kind: 'personal' } },
    })
    localStorage.setItem('dsh.sessions.current.v2.1.personal', JSON.stringify({ sessionId: id }))
    const probe: LayoutReadProbe = { phase: 'idle', held: 0, released: 0 }
    Object.assign(window, { __accountLayoutReads: probe })
    const getItem = Object.getOwnPropertyDescriptor(Storage.prototype, 'getItem')!.value as Storage['getItem']
    Storage.prototype.getItem = function (this: Storage, key: string): string | null {
      if (key.startsWith('dsh.sidebar-right.v1.') && probe.phase !== 'idle') probe[probe.phase]++
      return getItem.call(this, key)
    }
  }, sessionId)
  return {
    host, target, tripwire, sessionId, contextRequests, failedContexts, sockets,
    describeResponses: () => descriptions,
    holdContext: () => {
      const pending = { requested: Promise.withResolvers<undefined>(), gate: Promise.withResolvers<undefined>() }
      heldContext = pending
      const release = (): void => {
        if (heldContext === pending) heldContext = undefined
        releaseContexts.delete(release)
        pending.gate.resolve(undefined)
      }
      releaseContexts.add(release)
      return { requested: pending.requested.promise, release }
    },
  }
}

async function snapshotPreview(target: Page, host: WebScaffold): Promise<void> {
  const preview = target.getByRole('region', { name: 'readiness.md', exact: true })
  await preview.getByRole('heading', { name: 'Saved preview ready', exact: true }).waitFor()
  await expect.poll(() => preview.getByRole('button', { name: 'Reload', exact: true }).isEnabled()).toBe(true)
  expect(await target.getByRole('region', { name: 'other-account.md', exact: true }).count()).toBe(0)
  expect(await target.getByRole('heading', { name: 'Other account only', exact: true }).count()).toBe(0)
  await compareOrRefreshGolden(GOLDEN, await captureStableAria(target, PREVIEW, host.workspaceCwd), MODE)
}

it.skipIf(MODE === 'record')('keeps the initial account request pending through the real handshake and opens its authorized preview once verified', async () => {
  const fixture = await accountFixture('initial')
  const { host, target, tripwire } = fixture
  const context = fixture.holdContext()
  const [baseline] = await Promise.all([
    target.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace.list'),
    target.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' }),
    context.requested,
  ])
  expect(baseline.ok()).toBe(true)
  expect(await baseline.finished()).toBeNull()
  const open = target.getByRole('button', { name: 'Open saved preview', exact: true })
  await open.waitFor()
  expect(fixture.describeResponses()).toBe(1)
  expect(fixture.sockets).toHaveLength(1)
  expect(fixture.contextRequests).toHaveLength(1)
  expect(fixture.failedContexts).toEqual([])
  expect(await target.getByRole('region', { name: 'readiness.md', exact: true }).count()).toBe(0)
  context.release()
  await target.getByRole('button', { name: 'Switch personal or project scope', exact: true }).waitFor()
  await open.click()
  await snapshotPreview(target, host)
  expect(fixture.contextRequests).toHaveLength(1)
  expect(fixture.failedContexts).toEqual([])
  expect(await target.locator('[data-slot-error]').count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it.skipIf(MODE === 'record')('reads no saved private layout before reconnect account verification and restores only the matching account preview', async () => {
  const fixture = await accountFixture('reconnect')
  const { host, target, tripwire, sessionId } = fixture
  await target.goto(host.authenticatedUrl, { waitUntil: 'load' })
  await target.getByRole('button', { name: 'Switch personal or project scope', exact: true }).waitFor()
  await target.getByRole('button', { name: 'Open saved preview', exact: true }).click()
  await snapshotPreview(target, host)
  await target.evaluate((id) => {
    const scope = JSON.stringify(['account:1', ['personal'], id])
    const saved = localStorage.getItem(`dsh.sidebar-right.v1.${scope}`)
    if (saved === null || !saved.includes('readiness.md')) throw new Error('The real preview did not save its account-owned layout')
    const otherScope = JSON.stringify(['account:2', ['personal'], id])
    localStorage.setItem(`dsh.sidebar-right.v1.${otherScope}`,
      saved.replaceAll('account:1', 'account:2').replaceAll('readiness.md', 'other-account.md'))
    const probe = (window as unknown as { __accountLayoutReads: LayoutReadProbe }).__accountLayoutReads
    probe.phase = 'held'
    probe.held = 0
    probe.released = 0
  }, sessionId)
  const context = fixture.holdContext()
  const previousDescriptions = fixture.describeResponses()
  const previousContextRequests = fixture.contextRequests.length
  const established = fixture.sockets.at(-1)
  if (established === undefined) throw new Error('The root Host stream was not established')
  const warningsBefore = tripwire.warnings.length
  await established.client.close({ code: 1012, reason: 'Fixture account revalidation' })
  await established.server.close({ code: 1012, reason: 'Fixture account revalidation' })
  await context.requested
  await expect.poll(() => target.getByRole('region', { name: 'readiness.md', exact: true }).count()).toBe(0)
  expect(fixture.describeResponses()).toBe(previousDescriptions + 1)
  expect(fixture.contextRequests).toHaveLength(previousContextRequests + 1)
  expect(await target.evaluate(() =>
    (window as unknown as { __accountLayoutReads: LayoutReadProbe }).__accountLayoutReads.held)).toBe(0)
  await target.evaluate(() => {
    (window as unknown as { __accountLayoutReads: LayoutReadProbe }).__accountLayoutReads.phase = 'released'
  })
  context.release()
  await snapshotPreview(target, host)
  const reads = await target.evaluate(() => {
    const probe = (window as unknown as { __accountLayoutReads: LayoutReadProbe }).__accountLayoutReads
    return { held: probe.held, released: probe.released }
  })
  expect(reads).toEqual({ held: 0, released: 1 })
  expect(fixture.failedContexts).toEqual([])
  acknowledgeReloadConnectionLoss(tripwire, warningsBefore)
  expect(await target.locator('[data-slot-error]').count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
