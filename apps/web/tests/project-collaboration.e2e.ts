/** Project collaboration controls through the shipped Web composition. */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page, Route } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedBlankSession, seedSession, watchConsole, webSnapshotMode, acknowledgeReloadConnectionLoss,
  fixtureUserPrompts, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/project-collaboration', import.meta.url))
const PRIVATE_DRAFTS_DIR = fileURLToPath(new URL('./expected/project-collaboration', import.meta.url))
const SCOPE_PICKER_EXPECTED = join(SNAPSHOT_DIR, 'scope-picker.expected.md')
const SCOPE_PICKER_MOBILE_EXPECTED = join(SNAPSHOT_DIR, 'scope-picker-mobile.expected.md')
const SHARING_EXPECTED = join(SNAPSHOT_DIR, 'sharing.expected.md')
const SWITCHING_EXPECTED = join(SNAPSHOT_DIR, 'switching.expected.md')
const READ_ONLY_EXPECTED = join(SNAPSHOT_DIR, 'read-only.expected.md')
const INCOMING_INVITATION_EXPECTED = join(SNAPSHOT_DIR, 'incoming-invitation.expected.md')
const HEADER_GEOMETRY_EXPECTED = join(SNAPSHOT_DIR, 'header-geometry.expected.md')
const PRIVATE_DRAFTS_EXPECTED = join(PRIVATE_DRAFTS_DIR, 'private-drafts.expected.md')
const SHIPPED_PRESETS = fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url))
const MODE = webSnapshotMode()
const SESSION_ID = 'project-collaboration-web-e2e'
const BLANK_SESSION_ID = 'project-collaboration-project-blank'
const SEEDED_PROMPT = 'Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.'

type ProjectMode = 'ro' | 'rw'

const NAV_RUNTIME_A = '10000000-0000-4000-8000-000000000001'
const NAV_RUNTIME_B = '10000000-0000-4000-8000-000000000002'
const NAV_RUNTIME_PROJECT = '10000000-0000-4000-8000-000000000003'
const NAV_SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/space-navigation', import.meta.url))

function navigationRuntime(id: string | null) {
  const nodeId = id === NAV_RUNTIME_A || id === null ? '20000000-0000-4000-8000-000000000001' : '20000000-0000-4000-8000-000000000002'
  const nodeName = nodeId.endsWith('1') ? 'Office computer' : 'Compute computer'
  const location = { nodeId, nodeName, runtimeId: id ?? NAV_RUNTIME_A }
  return id === NAV_RUNTIME_PROJECT ? { kind: 'project' as const, projectId: 9, projectName: 'Payments migration', ...location }
    : { kind: 'personal' as const, ...location }
}

function navigationTarget(route: Route) {
  const id = new URL(route.request().url()).searchParams.get('dshRuntime')
    ?? new URL(route.request().frame().page().url()).searchParams.get('dshRuntime')
  return navigationRuntime(id)
}

function collaborationContext(mode: ProjectMode, extraProjects = 0, accountId = 7) {
  return {
    user: { id: accountId, username: accountId === 7 ? 'lin' : 'zhou', displayName: accountId === 7 ? 'Lin' : 'Zhou', role: 'member' },
    scope: { kind: 'project', projectId: 9, projectName: 'Payments migration', mode },
    projects: [
      { projectId: 9, name: 'Payments migration', path: '/srv/payments', mode },
      { projectId: 10, name: 'Audit platform', path: '/srv/audit', mode: mode === 'ro' ? 'rw' : 'ro' },
      ...Array.from({ length: extraProjects }, (_, index) => ({
        projectId: 100 + index,
        name: `Archive space ${index + 1}`,
        path: `/srv/archive-${index + 1}`,
        mode,
      })),
    ],
  }
}

function conversationDetail(
  mode: ProjectMode,
  sessionId: string = SESSION_ID,
  visibility: 'project' | 'private' = 'project',
) {
  const writable = mode === 'rw'
  return {
    access: {
      sessionId,
      rootSessionId: sessionId,
      projectId: 9,
      visibility,
      creatorUserId: 7,
      mode,
      canRead: true,
      canWrite: writable,
      canManage: writable,
    },
    conversation: {
      sessionId,
      creatorUserId: 7,
      creatorDisplayName: 'Lin',
      visibility,
      updatedAt: 1_786_767_200_000,
      participants: [
        { userId: 7, displayName: 'Lin', contributionCount: 3, lastContributedAt: 1_786_767_100_000 },
        { userId: 8, displayName: 'Zhou', contributionCount: 1, lastContributedAt: 1_786_767_150_000 },
      ],
    },
  }
}

async function mockGateway(page: Page | BrowserContext, mode: ProjectMode, options: {
  runtimeDirectory?: boolean
  scopeReady?: Promise<void>
  extraProjects?: number
  accountId?: () => number
  contextReady?: () => Promise<void>
} = {}): Promise<{
  visibilityBodies: string[]
  conversationReads: string[]
  conversationUrls: string[]
  visibilityBySession: Map<string, 'project' | 'private'>
}> {
  const visibilityBodies: string[] = []
  const conversationReads: string[] = []
  const conversationUrls: string[] = []
  const visibilityBySession = new Map<string, 'project' | 'private'>()
  await page.route(/\/account\/api\/deployment\/context$/, async (route) => {
    const entry = { nodeId: navigationRuntime(NAV_RUNTIME_A).nodeId, name: 'Office computer' }
    await route.fulfill({ json: { mode: options.runtimeDirectory ? 'multi' : 'single', revision: '1', entry,
      primary: options.runtimeDirectory ? { ...entry, origin: new URL(route.request().url()).origin } : null,
      role: options.runtimeDirectory ? 'primary' : 'standalone', scope: options.runtimeDirectory ? 'organization' : 'local',
      refreshAfterMs: 30000, legacyMigrationRequired: false } })
  })
  await page.route(/\/api\/host\.describe(?:\?.*)?$/, async (route) => {
    const response = await route.fetch()
    const body = await response.json() as {
      result: { ok: true; value: { runtimeTarget?: unknown; executionAuthorityRequired?: boolean } } | { ok: false }
    }
    if (body.result.ok) {
      body.result.value.runtimeTarget = options.runtimeDirectory ? navigationTarget(route) : { kind: 'project', projectId: 9 }
      if (options.accountId !== undefined) body.result.value.executionAuthorityRequired = true
    }
    await route.fulfill({ response, json: body })
  })
  await page.route(/\/account\/api\/context(?:\?.*)?$/, async (route) => {
    await options.contextReady?.()
    const context = collaborationContext(mode, options.extraProjects ?? 0, options.accountId?.() ?? 7)
    const target = navigationTarget(route)
    await route.fulfill({ json: options.runtimeDirectory ? { ...context, scope: target.kind === 'project' ? { ...target, mode } : target,
      environment: { id: target.runtimeId, nodeId: target.nodeId, nodeName: target.nodeName } } : context })
  })
  // Prepared/admitted Session operations run over the gateway's versioned
  // route prefix; the real Host serves them natively, but only the gateway
  // stamps the answering runtime's identity — reproduce that header.
  await page.route(/\/api\/(?:prepare|admit)\/v1\//, async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'x-dsh-runtime-id': navigationTarget(route).runtimeId } })
  })
  // Tab drafts live on the owning Runtime's node draft store: a revisioned
  // read/write surface answered by the gateway, emulated here with the same
  // pinned-read and compare-and-save semantics as gateway/src/node-drafts.ts.
  const drafts = new Map<string, { revision: number; text: string; previous: Map<number, string> }>()
  await page.route(/\/account\/api\/drafts\/[^/?]+(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url())
    const id = url.pathname.slice('/account/api/drafts/'.length)
    const current = drafts.get(id) ?? { revision: 0, text: '', previous: new Map<number, string>() }
    const respond = (status: number, value?: unknown): Promise<void> => route.fulfill({
      status, ...(value === undefined ? {} : { json: value }),
      headers: { 'x-dsh-runtime-id': navigationTarget(route).runtimeId },
    })
    const method = route.request().method()
    if (method === 'GET') {
      const pinned = url.searchParams.get('revision')
      const revision = pinned === null ? undefined : Number(pinned)
      if (revision === undefined) return respond(200, { revision: current.revision, text: current.text })
      if (revision > current.revision) return respond(410)
      const text = revision === current.revision ? current.text : current.previous.get(revision)
      if (text === undefined) return respond(410)
      return respond(200, { revision, text, currentRevision: current.revision })
    }
    const body = JSON.parse(route.request().postData() ?? '{}') as { revision?: number; text?: string }
    const revision = body.revision ?? 0
    const text = method === 'DELETE' ? '' : body.text ?? ''
    if (revision === current.revision) {
      current.previous.set(current.revision, current.text)
      drafts.set(id, { ...current, revision: revision + 1, text })
      return respond(200, { revision: revision + 1, text })
    }
    if (revision === current.revision - 1 && text === current.text) {
      return respond(200, { revision: current.revision, text: current.text })
    }
    return respond(409)
  })
  if (options.runtimeDirectory) await page.route(/\/account\/api\/runtimes(?:\?.*)?$/, async (route) => {
    await route.fulfill({ json: { items: [NAV_RUNTIME_A, NAV_RUNTIME_B, NAV_RUNTIME_PROJECT].map((id) => {
      const target = navigationRuntime(id)
      return { id, owner: { kind: target.kind, id: target.kind === 'personal' ? 7 : 9,
        name: target.kind === 'personal' ? 'Lin' : 'Payments migration' },
      node: { id: target.nodeId, name: target.nodeName, status: 'active', lastHeartbeatAt: null },
      routing: 'local', observedState: 'ready', generation: 1 }
    }), nextCursor: null } })
  })
  if (options.accountId !== undefined) await page.route(/\/account\/api\/workbench\/catalog(?:\?.*)?$/, async (route) => {
    const base = collaborationContext(mode, options.extraProjects ?? 0, options.accountId!())
    const target = navigationTarget(route)
    const context = options.runtimeDirectory ? { ...base, scope: target } : base
    await route.fulfill({ json: {
      personalComplete: true, personal: { id: context.user.id, name: 'Personal' }, activeRuntime: context.scope,
      projects: context.projects, items: [{
        sessionId: SESSION_ID, title: 'Shared release room', runtime: options.runtimeDirectory ? target : { kind: 'project', projectId: 9, projectName: 'Payments migration' },
        visibility: 'project', creatorUserId: 7, creatorDisplayName: 'Lin', updatedAt: 1, blank: false, canWrite: mode === 'rw',
      }],
    } })
  })
  await page.route(/\/account\/api\/scope(?:\?.*)?$/, async (route) => {
    if (options.scopeReady !== undefined) await options.scopeReady
    await route.fulfill({ status: 204, body: '', ...(options.runtimeDirectory ? { headers: { location: `/?dshRuntime=${navigationTarget(route).runtimeId}` } } : {}) })
  })
  await page.route('**/account/api/conversations/*', async (route) => {
    conversationUrls.push(route.request().url())
    if (route.request().method() === 'PATCH') {
      visibilityBodies.push(route.request().postData() ?? '')
      await route.fulfill({ status: 204, body: '' })
      return
    }
    const pathname = new URL(route.request().url()).pathname
    const sessionId = decodeURIComponent(pathname.slice('/account/api/conversations/'.length))
    await route.fulfill({
      json: conversationDetail(mode, sessionId, visibilityBySession.get(sessionId) ?? 'project'),
    })
    conversationReads.push(sessionId)
  })
  return { visibilityBodies, conversationReads, conversationUrls, visibilityBySession }
}

/**
 * Drive the pushed scope page: open it, stage `Only me` through the second
 * visibility level, and close it again through the trigger.
 */
async function stagePrivateVisibility(page: Page): Promise<void> {
  const scope = page.getByRole('button', { name: 'Switch personal or project scope' })
  const scopePage = page.getByRole('dialog', { name: 'Switch personal or project scope' })
  await scopePage.waitFor({ timeout: 10_000 })
  await scopePage.getByRole('tab', { name: 'Manage spaces' }).click()
  await scopePage.getByRole('button', { name: 'New conversation visibility' }).click()
  await scopePage.getByRole('radio', { name: /Only me/ }).click()
  await scope.click()
}

async function openSeededSession(page: Page, scaffold: WebScaffold, runtimeId?: string): Promise<void> {
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  if (runtimeId !== undefined) {
    const destination = new URL(scaffold.baseUrl)
    destination.searchParams.set('dshRuntime', runtimeId)
    await page.goto(destination.href, { waitUntil: 'load' })
  }
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  await page.getByRole('textbox', { name: /Search (?:sessions|computers, workspaces or conversations)…/u }).fill(SEEDED_PROMPT)
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => results.count(), { timeout: 60_000 }).toBe(1)
  await results.click()
  await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
}

async function seedSubagents(scaffold: WebScaffold, parentId: SessionId, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const childId = SessionId(`${SESSION_ID}-child-${String(index + 1)}`)
    const createdAt = 1_786_767_300_000 + index * 10
    await scaffold.ctx.sessionPersistence.createStored({
      version: SESSION_FORMAT_VERSION,
      id: childId,
      createdAt,
      isSeeded: false,
      cwd: scaffold.workspaceCwd,
      parentSession: parentId,
      origin: 'subagent',
      delegationDepth: 1,
      agentPreset: 'minimal',
    })
    await scaffold.ctx.sessionPersistence.append(childId, [
      {
        type: 'turn/start', seq: 0, time: createdAt,
        data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } },
      },
      {
        type: 'user/message', seq: 1, time: createdAt + 1,
        data: {
          id: `header-child-${String(index + 1)}-user`,
          role: 'user',
          content: [{ type: 'text', text: `Header layout child ${String(index + 1)}.` }],
          source: { kind: 'user' },
        },
        surfaceOp: 'append',
      },
      {
        type: 'subagent/descriptor', seq: 2, time: createdAt + 2,
        data: snapshotSubagentDescriptor({
          mode: 'one-shot', provider: 'spawn', label: `header child ${String(index + 1)}`,
        }),
      },
      {
        type: 'turn/end', seq: 3, time: createdAt + 3,
        data: { turn: 1, reason: { kind: 'completed' } },
      },
    ] as SessionEvent[])
    const childLog = await scaffold.ctx.sessionPersistence.load(childId)
    scaffold.ctx.sessionProjectionCache.coldSnapshot(childLog.meta, childLog.inheritedEventCount, childLog.events)
  }
}

function renderHeaderGeometry(metrics: {
  singleLine: boolean
  titleBeforeSubagents: boolean
  subagentsBeforeSharing: boolean
  presetBeforeSharing: boolean
  presetBeforeUtility: boolean
  participantsMenuOnly: boolean
  subagentsNoWrap: boolean
}): string {
  return [
    '# Project session header actions',
    '',
    '| single row | title before subagents | subagents before sharing | preset before sharing | preset before utility | participants menu-only | subagents no-wrap |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| ${String(metrics.singleLine)} | ${String(metrics.titleBeforeSubagents)} | ${String(metrics.subagentsBeforeSharing)} | ${String(metrics.presetBeforeSharing)} | ${String(metrics.presetBeforeUtility)} | ${String(metrics.participantsMenuOnly)} | ${String(metrics.subagentsNoWrap)} |`,
  ].join('\n')
}

describe.skipIf(MODE === 'record')('web e2e: project collaboration controls', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page | undefined
  let tripwire: ReturnType<typeof watchConsole> | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      agentPresets: { roots: [{ path: SHIPPED_PRESETS, trust: 'system' }], default: 'standard' },
    })
    const seeded = await seedSession(scaffold, await readFile(SEED, 'utf8'), SESSION_ID, 'ptc')
    await seedSubagents(scaffold, seeded, 6)
    const blank = await seedBlankSession(scaffold, BLANK_SESSION_ID, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(seeded)
    await workspace.attachSession(blank)
    browser = await chromium.launch()
  }, 120_000)

  afterEach(async () => {
    try {
      expect(tripwire?.warnings ?? []).toEqual([])
      expect(tripwire?.pageErrors ?? []).toEqual([])
    } finally {
      await page?.close()
      page = undefined
      tripwire = undefined
    }
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'project collaboration e2e cleanup failed')
  })

  it('accepts an incoming invitation while viewing another read-only project without changing its Runtime', async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await mockGateway(page, 'ro')
    let accepted = false, protectedReads = 0, scopeChanges = 0
    const invitation = { id: 'incoming-other-project', projectId: 19, projectName: 'Compute release room',
      invitee: { id: 7, username: 'lin', displayName: 'Lin' }, inviter: { id: 8, username: 'zhou', displayName: 'Zhou' },
      mode: 'ro', status: 'pending', createdAt: '2026-10-31T00:00:00.000Z', expiresAt: null, respondedAt: null }
    await page.route(/\/account\/api\/invitations\/count$/, route => route.fulfill({ json: { pending: accepted ? 0 : 1 } }))
    await page.route(/\/account\/api\/invitations$/, route => route.fulfill({ json: accepted ? [] : [invitation] }))
    await page.route(/\/account\/api\/projects\/9\/(?:invitations|invitable-users)$/, async (route) => {
      protectedReads += 1
      await route.fulfill({ status: 403, json: { error: 'forbidden' } })
    })
    await page.route(/\/account\/api\/invitations\/incoming-other-project\/accept$/, async (route) => {
      accepted = true
      await route.fulfill({ status: 204, body: '' })
    })
    page.on('request', (request) => { if (new URL(request.url()).pathname === '/account/api/scope') scopeChanges += 1 })
    await openSeededSession(page, scaffold)
    const originalUrl = page.url()
    await page.getByRole('button', { name: 'Switch personal or project scope' }).click()
    await page.getByRole('button', { name: /Invitations/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Project members and invitations' })
    await dialog.getByText('Compute release room', { exact: true }).waitFor()
    expect(protectedReads).toBe(0)
    expect(await dialog.getByRole('alert').count()).toBe(0)
    await compareOrRefreshGolden(INCOMING_INVITATION_EXPECTED,
      await captureStableAria(page, '[role="dialog"]:not([aria-hidden="true"])', scaffold.workspaceCwd), MODE)
    await dialog.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect.poll(() => accepted).toBe(true)
    await dialog.getByText('No pending invitations', { exact: true }).waitFor()
    expect(page.url()).toBe(originalUrl)
    expect(scopeChanges).toBe(0)
    expect(protectedReads).toBe(0)
  })

  it('keeps unsent shared-session drafts private to the verified account across reloads', async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    let accountId = 7
    const phases: string[] = []
    const capture = async (label: string): Promise<void> => {
      phases.push(`${label}: ${JSON.stringify(await page!.locator('textarea').inputValue())}`)
    }
    await mockGateway(page, 'rw', { accountId: () => accountId })
    const open = async (): Promise<void> => {
      const warnings = tripwire!.warnings.length
      await openSeededSession(page!, scaffold)
      acknowledgeReloadConnectionLoss(tripwire!, warnings)
      await expect.poll(() => page!.locator('textarea').isEditable()).toBe(true)
    }
    await open()
    await page.locator('textarea').fill('Private release note from Lin')
    await expect.poll(() => page!.evaluate(() => Object.values(localStorage).some(value => String(value).includes('Private release note from Lin')))).toBe(true)
    await capture('Lin saves a private draft')

    accountId = 8
    await open()
    expect(await page.locator('textarea').inputValue()).toBe('')
    await capture('Zhou opens the same shared Session')
    await page.locator('textarea').fill('Private release note from Zhou')
    await expect.poll(() => page!.evaluate(() => Object.values(localStorage).some(value => String(value).includes('Private release note from Zhou')))).toBe(true)

    accountId = 7
    await open()
    expect(await page.locator('textarea').inputValue()).toBe('Private release note from Lin')
    await capture('Lin returns to the shared Session')
    accountId = 8
    await open()
    expect(await page.locator('textarea').inputValue()).toBe('Private release note from Zhou')
    await capture('Zhou returns to the shared Session')
    await compareOrRefreshGolden(PRIVATE_DRAFTS_EXPECTED, phases.join('\n'), MODE)
  })

  it('restores the composer after account ownership is verified later than the Session', async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    let blocked = false
    let release!: () => void
    const verified = new Promise<void>((resolve) => { release = resolve })
    await mockGateway(page, 'rw', { accountId: () => 7, contextReady: () => blocked ? verified : Promise.resolve() })
    try {
      await openSeededSession(page, scaffold)
      const input = page.locator('textarea:enabled').last()
      await input.fill('Private draft restored after account verification')
      await expect.poll(() => page!.evaluate(() => Object.values(localStorage)
        .some(value => String(value).includes('Private draft restored after account verification')))).toBe(true)
      blocked = true
      const warnings = tripwire.warnings.length
      await page.reload({ waitUntil: 'load' })
      await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
      await expect.poll(() => input.inputValue()).toBe('')
      release()
      await expect.poll(() => input.inputValue(), { timeout: 15_000 }).toBe('Private draft restored after account verification')
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'ownership-draft.expected.md'),
        await captureStableAria(page, '[data-composer-card] textarea', scaffold.workspaceCwd), MODE)
      acknowledgeReloadConnectionLoss(tripwire, warnings)
    } finally {
      release()
    }
  })

  it('shows project scope, staged visibility, participants, and creator sharing controls', async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    const gateway = await mockGateway(page, 'rw')
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-collaboration-sharing'))
    await openSeededSession(page, scaffold)

    const scope = page.getByRole('button', { name: 'Switch personal or project scope' })
    await scope.waitFor({ timeout: 10_000 })
    expect(await scope.textContent()).toContain('Payments migration')
    await scope.click()
    const scopePage = page.getByRole('dialog', { name: 'Switch personal or project scope' })
    await scopePage.waitFor({ timeout: 10_000 })
    expect(await scopePage.getByRole('button', { name: 'Close', exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
    expect(await page.locator('[data-sidebar-browsing]').evaluate(element => (element as HTMLElement).inert)).toBe(true)
    await page.keyboard.press('Shift+Tab')
    expect(await page.evaluate(() => {
      const focused = document.activeElement
      if (!(focused instanceof HTMLElement)) return false
      const box = focused.getBoundingClientRect()
      const visible = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return visible !== null && (focused.contains(visible) || visible.contains(focused))
    })).toBe(true)
    await page.keyboard.press('Tab')
    // The grant text moved off the trigger into the page hero; the page stays
    // bounded to the browsing region rather than floating over it.
    expect(await scopePage.getByRole('tab', { name: 'Switch space' }).count()).toBe(1)
    const pageBox = await scopePage.boundingBox()
    const viewport = page.viewportSize()
    if (pageBox === null || viewport === null) throw new Error('scope page geometry is unavailable')
    expect(pageBox.width).toBeLessThanOrEqual(viewport.width / 2)
    await page.getByText('New conversation visibility', { exact: true }).waitFor()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect.poll(() => scopePage.page().evaluate(() => document.documentElement.style.colorScheme)).toBe(colorScheme)
      const colors = await scopePage.getByRole('searchbox', { name: 'Search spaces', exact: true }).evaluate((input) => {
        let surface: Element = input
        while (surface.parentElement !== null && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement
        return { foreground: getComputedStyle(input, '::placeholder').color, background: getComputedStyle(surface).backgroundColor }
      })
      const luminance = (color: string): number => {
        const channels = color.match(/[0-9.]+/gu)?.slice(0, 3).map(Number)
        if (channels === undefined || channels.length !== 3) throw new Error(`Expected computed RGB color: ${color}`)
        const linear = channels.map(channel => channel / 255)
          .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
        return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
      }
      const levels = [luminance(colors.foreground), luminance(colors.background)].sort((left, right) => left - right)
      expect((levels[1]! + 0.05) / (levels[0]! + 0.05)).toBeGreaterThanOrEqual(4.5)
    }
    await page.emulateMedia({ colorScheme: 'light' })
    const scopeSnapshot = await captureStableAria(page, '[class*="scopePage"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(SCOPE_PICKER_EXPECTED, scopeSnapshot, MODE)
    await stagePrivateVisibility(page)

    const sharing = page.getByRole('button', { name: 'Manage conversation sharing' })
    await expect.poll(() => sharing.isEnabled(), { timeout: 10_000 }).toBe(true)
    await sharing.click()
    await page.getByText('Created by Lin', { exact: true }).waitFor()
    expect(await page.getByText('Participants (2)', { exact: true }).count()).toBe(1)
    expect(await page.getByText('3 contributions', { exact: true }).count()).toBe(1)
    expect(await page.getByText('1 contributions', { exact: true }).count()).toBe(1)
    const snapshot = await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(SHARING_EXPECTED, snapshot, MODE)

    await page.getByRole('menuitem', { name: /Only me/ }).click()
    await expect.poll(() => gateway.visibilityBodies, { timeout: 10_000 })
      .toEqual(['{"visibility":"private"}'])
    await expect.poll(() => sharing.textContent(), { timeout: 10_000 }).toContain('Only me')
  }, 60_000)

  it('keeps sharing reads and visibility changes on the exact project Runtime', async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    const gateway = await mockGateway(page, 'rw', { runtimeDirectory: true })
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-collaboration-runtime-sharing'))
    await openSeededSession(page, scaffold, NAV_RUNTIME_PROJECT)
    const sharing = page.getByRole('button', { name: 'Manage conversation sharing' })
    await expect.poll(() => sharing.isEnabled(), { timeout: 15_000 }).toBe(true)
    await sharing.click()
    await page.getByText('Created by Lin', { exact: true }).waitFor()
    const snapshot = await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(SHARING_EXPECTED, snapshot, MODE)
    await page.getByRole('menuitem', { name: /Only me/ }).click()
    await expect.poll(() => gateway.visibilityBodies).toEqual(['{"visibility":"private"}'])
    expect(gateway.conversationUrls.length).toBeGreaterThanOrEqual(2)
    for (const request of gateway.conversationUrls) {
      const url = new URL(request)
      expect(url.searchParams.get('dshRuntime')).toBe(NAV_RUNTIME_PROJECT)
      expect(url.searchParams.get('dshTarget')).toBe('project:9')
      expect(url.searchParams.get('projectId')).toBe('9')
    }
  })

  it('shows the target and live startup status while a scope switch waits', async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    let releaseScope!: () => void
    const scopeReady = new Promise<void>((resolve) => { releaseScope = resolve })
    await mockGateway(page, 'rw', { scopeReady })
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-collaboration-switching'))
    try {
      await openSeededSession(page, scaffold)

      const scope = page.getByRole('button', { name: 'Switch personal or project scope' })
      await scope.waitFor({ timeout: 10_000 })
      await scope.click()
      const scopePage = page.getByRole('dialog', { name: 'Switch personal or project scope' })
      await scopePage.waitFor({ timeout: 10_000 })
      await scopePage.getByRole('button', { name: /Audit platform/ }).click()

      const dialog = page.getByRole('dialog', { name: 'Switching scope' })
      await dialog.waitFor({ timeout: 10_000 })
      expect(await dialog.textContent()).toContain("Opening 'Audit platform'")
      await page.getByText('The target scope is still being prepared. Please keep waiting.', { exact: true })
        .waitFor({ timeout: 10_000 })
      await page.keyboard.press('Escape')
      expect(await dialog.isVisible()).toBe(true)

      const snapshot = await captureStableAria(page, '[role="dialog"][aria-label="Switching scope"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(SWITCHING_EXPECTED, snapshot, MODE)
    } finally {
      releaseScope()
    }
  }, 60_000)

  it('pushes the scope picker over the phone drawer', async () => {
    page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      locale: 'en-US',
      hasTouch: true,
      isMobile: true,
    })
    tripwire = watchConsole(page)
    await mockGateway(page, 'rw', { extraProjects: 4 })
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-collaboration-scope-mobile'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    await page.getByRole('button', { name: 'Open sidebar' }).click()
    const scope = page.getByRole('button', { name: 'Switch personal or project scope' })
    await scope.waitFor({ timeout: 10_000 })
    await scope.click()
    const scopePage = page.getByRole('dialog', { name: 'Switch personal or project scope' })
    await scopePage.waitFor({ timeout: 10_000 })
    // Below 768px the drawer itself is the surface: the page covers it edge
    // to edge and its own scroll region carries the roster.
    expect(await scopePage.evaluate(element => getComputedStyle(element).position)).toBe('absolute')
    expect(await scopePage.locator('[class*="pageScroll"]').evaluate(element => getComputedStyle(element).overflowY)).toBe('auto')
    const search = scopePage.locator('input[type="search"]')
    expect(await search.count()).toBe(1)
    expect(await search.evaluate(element => getComputedStyle(element.parentElement!).minHeight)).toBe('44px')
    const snapshot = await captureStableAria(page, '[class*="scopePage"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(SCOPE_PICKER_MOBILE_EXPECTED, snapshot, MODE)
    await search.fill('pay')
    expect(await scopePage.getByRole('button', { name: 'Clear space search' }).evaluate(element => getComputedStyle(element).width)).toBe('44px')
    expect(await scopePage.getByRole('button', { name: /Audit platform/ }).count()).toBe(0)
    expect(await scopePage.getByRole('button', { name: /Payments migration/ }).count()).toBe(1)
  }, 60_000)

  it.each([390, 1280])('keeps project configuration and invitation operations intact at %ipx', async (width) => {
    const phone = width < 768
    page = await browser.newPage({ viewport: { width, height: 844 }, locale: 'en-US', hasTouch: phone, isMobile: phone })
    tripwire = watchConsole(page)
    await mockGateway(page, 'rw')
    const context = collaborationContext('rw')
    await page.route(/\/account\/api\/context(?:\?.*)?$/, route => route.fulfill({ json: {
      ...context, projects: context.projects.map(project => ({ ...project, origin: 'admin', owner: null, canManage: true })),
    } }))
    let themePolicy = 'follow-user'
    const themeBodies: string[] = []
    const invitationBodies: string[] = []
    let accepted = false
    let sent = false
    const incoming = {
      id: 'incoming', projectId: 9, projectName: 'Payments migration',
      invitee: { id: 7, username: 'lin', displayName: 'Lin' }, inviter: { id: 8, username: 'zhou', displayName: 'Zhou' },
      mode: 'rw', status: 'pending', createdAt: '2026-10-01T00:00:00Z', expiresAt: null, respondedAt: null,
    }
    const outgoing = { ...incoming, id: 'outgoing', inviter: incoming.invitee, invitee: { id: 11, username: 'kai', displayName: 'Kai' }, mode: 'ro' }
    await page.route(/\/account\/api\/projects\/9\/configuration$/, async (route) => {
      if (route.request().method() === 'PATCH') {
        themeBodies.push(route.request().postData() ?? '')
        themePolicy = 'light'
      }
      await route.fulfill({ json: { project: { id: 9, name: 'Payments migration', origin: 'admin', owner: null, themePolicy }, canManage: true,
        capabilities: { themePolicy: true, runtimeSettings: true, projectModels: true,
          members: true, sshTargets: true, filesystem: false } } })
    })
    await page.route(/\/account\/api\/projects\/9\/ssh-targets$/, route => route.fulfill({ json: [] }))
    await page.route(/\/account\/api\/users$/, route => route.fulfill({ json: [incoming.invitee, outgoing.invitee] }))
    await page.route(/\/account\/api\/invitations\/count$/, route => route.fulfill({ json: { pending: accepted ? 0 : 1 } }))
    await page.route(/\/account\/api\/(?:projects\/9\/)?invitations$/, async (route) => {
      if (route.request().method() === 'POST') {
        invitationBodies.push(route.request().postData() ?? '')
        sent = true
        await route.fulfill({ json: outgoing })
      } else await route.fulfill({ json: [{ ...incoming, status: accepted ? 'accepted' : 'pending' }, ...sent ? [outgoing] : []] })
    })
    await page.route(/\/account\/api\/invitations\/incoming\/accept$/, async (route) => {
      accepted = true
      await route.fulfill({ status: 204 })
    })
    onTestFailed(() => saveFailureShot(page!, `web-e2e-space-center-${String(width)}`))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    if (phone) await page.getByRole('button', { name: 'Open sidebar' }).click()
    await page.getByRole('button', { name: 'Switch personal or project scope' }).click()
    const scopePage = page.getByRole('dialog', { name: 'Switch personal or project scope' })
    await scopePage.getByRole('button', { name: 'Project settings', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: 'Project settings', exact: true })
    await dialog.getByText('Can manage project settings', { exact: true }).waitFor()
    const settingsSnapshot = await captureStableAria(page, '[role="dialog"][aria-label="Project settings"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, phone ? 'configuration-phone.expected.md' : 'configuration.expected.md'), settingsSnapshot, MODE)
    const bounds = await dialog.boundingBox()
    expect(bounds?.width).toBeLessThanOrEqual(width)
    if (phone) expect(bounds?.height).toBeCloseTo(844, 0)
    await dialog.getByRole('button', { name: phone ? /Appearance.*default follows/ : 'Appearance', exact: !phone }).click()
    dialog = page.getByRole('dialog', { name: phone ? 'Appearance' : 'Project settings', exact: true })
    await dialog.getByRole('radio', { name: /Force light/ }).click()
    await expect.poll(() => themeBodies).toEqual(['{"themePolicy":"light"}'])
    await expect.poll(() => dialog.getByRole('radio', { name: /Force light/ }).isChecked()).toBe(true)
    if (phone) {
      await dialog.getByRole('button', { name: 'Back to project overview' }).click()
      dialog = page.getByRole('dialog', { name: 'Project settings', exact: true })
      await expect.poll(() => dialog.getByRole('button', { name: /Appearance.*default follows/ }).evaluate(element => element === document.activeElement)).toBe(true)
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await scopePage.getByRole('tab', { name: 'Manage spaces' }).click()
    await scopePage.getByRole('button', { name: /Invitation center/ }).click()
    dialog = page.getByRole('dialog', { name: 'Invitation center' })
    await dialog.getByRole('button', { name: 'Accept', exact: true }).waitFor()
    const invitationSnapshot = await captureStableAria(page, '[role="dialog"][aria-label="Invitation center"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, phone ? 'invitations-phone.expected.md' : 'invitations.expected.md'), invitationSnapshot, MODE)
    await dialog.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect.poll(() => accepted).toBe(true)
    await expect.poll(() => dialog.getByRole('button', { name: 'Accept', exact: true }).count()).toBe(0)
    await dialog.getByRole('button', { name: 'Invite a member', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Invite a member' })
    const memberPicker = dialog.getByRole('button', { name: /Select member/ })
    await expect.poll(() => memberPicker.isEnabled()).toBe(true)
    if (phone) await memberPicker.click()
    else {
      await memberPicker.focus()
      await page.keyboard.press('Enter')
      const search = page.getByRole('searchbox', { name: 'Search member name or username' })
      await expect.poll(() => search.evaluate(element => element === document.activeElement)).toBe(true)
      await search.fill('Kai')
    }
    await page.getByRole('menuitem', { name: /Kai/ }).click()
    await dialog.getByRole('radio', { name: /Read only/ }).click()
    await dialog.getByRole('button', { name: 'Send invitation', exact: true }).click()
    await expect.poll(() => invitationBodies).toEqual(['{"username":"kai","mode":"ro"}'])
    dialog = page.getByRole('dialog', { name: 'Invitation center' })
    await dialog.getByText('Kai', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await scopePage.getByRole('button', { name: 'New project space', exact: true }).click()
    const createDialog = page.getByRole('dialog', { name: 'New project space', exact: true })
    const projectName = createDialog.getByRole('textbox', { name: 'Project name', exact: true })
    await projectName.waitFor()
    if (phone) {
      const fieldHeight = await projectName.evaluate(element => element.parentElement?.getBoundingClientRect().height ?? 0)
      expect(fieldHeight).toBeGreaterThanOrEqual(44)
    }
    await createDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  }, 90_000)

  it('keeps project, preset, subagent, and utility actions on one desktop header row', async () => {
    page = await browser.newPage({ viewport: { width: 1024, height: 800 }, locale: 'en-US' })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    tripwire = watchConsole(page)
    await mockGateway(page, 'rw')
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-collaboration-header'))
    await openSeededSession(page, scaffold)

    const titleRow = page.locator('[class*="titleRow"]').first()
    const title = page.getByRole('button', { name: 'Use the read tool twice', exact: true })
    const sharing = page.getByRole('button', { name: 'Manage conversation sharing' })
    const preset = page.getByText('PTC mode', { exact: true })
    const subagents = page.getByRole('button', { name: '6 subagents' })
    const utility = page.getByRole('button', { name: 'Open right sidebar' })
    await Promise.all([
      titleRow.waitFor(), title.waitFor(), sharing.waitFor(), preset.waitFor(), subagents.waitFor(), utility.waitFor(),
    ])
    await titleRow.evaluate(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => { resolve() }))
    })

    const [rowBox, titleBox, sharingBox, presetBox, subagentBox, utilityBox] = await Promise.all([
      titleRow.boundingBox(), title.boundingBox(), sharing.boundingBox(), preset.boundingBox(),
      subagents.boundingBox(), utility.boundingBox(),
    ])
    if (
      rowBox === null || titleBox === null || sharingBox === null || presetBox === null
      || subagentBox === null || utilityBox === null
    ) throw new Error('session header action geometry is unavailable')

    const tolerance = 1
    const metrics = {
      singleLine: rowBox.height <= 32 + tolerance,
      titleBeforeSubagents: titleBox.x + titleBox.width <= subagentBox.x + tolerance,
      subagentsBeforeSharing: subagentBox.x + subagentBox.width <= sharingBox.x + tolerance,
      presetBeforeSharing: presetBox.x + presetBox.width <= sharingBox.x + tolerance,
      presetBeforeUtility: presetBox.x + presetBox.width <= utilityBox.x + tolerance,
      participantsMenuOnly: await page.getByText('Participants (2)', { exact: true }).count() === 0,
      subagentsNoWrap: await subagents.evaluate(element => getComputedStyle(element).whiteSpace === 'nowrap'),
    }
    expect(metrics).toEqual({
      singleLine: true,
      titleBeforeSubagents: true,
      subagentsBeforeSharing: true,
      presetBeforeSharing: true,
      presetBeforeUtility: true,
      participantsMenuOnly: true,
      subagentsNoWrap: true,
    })
    await compareOrRefreshGolden(HEADER_GEOMETRY_EXPECTED, renderHeaderGeometry(metrics), MODE)
  }, 60_000)

  it('mints a fresh Session for every bare New Session without probing project blanks', async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    const gateway = await mockGateway(page, 'rw')
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-collaboration-private-create'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const scope = page.getByRole('button', { name: 'Switch personal or project scope' })
    await scope.waitFor({ timeout: 10_000 })
    await scope.click()
    await stagePrivateVisibility(page)

    const before = new Set(scaffold.ctx.agents.list().map(agent => String(agent.session.id)))
    const newSession = page.getByRole('button', { name: 'New session' }).last()
    await newSession.click()
    let privateSessionId = ''
    await expect.poll(() => {
      const created = scaffold.ctx.agents.list()
        .map(agent => String(agent.session.id))
        .filter(sessionId => !before.has(sessionId))
      privateSessionId = created[0] ?? ''
      return created.length
    }, { timeout: 10_000 }).toBe(1)
    expect(privateSessionId).not.toBe(BLANK_SESSION_ID)
    // A bare create never probes the visible project blank's conversation
    // detail: reuse is intentionally skipped, so no discovery read is issued.
    expect(gateway.conversationReads).not.toContain(BLANK_SESSION_ID)
    expect(scaffold.ctx.agents.get(SessionId(privateSessionId))).toBeDefined()

    const agentCount = scaffold.ctx.agents.list().length
    // A bare click that lands before the first create's navigation commits
    // joins the in-flight create instead of minting a second Session+Agent;
    // the persisted current-session marker flips at sessions.open(), strictly
    // after that join window closes, so it is the settle signal for re-arming
    // the button.
    await expect.poll(() => page!.evaluate(() => localStorage.getItem('dsh.sessions.current')))
      .toContain(privateSessionId)
    await newSession.click()
    await expect.poll(() => scaffold.ctx.agents.list().length, { timeout: 30_000 }).toBe(agentCount + 1)
    expect(scaffold.ctx.agents.list()).toHaveLength(agentCount + 1)
    expect(gateway.conversationReads).not.toContain(BLANK_SESSION_ID)
    expect(scaffold.ctx.agents.get(SessionId(privateSessionId))).toBeDefined()
  }, 60_000)

  it('replaces the complete composer for read-only project members', async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await mockGateway(page, 'ro')
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-collaboration-read-only'))
    await openSeededSession(page, scaffold)

    const scope = page.getByRole('button', { name: 'Switch personal or project scope' })
    await scope.waitFor({ timeout: 10_000 })
    expect(await scope.textContent()).toContain('Read only')
    await scope.click()
    const scopePage = page.getByRole('dialog', { name: 'Switch personal or project scope' })
    await scopePage.waitFor({ timeout: 10_000 })
    expect(await scopePage.getByText('New conversation visibility', { exact: true }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await scopePage.waitFor({ state: 'hidden' })

    const readOnly = page.getByRole('status').filter({ hasText: 'Read-only project' })
    await readOnly.waitFor({ timeout: 10_000 })
    expect(await readOnly.textContent()).toContain('Your project role does not allow changes to this conversation.')
    expect(await page.locator('textarea:enabled:visible').count()).toBe(0)
    // The only other live status is the seeded turn's process announcement.
    expect(await page.getByRole('status').count()).toBe(2)
    const snapshot = await captureStableAria(page, '[role="status"]:has-text("Read-only project")', scaffold.workspaceCwd)
    await compareOrRefreshGolden(READ_ONLY_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'configuration-phone.expected.md', 'configuration.expected.md', 'header-geometry.expected.md', 'incoming-invitation.expected.md', 'invitations-phone.expected.md', 'invitations.expected.md', 'ownership-draft.expected.md', 'read-only.expected.md', 'scope-picker-mobile.expected.md', 'scope-picker.expected.md', 'sharing.expected.md', 'switching.expected.md',
    ])
    await assertFixtureInventory(PRIVATE_DRAFTS_DIR, ['private-drafts.expected.md'])
  })
})


it.skipIf(MODE === 'record')('keeps space navigation, tab drafts and a running turn independent', async () => {
  const replay = fileURLToPath(new URL('./snapshots/live-interactions/session.jsonl', import.meta.url))
  const world = await launchWebScaffold({ replayFixture: replay, paceMs: 5, openInApp: false })
  const acquired: { browser?: Browser; context?: BrowserContext; settled?: Promise<SessionId> } = {}
  let releaseStep: (() => void) | undefined
  let stopGate: (() => void) | undefined
  onTestFinished(async () => {
    releaseStep?.()
    stopGate?.()
    const failures: unknown[] = []
    if (acquired.settled !== undefined) await acquired.settled.catch((error: unknown) => { failures.push(error) })
    await acquired.context?.close().catch((error: unknown) => { failures.push(error) })
    await acquired.browser?.close().catch((error: unknown) => { failures.push(error) })
    await world.close().catch((error: unknown) => { failures.push(error) })
    if (failures.length > 0) throw new AggregateError(failures, 'space navigation cleanup failed')
  })
  await seedSession(world, await readFile(SEED, 'utf8'), SESSION_ID)
  const browser = await chromium.launch(); acquired.browser = browser
  const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', colorScheme: 'dark' })
  acquired.context = context
  // Directory aliases exercise browser navigation over one real Host. The
  // separate runtime-identity scenarios own cross-process data isolation.
  await mockGateway(context, 'rw', { runtimeDirectory: true, accountId: () => 7 })
  const page = await context.newPage()
  const tripwire = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-space-navigation'))
  await openSeededSession(page, world, NAV_RUNTIME_A)
  const composer = () => page.locator('textarea:enabled').last()
  await composer().fill('First tab draft')
  const other = await context.newPage()
  const otherTripwire = watchConsole(other)
  await openSeededSession(other, world, NAV_RUNTIME_A)
  await other.locator('textarea:enabled').last().fill('Second tab draft')
  const reloadWarningStart = tripwire.warnings.length
  await page.reload({ waitUntil: 'networkidle' })
  acknowledgeReloadConnectionLoss(tripwire, reloadWarningStart)
  await expect.poll(() => composer().inputValue()).toBe('First tab draft')
  expect(await other.locator('textarea:enabled').last().inputValue()).toBe('Second tab draft')

  const openSpaces = async () => {
    await page.getByRole('button', { name: 'Switch personal or project scope', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Switch personal or project scope', exact: true })
    await picker.getByRole('button', { name: /Payments migration/ }).waitFor()
    return picker
  }
  const switchTo = async (name: RegExp, id: string) => {
    const picker = await openSpaces()
    const warningStart = tripwire.warnings.length
    await picker.getByRole('button', { name }).click()
    await page.waitForURL(`**/?dshRuntime=${id}`)
    await page.waitForLoadState('networkidle')
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
  }
  let picker = await openSpaces()
  await compareOrRefreshGolden(join(NAV_SNAPSHOT_DIR, 'directory.expected.md'),
    await captureStableAria(page, '[role="dialog"][aria-label="Switch personal or project scope"]', world.workspaceCwd), MODE)
  await picker.getByRole('button', { name: 'Favorite this space', exact: true }).click()
  await picker.getByRole('button', { name: 'Remove favorite', exact: true }).waitFor()
  expect(await picker.getByText('Favorites', { exact: true }).isVisible()).toBe(true)
  expect(await picker.getByRole('button', { name: /Personal/ }).count()).toBe(1)
  const firstSwitchWarnings = tripwire.warnings.length
  await picker.getByRole('button', { name: /Payments migration/ }).click()
  await page.waitForURL(`**/?dshRuntime=${NAV_RUNTIME_PROJECT}`)
  await page.waitForLoadState('networkidle')
  acknowledgeReloadConnectionLoss(tripwire, firstSwitchWarnings)
  expect(new URL(other.url()).searchParams.get('dshRuntime')).toBe(NAV_RUNTIME_A)
  await switchTo(/Personal/, NAV_RUNTIME_A)
  await expect.poll(() => composer().inputValue()).toBe('First tab draft')
  picker = await openSpaces()
  await picker.getByRole('button', { name: 'Remove favorite', exact: true }).waitFor()
  await picker.getByRole('button', { name: 'Close', exact: true }).click()

  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9kAAAAASUVORK5CYII='
  await page.locator('input[type="file"]').setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') })
  await page.getByRole('button', { name: 'Remove image draft.png', exact: true }).waitFor()
  picker = await openSpaces()
  await picker.getByRole('button', { name: /Payments migration/ }).click()
  const offer = page.getByRole('dialog', { name: 'Keep the current draft', exact: true })
  await offer.waitFor()
  expect(new URL(page.url()).searchParams.get('dshRuntime')).toBe(NAV_RUNTIME_A)
  expect(await composer().inputValue()).toBe('First tab draft')
  await compareOrRefreshGolden(join(NAV_SNAPSHOT_DIR, 'draft-guard.expected.md'),
    await captureStableAria(page, '[role="dialog"]', world.workspaceCwd), MODE)
  const opened = context.waitForEvent('page')
  await offer.getByRole('button', { name: 'Open in a new tab', exact: true }).click()
  const target = await opened
  await target.waitForURL(`**/?dshRuntime=${NAV_RUNTIME_PROJECT}`)
  await page.getByRole('button', { name: 'Remove image draft.png', exact: true }).click()
  expect(await other.locator('textarea:enabled').last().inputValue()).toBe('Second tab draft')
  await target.close()

  let enteredStep!: (signal: AbortSignal) => void
  const entered = new Promise<AbortSignal>((resolve) => { enteredStep = resolve })
  const stepGate = new Promise<void>((resolve) => { releaseStep = resolve })
  let hold = true
  stopGate = world.ctx.on('agent/request', async ({ signal }, next) => {
    if (hold) { hold = false; enteredStep(signal); await stepGate }
    return next()
  })
  const settled = world.whenTurnSettled(); acquired.settled = settled
  void settled.catch(() => { /* The scenario and its cleanup observe the retained result. */ })
  await composer().fill(fixtureUserPrompts(await readFile(replay, 'utf8'))[0]!)
  await composer().press('Enter')
  const runningSignal = await entered
  await expect.poll(() => composer().inputValue()).toBe('')
  await switchTo(/Payments migration/, NAV_RUNTIME_PROJECT)
  expect(runningSignal.aborted).toBe(false)
  expect(await other.locator('textarea:enabled').last().inputValue()).toBe('Second tab draft')
  releaseStep!()
  expect(await settled).toBe(SESSION_ID)
  const completed = await world.ctx.sessionPersistence.load(SessionId(SESSION_ID))
  const lastEnd = completed?.events.filter(event => event.type === 'turn/end').at(-1)
  expect(lastEnd?.data.reason.kind).toBe('completed')
  stopGate()
  stopGate = undefined
  expect(tripwire.warnings).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
  expect(otherTripwire.warnings).toEqual([])
  expect(otherTripwire.pageErrors).toEqual([])
  await assertFixtureInventory(NAV_SNAPSHOT_DIR, ['directory.expected.md', 'draft-guard.expected.md'])
}, 120_000)
