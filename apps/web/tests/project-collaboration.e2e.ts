/** Project collaboration controls through the shipped Web composition. */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedBlankSession, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/project-collaboration', import.meta.url))
const SCOPE_PICKER_EXPECTED = join(SNAPSHOT_DIR, 'scope-picker.expected.md')
const SCOPE_PICKER_MOBILE_EXPECTED = join(SNAPSHOT_DIR, 'scope-picker-mobile.expected.md')
const SHARING_EXPECTED = join(SNAPSHOT_DIR, 'sharing.expected.md')
const SWITCHING_EXPECTED = join(SNAPSHOT_DIR, 'switching.expected.md')
const READ_ONLY_EXPECTED = join(SNAPSHOT_DIR, 'read-only.expected.md')
const HEADER_GEOMETRY_EXPECTED = join(SNAPSHOT_DIR, 'header-geometry.expected.md')
const SHIPPED_PRESETS = fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url))
const MODE = webSnapshotMode()
const SESSION_ID = 'project-collaboration-web-e2e'
const BLANK_SESSION_ID = 'project-collaboration-project-blank'
const SEEDED_PROMPT = 'Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.'

type ProjectMode = 'ro' | 'rw'

function collaborationContext(mode: ProjectMode, extraProjects = 0) {
  return {
    user: { id: 7, username: 'lin', displayName: 'Lin', role: 'member' },
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

async function mockGateway(page: Page, mode: ProjectMode, options: {
  scopeReady?: Promise<void>
  extraProjects?: number
} = {}): Promise<{
  visibilityBodies: string[]
  conversationReads: string[]
  visibilityBySession: Map<string, 'project' | 'private'>
}> {
  const visibilityBodies: string[] = []
  const conversationReads: string[] = []
  const visibilityBySession = new Map<string, 'project' | 'private'>()
  await page.route(/\/api\/host\.describe(?:\?.*)?$/, async (route) => {
    const response = await route.fetch()
    const body = await response.json() as {
      result: { ok: true; value: { runtimeTarget?: { kind: 'project'; projectId: number } } } | { ok: false }
    }
    if (body.result.ok) body.result.value.runtimeTarget = { kind: 'project', projectId: 9 }
    await route.fulfill({ response, json: body })
  })
  await page.route(/\/account\/api\/context(?:\?.*)?$/, async (route) => {
    await route.fulfill({ json: collaborationContext(mode, options.extraProjects ?? 0) })
  })
  await page.route(/\/account\/api\/scope(?:\?.*)?$/, async (route) => {
    if (options.scopeReady !== undefined) await options.scopeReady
    await route.fulfill({ status: 204, body: '' })
  })
  await page.route('**/account/api/conversations/*', async (route) => {
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
  return { visibilityBodies, conversationReads, visibilityBySession }
}

/**
 * Drive the pushed scope page: open it, stage `Only me` through the second
 * visibility level, and close it again through the trigger.
 */
async function stagePrivateVisibility(page: Page): Promise<void> {
  const scope = page.getByRole('button', { name: 'Switch personal or project scope' })
  const scopePage = page.getByRole('group', { name: 'Switch personal or project scope' })
  await scopePage.waitFor({ timeout: 10_000 })
  await scopePage.getByRole('button', { name: 'New conversation visibility' }).click()
  await scopePage.getByRole('button', { name: /Only me/ }).click()
  await scope.click()
}

async function openSeededSession(page: Page, scaffold: WebScaffold): Promise<void> {
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  await page.getByRole('textbox', { name: 'Search sessions…', exact: true }).fill(SEEDED_PROMPT)
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
    const scopePage = page.getByRole('group', { name: 'Switch personal or project scope' })
    await scopePage.waitFor({ timeout: 10_000 })
    // The grant text moved off the trigger into the page hero; the page stays
    // bounded to the browsing region rather than floating over it.
    expect(await scopePage.textContent()).toContain('Can edit')
    const pageBox = await scopePage.boundingBox()
    const viewport = page.viewportSize()
    if (pageBox === null || viewport === null) throw new Error('scope page geometry is unavailable')
    expect(pageBox.width).toBeLessThanOrEqual(viewport.width / 2)
    await page.getByText('New conversation visibility', { exact: true }).waitFor()
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
      const scopePage = page.getByRole('group', { name: 'Switch personal or project scope' })
      await scopePage.waitFor({ timeout: 10_000 })
      await scopePage.getByRole('button', { name: /Audit platform/ }).click()

      const dialog = page.getByRole('dialog', { name: 'Switching scope' })
      await dialog.waitFor({ timeout: 10_000 })
      expect(await dialog.textContent()).toContain("Opening 'Audit platform'")
      await page.getByText('The target scope is still being prepared. Please keep waiting.', { exact: true })
        .waitFor({ timeout: 10_000 })
      await page.keyboard.press('Escape')
      expect(await dialog.isVisible()).toBe(true)

      const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
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
    const scopePage = page.getByRole('group', { name: 'Switch personal or project scope' })
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
    expect(await scopePage.getByRole('button', { name: 'Clear project-space search' }).evaluate(element => getComputedStyle(element).width)).toBe('44px')
    expect(await scopePage.getByRole('button', { name: /Audit platform/ }).count()).toBe(0)
    expect(await scopePage.getByRole('button', { name: /Payments migration/ }).count()).toBe(1)
  }, 60_000)

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
    const scopePage = page.getByRole('group', { name: 'Switch personal or project scope' })
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
      'header-geometry.expected.md', 'read-only.expected.md', 'scope-picker-mobile.expected.md', 'scope-picker.expected.md', 'sharing.expected.md', 'switching.expected.md',
    ])
  })
})
