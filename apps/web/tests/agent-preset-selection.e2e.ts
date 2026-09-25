// Web e2e scenario: agent-preset selection. The roster's `roots` is an
// assembly fact the CLI entry resolves and patches in, so every other lane
// boots with an empty roster and no preset surface at all; this is the one
// lane that mounts the SHIPPED presets and puts them in front of a browser.
//
// Two surfaces, one host rule: a session's composition is fixed when the
// session starts. Before that, the new-session chip stages the choice beside
// the workspace picker — the only screen where it still works. After it, the
// session header names what the session runs and offers no control at all,
// because the host answers `agent-preset-locked` to anything else.
//
// Zero model calls: no replay fixture mounts, so a stray stream fails loud.
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION, SessionId as sessionId, type SessionEvent, type SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/agent-preset-selection', import.meta.url))
const HERO_EXPECTED = join(SNAPSHOT_DIR, 'hero.expected.md')
const MENU_EXPECTED = join(SNAPSHOT_DIR, 'menu.expected.md')
const HEADER_EXPECTED = join(SNAPSHOT_DIR, 'header.expected.md')
/** The shipped roster, beside the composition that names it. */
const SHIPPED_PRESETS = fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'agent-preset-selection-web-e2e'
/** A project skill only a preset that mounts `skill-filesystem` can discover. */
const SKILL_NAME = 'preset-catalog-demo'

/**
 * Seed one project skill under the connected workspace.
 *
 * Local skill discovery is a PRESET row, so this file is visible through
 * `standard` and invisible through `minimal` — which makes the '/' menu's
 * skill group a statement about the session's composition.
 * @param workspaceCwd - the scaffold's temp project parent.
 */
async function seedWorkspaceSkill(workspaceCwd: string): Promise<void> {
  const directory = join(workspaceCwd, 'workspace', '.agents', 'skills', SKILL_NAME)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---',
    `name: ${SKILL_NAME}`,
    'description: Prove the slash catalog follows the session composition',
    '---',
    '',
    'Body.',
    '',
  ].join('\n'))
}

/**
 * A settled one-turn session with no model content: this lane asserts chrome
 * around a conversation, not a conversation, and a recorded turn would tie
 * the golden to a provider's wording for no gain.
 * @returns a tokenized session log ending on a closed turn.
 */
function seedLog(): string {
  const time = 1784974100000
  const at = (index: number, event: Record<string, unknown>): string =>
    JSON.stringify({ ...event, seq: index, time: time + index })
  return [
    JSON.stringify({ type: 'session', version: 0, id: '{{sessionId}}', createdAt: time, cwd: '{{cwd}}/workspace' }),
    at(0, { type: 'turn/start', data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user', rpcId: 'seed' } } } }),
    at(1, { type: 'step/start', data: { turn: 1, step: 1 } }),
    at(2, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'Seeded turn.' }], source: { kind: 'user', rpcId: 'seed' } },
      surfaceOp: 'append',
    }),
    at(3, { type: 'step/end', data: { turn: 1, step: 1 } }),
    at(4, { type: 'session/title', data: { title: 'Seeded turn', messageSeqs: [2], source: { kind: 'fallback' } } }),
    at(5, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
  ].join('\n')
}

/**
 * Persist one child so the assembled header snapshot exercises both action
 * contributors whose relative order is the product contract under test.
 * @param scaffold - the booted Web scaffold.
 * @param parentId - the seeded session whose header the browser opens.
 */
async function seedSubagent(scaffold: WebScaffold, parentId: SessionId): Promise<void> {
  const childId = sessionId('agent-preset-selection-child')
  const createdAt = 1784974100100
  await scaffold.ctx.sessionPersistence.createStored({
    version: SESSION_FORMAT_VERSION,
    id: childId,
    createdAt,
    cwd: scaffold.workspaceCwd,
    parentSession: parentId,
    isSeeded: false,
    origin: 'subagent',
    delegationDepth: 1,
    agentPreset: 'minimal',
  })
  await scaffold.ctx.sessionPersistence.append(childId, [
    {
      type: 'turn/start',
      seq: SessionSeq(0),
      time: createdAt,
      data: { turn: 1 },
    },
    {
      type: 'user/message',
      seq: SessionSeq(1),
      time: createdAt + 1,
      data: {
        id: MessageId(`legacy-message:${childId}:1`),
        role: 'user',
        content: [{ type: 'text', text: 'Check the session-header action order.' }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    },
    {
      type: 'subagent/descriptor',
      seq: SessionSeq(2),
      time: createdAt + 2,
      data: snapshotSubagentDescriptor({
        mode: 'one-shot', provider: 'spawn', label: 'header order probe',
      }),
    },
    {
      type: 'turn/end',
      seq: SessionSeq(3),
      time: createdAt + 3,
      data: { turn: 1, reason: { kind: 'completed' } },
    },
  ] as SessionEvent[])
  const childLog = await scaffold.ctx.sessionPersistence.load(childId)
  scaffold.ctx.sessionProjectionCache.coldSnapshot(childLog.meta, childLog.inheritedEventCount, childLog.events)
}

/**
 * The preset the host reports for the blank session the workspace connect
 * produced. Blank draft sessions are intentionally omitted from
 * `session.list`, so inspect the in-process Host registry and select the
 * root agent attached to the connected workspace.
 * @param scaffold - the booted Web scaffold.
 * @returns the live session's preset, or undefined before it is listed.
 */
function livePreset(scaffold: WebScaffold): string | undefined {
  const workspacePath = join(scaffold.workspaceCwd, 'workspace')
  const agent = scaffold.ctx.agents.list().find(candidate => candidate.session.id !== sessionId(SEED_ID)
    && candidate.session.header.parentSession === undefined
    && candidate.session.header.cwd === workspacePath)
  return agent === undefined ? undefined : resolveSessionPreset(agent.session)
}

/** Every option label the trigger menu currently lists. */
async function menuOptions(page: Page): Promise<string[]> {
  const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
  await menu.waitFor({ timeout: 10_000 })
  return await menu.getByRole('option').allTextContents()
}

describe('web e2e: agent-preset selection', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      agentPresets: { roots: [{ path: SHIPPED_PRESETS, trust: 'system' }], default: 'standard' },
    })
    // A resumed session runs what it was created with; seeding one that
    // records `minimal` is what makes the header label a claim about the
    // session rather than an echo of the current default.
    const seededId = await seedSession(scaffold, seedLog(), SEED_ID, 'minimal')
    await seedSubagent(scaffold, seededId)
    await seedWorkspaceSkill(scaffold.workspaceCwd)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('offers the chip on the new-session screen, beside the workspace picker', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-preset-hero'))
    await connectFreshWorkspace(page, scaffold.workspaceCwd)

    const snapshot = await captureStableAria(page, '[class*="heroWorkspaceRow"]', scaffold.workspaceCwd)

    await compareOrRefreshGolden(HERO_EXPECTED, snapshot, MODE)
    // The chip opens on the deployment default, by the name that preset
    // publishes rather than its directory name.
    expect(snapshot).toContain('Standard mode')
  })

  it('names every preset and what it is for', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-preset-menu'))
    await page.getByRole('button', { name: 'Standard mode' }).click()
    const menu = page.getByRole('menu')
    await menu.waitFor({ timeout: 10_000 })

    const snapshot = await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)

    await compareOrRefreshGolden(MENU_EXPECTED, snapshot, MODE)
    // Every shipped preset, each with the sentence saying what it composes —
    // the id alone never said what a preset does.
    expect(snapshot).toContain('Minimal mode')
    expect(snapshot).toContain('Creator mode')
    await page.keyboard.press('Escape')
  })

  it('applies the staged pick to the blank session, and the host honors it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-preset-stage'))
    await page.getByRole('button', { name: 'Standard mode' }).click()
    await page.getByRole('menuitem', { name: /Minimal mode/ }).click()

    // The chip stages; the blank session the workspace connect produced is
    // what the stage lands on. The host's own answer is what comes back.
    await expect.poll(() => livePreset(scaffold), { timeout: 15_000 }).toBe('minimal')
  })

  it('re-reads the slash catalog through the composition the switch installed', async () => {
    // Continues the previous case: the chip has already applied `minimal` to
    // the blank session, and this one reads the menu that switch left behind.
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-preset-slash-catalog'))
    const composer = page.locator('textarea:enabled').last()

    // `minimal` mounts neither the compaction group nor plan mode nor local
    // skill discovery, so the catalog the composer warmed under the
    // deployment default must not survive the switch.
    await composer.fill('/')
    await expect.poll(() => menuOptions(page), { timeout: 15_000 })
      .not.toEqual(expect.arrayContaining([expect.stringContaining(SKILL_NAME)]))
    const onMinimal = await menuOptions(page).then(options => options.map(option => option.toLowerCase()))
    expect(onMinimal.some(option => option.startsWith('compact'))).toBe(false)
    expect(onMinimal.some(option => option.startsWith('plan'))).toBe(false)
    // The host-plane commands and the client's own contribution are the
    // floor: they belong to no preset and never move.
    expect(onMinimal.some(option => option.startsWith('goal'))).toBe(true)
    expect(onMinimal.some(option => option.startsWith('model'))).toBe(true)
    await composer.fill('')

    // Switching back up reaches the host at all — the chip compares the pick
    // against its list row, so a row that never reprojected the first switch
    // answers "already standard" and sends nothing — and restores the catalog
    // instead of leaving the session reading the narrower composition.
    await page.getByRole('button', { name: 'Minimal mode' }).click()
    await page.getByRole('menuitem', { name: /^Standard mode/ }).first().click()
    await expect.poll(() => livePreset(scaffold), { timeout: 15_000 }).toBe('standard')

    await composer.fill('/')
    await expect.poll(() => menuOptions(page), { timeout: 15_000 })
      .toEqual(expect.arrayContaining([expect.stringContaining(SKILL_NAME)]))
    const onStandard = await menuOptions(page).then(options => options.map(option => option.toLowerCase()))
    expect(onStandard.some(option => option.startsWith('compact'))).toBe(true)
    expect(onStandard.some(option => option.startsWith('plan'))).toBe(true)
    await composer.fill('')
  }, 90_000)

  it('hides the picker: the pending session falls back to the deployment default until selection returns', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-preset-picker-off'))
    const openSection = async (): Promise<Locator> => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Settings' })
      await dialog.waitFor({ timeout: 10_000 })
      await dialog.getByRole('button', { name: 'Agent presets' }).click()
      return dialog
    }
    const closeSettings = async (dialog: Locator): Promise<void> => {
      await dialog.getByRole('button', { name: 'Close' }).last().click()
      await dialog.waitFor({ state: 'detached', timeout: 10_000 })
    }

    // A saved default different from the deployment default makes the policy
    // observable: hidden means the deployment default, not the saved one.
    let dialog = await openSection()
    await dialog.getByRole('button', { name: 'Set as default: Minimal mode' }).click()
    await dialog.getByRole('button', { name: 'In use: Minimal mode' }).waitFor({ timeout: 10_000 })
    await closeSettings(dialog)
    await page.getByRole('button', { name: 'Minimal mode', exact: true }).waitFor({ timeout: 10_000 })
    await expect.poll(() => livePreset(scaffold), { timeout: 15_000 }).toBe('minimal')

    // Off: the chip leaves the new-session screen and the pending session
    // returns to the deployment default — the saved `minimal` is ignored, not
    // lost.
    dialog = await openSection()
    await dialog.getByRole('switch', { name: 'Allow switching Agent modes' }).click()
    await dialog.getByRole('button', { name: 'Default: Standard mode' }).waitFor({ timeout: 10_000 })
    await closeSettings(dialog)
    await expect.poll(
      () => page.getByRole('button', { name: 'Minimal mode', exact: true }).count(),
      { timeout: 10_000 },
    ).toBe(0)
    await expect.poll(() => livePreset(scaffold), { timeout: 15_000 }).toBe('standard')

    // On again: the saved default is still there, so the chip and the pending
    // session return to `minimal` rather than the deployment default.
    dialog = await openSection()
    await dialog.getByRole('switch', { name: 'Allow switching Agent modes' }).click()
    await dialog.getByRole('button', { name: 'In use: Minimal mode' }).waitFor({ timeout: 10_000 })
    await closeSettings(dialog)
    await page.getByRole('button', { name: 'Minimal mode', exact: true }).waitFor({ timeout: 10_000 })
    await expect.poll(() => livePreset(scaffold), { timeout: 15_000 }).toBe('minimal')

    // Leave the lane the way the later cases expect it: the saved default
    // restored to the deployment default and the pending session back on it.
    dialog = await openSection()
    await dialog.getByRole('button', { name: 'Set as default: Standard mode' }).click()
    await dialog.getByRole('button', { name: 'In use: Standard mode' }).waitFor({ timeout: 10_000 })
    await closeSettings(dialog)
    await expect.poll(() => livePreset(scaffold), { timeout: 15_000 }).toBe('standard')
  }, 90_000)

  it('labels a resumed session with the preset it was created under', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-preset-header'))
    // The seeded session's cwd is the scaffold root rather than the connected
    // workspace, so it lists under Ungrouped; the group collapses by default.
    await page.getByRole('treeitem', { name: /^Independent sessions/ }).click()
    await page.locator('[role="treeitem"]').last().click()
    await page.getByText('Seeded turn.').waitFor({ timeout: 15_000 })
    await expect.poll(
      () => page.getByRole('button', { name: 'Seeded turn', exact: true }).count(),
      { timeout: 15_000 },
    ).toBe(1)

    const snapshot = await captureStableAria(page, '[class*="titleRow"]', scaffold.workspaceCwd)

    await compareOrRefreshGolden(HEADER_EXPECTED, snapshot, MODE)
    expect(snapshot).toContain('Minimal mode')
    expect(snapshot).toContain('button "1 subagent"')
    expect(snapshot.indexOf('button "1 subagent"')).toBeLessThan(snapshot.indexOf('Minimal mode'))
    expect(snapshot.indexOf('Minimal mode')).toBeLessThan(snapshot.indexOf('button "Session log"'))
    // Static chrome, not a control: the header can only report a composition
    // the host would refuse to change.
    expect(snapshot).not.toContain('button "Minimal mode"')
  })

  it('drove every surface without a page error or a stream warning', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
