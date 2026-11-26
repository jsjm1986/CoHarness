/** Reachable Forge, worktree settings and deep Session Inspector flows in an opt-in assembly. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { installLlmReplay, type ReplayEntry, type ReplayHandle } from '@deepseek-ai/dsh-llm-replay'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-experimental-worktree'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-api-remotes/session-controller'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT, saveFailureShot } from './support.ts'
import { expectViewportFit, responsiveBrowser, responsiveBrowserName, responsiveViewports } from './responsive-browser.ts'
import { auditWorkflowState, compareWorkflowGolden, workflowMatrixEnabled } from './workflow-responsive-state.ts'

const run = promisify(execFile)

function history(): string {
  const session = Session.create(SessionId('experimental-panels-source'))
  for (let turn = 1; turn <= 100; turn++) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `Inspect local changes ${turn}.` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', { stream: [], turn, step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: `Local inspection ${turn} is complete.` }], source: { provider: 'fixture', model: 'fixture' } }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
    cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

describe('web e2e: opt-in panel interactions', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let scratch: string
  let worktreeControl: string
  let sessionId: Awaited<ReturnType<typeof seedSession>>
  beforeAll(async () => {
    await mkdir(join(REPO_ROOT, '.artifacts'), { recursive: true })
    scratch = await mkdtemp(join(REPO_ROOT, '.artifacts', 'dsh-experimental-panels-'))
    worktreeControl = join(scratch, 'worktree-control.json')
    await writeFile(worktreeControl, '{}')
    const gitGate = join(scratch, 'worktree-git.mjs')
    await writeFile(gitGate, [
      '#!/usr/bin/env node',
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs'",
      "import { spawn } from 'node:child_process'",
      "import { setTimeout } from 'node:timers/promises'",
      `const control = JSON.parse(readFileSync(${JSON.stringify(worktreeControl)}, 'utf8'))`,
      'const args = process.argv.slice(2)',
      "const phase = args.includes('worktree') && args.includes('add') ? 'prepare'",
      "  : args.includes('reset') && args.includes('--hard') ? 'checkout' : undefined",
      'if (phase !== undefined && control.phase === phase) {',
      "  writeFileSync(control.ready, 'entered')",
      '  while (!existsSync(control.release)) await setTimeout(25)',
      '}',
      "const child = spawn('git', args, { stdio: 'inherit' })",
      "process.on('SIGTERM', () => child.kill('SIGTERM'))",
      "process.on('SIGINT', () => child.kill('SIGINT'))",
      "child.on('error', error => { console.error(error.message); process.exitCode = 1 })",
      "child.on('exit', code => { process.exitCode = code ?? 1 })", '',
    ].join('\n'), { mode: 0o700 })
    const overlay = join(scratch, 'plugins.patch.yml')
    const plugins = ['forge', 'forge-session', 'worktree', 'client-ui-forge', 'session-inspector']
    await writeFile(overlay, '- insert:\n' + plugins.map(name => `    - id: panel-${name}\n      name: '@deepseek-ai/dsh-experimental-${name}'\n`
      + (name === 'worktree' ? `      config:\n        gitCommand: ${JSON.stringify(gitGate)}\n        timeoutMs: 600000\n` : '')).join(''))
    const teamBundle = join(REPO_ROOT, 'packages/experimental/agent-team-profile')
    scaffold = await launchWebScaffold({ workbench: true,
      extraInstallAnchors: [...plugins.map(name => join(REPO_ROOT, 'packages/experimental', name, 'package.json')), join(teamBundle, 'package.json')],
      extraOverlayPath: [join(teamBundle, 'cordis.patch.yml'), overlay] })
    await run('git', ['init', '-b', 'main'], { cwd: scaffold.workspaceCwd })
    await writeFile(join(scaffold.workspaceCwd, '.git/info/exclude'), '*\n!responsive-preview.txt\n')
    await writeFile(join(scaffold.workspaceCwd, 'responsive-preview.txt'), 'Initial local content.\n')
    await run('git', ['add', 'responsive-preview.txt'], { cwd: scaffold.workspaceCwd })
    await run('git', ['-c', 'user.name=Responsive fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false',
      'commit', '-m', 'Initial fixture'], { cwd: scaffold.workspaceCwd })
    await run('git', ['remote', 'add', 'origin', scaffold.workspaceCwd], { cwd: scaffold.workspaceCwd })
    await run('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: scaffold.workspaceCwd })
    await run('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { cwd: scaffold.workspaceCwd })
    await writeFile(join(scaffold.workspaceCwd, 'responsive-preview.txt'), 'Updated local content.\n' + 'Long reviewable content remains inside its scrollport. '.repeat(30) + '\n')
    sessionId = await seedSession(scaffold, history(), 'experimental-panels')
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(sessionId)
    browser = await responsiveBrowser.launch()
  }, 120_000)
  afterAll(async () => {
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally { if (scratch) await rm(scratch, { recursive: true, force: true }) }
    }
  })

  async function open(id = sessionId, historyText: string | null = 'Local inspection 100 is complete.'): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, hasTouch: true, locale: 'en-US' })
    page.setDefaultTimeout(15_000)
    await page.addInitScript((id) => { if (window === window.top) localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id })) }, id)
    try {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      if (historyText !== null) await page.getByText(historyText, { exact: true }).waitFor()
      return page
    } catch (error) { await page.close(); throw error }
  }

  async function panelReplay(name: string, scripts: readonly (readonly ReplayEntry[])[]) {
    const files: string[] = []
    const overrides: string[] = []
    for (const [index, script] of scripts.entries()) {
      const file = join(scratch, `${name}-${index}.jsonl`)
      const override = join(scratch, `${name}-${index}.override.json`)
      await writeFile(file, JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION,
        id: `${name}-${index}`, createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }) + '\n')
      await writeFile(override, JSON.stringify(script))
      files.push(file); overrides.push(override)
    }
    return installLlmReplay(scaffold.ctx, {
      file: files[0]!, overrideFile: overrides[0]!, childFiles: files.slice(1), childOverrideFiles: overrides.slice(1),
      providers: [{ id: `responsive-${name}`, name: 'Private acceptance replay',
        models: [{ id: 'acceptance', contextWindow: 128_000 }] }],
    })
  }

  async function worktreeGate(phase: 'prepare' | 'checkout', name: string) {
    const ready = join(scaffold.workspaceCwd, `.${name}-ready`)
    const release = join(scaffold.workspaceCwd, `.${name}-release`)
    await writeFile(`${worktreeControl}.next`, JSON.stringify({ phase, ready, release }))
    await rename(`${worktreeControl}.next`, worktreeControl)
    return { ready, release }
  }

  function completedText(text: string): Extract<ReplayEntry, { kind: 'chunks' }> {
    return { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'usage', usage: { inputTokens: 20, outputTokens: 8 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] }
  }

  async function screenshot(page: Page, name: string): Promise<void> {
    const directory = process.env.DSH_MOBILE_SCREENSHOTS
    if (directory === undefined) return
    await mkdir(directory, { recursive: true })
    await page.screenshot({ path: join(directory, `${name}-${responsiveBrowserName}.png`), animations: 'disabled' })
  }

  it('reads pending, owned and completed Team tasks and confirms disabling without losing the board', async () => {
    const resolved = await scaffold.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw new Error(resolved.error.message)
    const { agent } = resolved
    await scaffold.ctx.agentTeams.setEnabled(agent, true)
    const page = await open()
    const tripwire = watchConsole(page)
    try {
      await page.getByRole('button', { name: 'Agent Team', exact: true }).click()
      const panel = page.locator('[data-team-panel]')
      const captureHeader = (state: string) => async (): Promise<void> => {
        const label = await panel.locator('[data-team-mode] > span').first().boundingBox()
        expect(label?.width, 'Team mode label keeps a readable line instead of one-word wrapping').toBeGreaterThanOrEqual(180)
        const headingCounts = await panel.locator('h3 > span[class*="count"]').evaluateAll(nodes => nodes.map((badge) => {
          const heading = badge.parentElement!
          const name = document.createRange()
          name.selectNodeContents(heading)
          name.setEndBefore(badge)
          const text = name.getBoundingClientRect()
          const count = badge.getBoundingClientRect()
          const row = heading.getBoundingClientRect()
          return { gap: count.left - text.right, centerOffset: Math.abs(count.y + count.height / 2 - row.y - row.height / 2) }
        }))
        for (const count of headingCounts) {
          expect(count.gap, 'Team count stays visually separated from its heading').toBeGreaterThanOrEqual(4)
          expect(count.centerOffset, 'Team count aligns with its heading row').toBeLessThanOrEqual(1)
        }
        const actions = panel.locator('[data-team-disable-confirm] button')
        if (await actions.count() === 2) {
          const first = await actions.first().boundingBox()
          const second = await actions.last().boundingBox()
          expect(first).not.toBeNull()
          expect(second).not.toBeNull()
          expect(Math.abs(first!.y - second!.y), 'Confirmation actions share one row').toBeLessThanOrEqual(1)
        }
        const directory = process.env.DSH_FEATURE_LAYOUT_SCREENSHOTS
        const viewport = page.viewportSize()
        if (directory === undefined || viewport === null || viewport.width !== 320 && viewport.height !== 230) return
        await panel.evaluate((element) => { element.scrollTop = 0 })
        await mkdir(directory, { recursive: true })
        await page.screenshot({ path: join(directory, `${responsiveBrowserName}-team-${state}-header-${viewport.width}.png`), animations: 'disabled' })
      }
      expect(await panel.locator('article').count()).toBe(0)
      await auditWorkflowState(page, 'team', 'empty-board', panel, [], captureHeader('empty-board'))
      await panel.getByRole('switch', { name: 'Enable agent teamwork', exact: true }).click()
      await panel.getByRole('button', { name: 'Disable', exact: true }).waitFor()
      await auditWorkflowState(page, 'team', 'empty-confirmation', panel, [], captureHeader('empty-confirmation'))
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
      const active = await scaffold.ctx.agentTeams.createTask(agent, {
        subject: 'Review the shared controls across small screens and keyboard navigation',
        description: 'Check every focus target, menu and modal while rotating the device. '.repeat(6),
        writeScopes: ['packages/client/ui-primitives/src/'],
      })
      await scaffold.ctx.agentTeams.updateTask(agent, { taskId: active.id, expectedRevision: active.revision, action: 'claim' })
      await scaffold.ctx.agentTeams.createTask(agent, { subject: 'Publish the responsive verification results',
        description: 'Wait for the shared-control review, then record the screenshots and remaining device limitations.', blockedBy: [active.id] })
      const done = await scaffold.ctx.agentTeams.createTask(agent, { subject: 'Prepare the isolated browser fixture', description: 'Use only the temporary repository.' })
      const claimed = await scaffold.ctx.agentTeams.updateTask(agent, { taskId: done.id, expectedRevision: done.revision, action: 'claim' })
      await scaffold.ctx.agentTeams.updateTask(agent, { taskId: done.id, expectedRevision: claimed.revision, action: 'complete' })
      await expect.poll(() => panel.locator('article').count()).toBe(3)
      await panel.locator('article').filter({ hasText: active.subject }).getByText('In progress', { exact: true }).waitFor()
      await panel.locator('article').filter({ hasText: 'Publish the responsive verification results' })
        .getByText('Blocked by dependencies', { exact: true }).waitFor()
      await panel.locator('article').filter({ hasText: done.subject }).getByText('Completed', { exact: true }).waitFor()
      await auditWorkflowState(page, 'team', 'task-board', panel, [], captureHeader('task-board'))
      await page.setViewportSize({ width: 390, height: 844 })
      await panel.getByRole('button', { name: 'Show more', exact: true }).first().click()
      await auditWorkflowState(page, 'team', 'expanded-task', panel, [], captureHeader('expanded-task'))
      await screenshot(page, 'team-expanded-phone')
      await panel.getByRole('switch', { name: 'Enable agent teamwork', exact: true }).click()
      const disable = panel.getByRole('button', { name: 'Disable', exact: true })
      await disable.waitFor()
      await auditWorkflowState(page, 'team', 'disable-confirmation', panel, [disable, panel.getByRole('button', { name: 'Cancel', exact: true })], captureHeader('disable-confirmation'))
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(await panel.locator('article').count()).toBe(3)
      await panel.getByRole('switch', { name: 'Enable agent teamwork', exact: true }).click()
      await disable.click()
      await panel.getByText('Agent teamwork is off; enable it to use the shared task board and coordination tools.', { exact: true }).waitFor()
      await auditWorkflowState(page, 'team', 'disabled', panel, [], captureHeader('disabled'))
      await panel.getByRole('switch', { name: 'Enable agent teamwork', exact: true }).click()
      await expect.poll(() => panel.locator('article').count()).toBe(3)
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'experimental-team-tasks')
      throw error
    } finally { await page.close() }
  }, 180_000)

  it('shows real Team members and opens a roster member while retaining the other running child', async () => {
    const id = await seedSession(scaffold, history(), 'responsive-team-roster')
    const resolved = await scaffold.ctx.sessionController.resolveAgent(id)
    if ('error' in resolved) throw new Error(resolved.error.message)
    const lead = resolved.agent
    await scaffold.ctx.agentTeams.setEnabled(lead, true)
    const ready = [join(scratch, 'team-first-ready'), join(scratch, 'team-second-ready')]
    const replays: ReplayHandle[] = []
    const children: SessionId[] = []
    const labels = ['Review shared controls and responsive navigation across narrow screens',
      'Inspect plugin pages and preserve the complete mobile interaction history']
    const page = await open(id)
    const tripwire = watchConsole(page)
    try {
      for (const [index, label] of labels.entries()) {
        replays.push(await panelReplay(`team-roster-${index}`, [[{ kind: 'hang', readyFile: ready[index]! }]]))
        const child = await scaffold.ctx.subagents.startContinuable({ provider: 'spawn', label,
          name: `responsive-member-${index + 1}`, signal: new AbortController().signal,
          request: { parent: lead, prompt: [{ type: 'text', text: label }],
            agentOptions: { provider: `responsive-team-roster-${index}`, model: 'acceptance' } } })
        children.push(child.childId)
        await expect.poll(() => existsSync(ready[index]!), { timeout: 60_000 }).toBe(true)
      }
      await page.getByRole('button', { name: 'Agent Team', exact: true }).click()
      const panel = page.locator('[data-team-panel]')
      await panel.getByRole('button', { name: 'Refresh members', exact: true }).click()
      const members = panel.locator('button').filter({ has: page.locator('[class*="memberNameText"]') })
      await expect.poll(() => members.count()).toBe(3)
      const count = panel.getByRole('heading').filter({ hasText: 'Members' }).locator('span')
      expect(await count.innerText()).toBe('3')
      for (const label of labels) await members.filter({ hasText: label }).getByText('Running', { exact: true }).waitFor()
      await auditWorkflowState(page, 'team', 'multi-member-roster', panel)
      scaffold.ctx.subagents.interrupt(children[0]!, { kind: 'ancestor', agent: lead })
      const first = scaffold.ctx.agents.get(children[0]!)
      if (first === undefined) throw new Error('The interrupted Team member lost its live Agent')
      await first.whenIdle()
      await panel.getByRole('button', { name: 'Refresh members', exact: true }).click()
      await members.filter({ hasText: labels[0]! }).getByText('Inactive', { exact: true }).waitFor()
      await members.filter({ hasText: labels[1]! }).getByText('Running', { exact: true }).waitFor()
      await auditWorkflowState(page, 'team', 'mixed-member-activity', panel)
      await compareWorkflowGolden(join(REPO_ROOT, 'apps/web/tests/expected/experimental-panels/team-members.expected.md'),
        await panel.ariaSnapshot(), webSnapshotMode())
      await members.filter({ hasText: labels[0]! }).click()
      await page.getByText(labels[0]!, { exact: true }).first().waitFor()
      await panel.waitFor({ state: 'hidden' })
      expect(await page.getByRole('button', { name: 'Agent Team', exact: true }).count()).toBe(0)
      expect(scaffold.ctx.agents.get(children[1]!)?.status).toBe('running')
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'experimental-team-roster')
      throw error
    } finally {
      for (const child of children) scaffold.ctx.subagents.interrupt(child, { kind: 'ancestor', agent: lead })
      try { await Promise.all(children.map(async (child) => { await scaffold.ctx.agents.get(child)?.whenIdle() })) }
      finally { for (const replay of replays) replay.dispose(); await page.close() }
    }
    for (const replay of replays) replay.assertConsumed()
  }, 180_000)

  it('creates a real worktree after showing branch selection, stopped progress and retryable Git failure', async () => {
    const base = 'mobile-review-base-with-a-long-readable-branch-name'
    await run('git', ['branch', base], { cwd: scaffold.workspaceCwd })
    const sourceContent = await readFile(join(scaffold.workspaceCwd, 'responsive-preview.txt'), 'utf8')
    const createdText = 'The new worktree is ready for its first message.'
    const releaseResponse = join(scratch, 'release-worktree-created-response')
    const replay = await panelReplay('worktree', [
      [completedText('The waiting message continued in the original checkout.')],
      [{ ...completedText(createdText), hold: { after: 2, releaseFile: releaseResponse } }],
    ])
    const originalModel = scaffold.ctx.agentDefaultModel.currentSelection()
    const handles: AgentHandle[] = []
    const pages: Page[] = []
    const releases = [releaseResponse]
    const newSession = async (id: string): Promise<{ handle: AgentHandle; page: Page }> => {
      const handle = await scaffold.ctx.agents.create({ sessionId: SessionId(id),
        meta: { cwd: scaffold.workspaceCwd }, agentOptions: { provider: 'responsive-worktree', model: 'acceptance' },
        setup: ctx => scaffold.ctx.agentPresets.mount(ctx).then(() => undefined) })
      handles.push(handle)
      await (await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)).attachSession(handle.agent.id)
      const page = await open(handle.agent.id, null)
      pages.push(page)
      await page.locator('textarea:enabled:not([readonly])').first().waitFor()
      await page.getByRole('checkbox', { name: 'New worktree', exact: true }).waitFor()
      return { handle, page }
    }
    const request = async (page: Page, inspectMenu: boolean): Promise<void> => {
      const toggle = page.getByRole('checkbox', { name: 'New worktree', exact: true })
      await toggle.check()
      const branch = page.locator('[data-forge-worktree] button[aria-haspopup="menu"]')
      await branch.click()
      const menu = page.getByRole('menu')
      await menu.getByRole('menuitem', { name: base, exact: true }).waitFor()
      if (inspectMenu) await auditWorkflowState(page, 'worktree', 'base-branch-menu', menu)
      await menu.getByRole('menuitem', { name: base, exact: true }).click()
      await expect.poll(() => branch.innerText()).toBe(`From ${base}`)
    }
    try {
      await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'responsive-worktree', model: 'acceptance' })
      const stopped = await newSession('responsive-worktree-withdraw')
      const tripwire = watchConsole(stopped.page)
      await request(stopped.page, true)
      await auditWorkflowState(stopped.page, 'worktree', 'requested-base', stopped.page.locator('[data-forge-worktree]'))
      const held = await worktreeGate('prepare', 'worktree-stop')
      releases.push(held.release)
      await stopped.page.locator('textarea:enabled').first().fill('Continue this message after the worktree decision.')
      await stopped.page.locator('textarea:enabled').first().press('Enter')
      await expect.poll(() => existsSync(held.ready), { timeout: 60_000 }).toBe(true)
      const progress = stopped.page.locator('[data-forge-creation]')
      await progress.getByRole('button', { name: 'More details', exact: true }).click()
      await auditWorkflowState(stopped.page, 'worktree', 'creation-prepare-details', progress)
      await progress.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect.poll(() => progress.getAttribute('data-forge-creation')).toBe('stopped')
      await auditWorkflowState(stopped.page, 'worktree', 'creation-stopped', progress)
      await writeFile(held.release, 'continue')
      await run('git', ['branch', '-D', base], { cwd: scaffold.workspaceCwd })
      await progress.getByRole('button', { name: 'Retry', exact: true }).tap()
      await expect.poll(() => progress.getAttribute('data-forge-creation')).toBe('failed')
      expect(await progress.innerText()).toContain(base)
      expect(stopped.handle.agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
      await auditWorkflowState(stopped.page, 'worktree', 'creation-failed', progress)
      await progress.getByRole('button', { name: 'Continue without a worktree', exact: true }).click()
      await stopped.page.getByText('The waiting message continued in the original checkout.', { exact: true }).waitFor()
      await stopped.handle.agent.whenIdle()
      expect(scaffold.ctx.workingDirectory.get(stopped.handle.agent.session)).toBe(scaffold.workspaceCwd)
      expect(scaffold.ctx.sessionProjections.stateOf(stopped.handle.agent.session, 'worktree')?.created).toEqual([])
      await progress.waitFor({ state: 'detached' })
      expect(tripwire.pageErrors).toEqual([])
      await run('git', ['branch', base], { cwd: scaffold.workspaceCwd })

      const created = await newSession('responsive-worktree-created')
      const createdTripwire = watchConsole(created.page)
      await request(created.page, false)
      const prepare = await worktreeGate('prepare', 'worktree-create-prepare')
      releases.push(prepare.release)
      await created.page.locator('textarea:enabled').first().fill('Start this message inside the new checkout.')
      await created.page.locator('textarea:enabled').first().press('Enter')
      await expect.poll(() => existsSync(prepare.ready), { timeout: 60_000 }).toBe(true)
      const checkout = await worktreeGate('checkout', 'worktree-create-checkout')
      releases.push(checkout.release)
      await writeFile(prepare.release, 'continue')
      await expect.poll(() => existsSync(checkout.ready), { timeout: 60_000 }).toBe(true)
      const creation = created.page.locator('[data-forge-creation="checkout"]')
      await creation.getByRole('button', { name: 'More details', exact: true }).click()
      await auditWorkflowState(created.page, 'worktree', 'creation-checkout-details', creation)
      await writeFile(checkout.release, 'continue')
      await created.page.getByText(createdText, { exact: true }).waitFor()
      await writeFile(releaseResponse, 'complete')
      await created.handle.agent.whenIdle()
      const recorded = scaffold.ctx.sessionProjections.stateOf(created.handle.agent.session, 'worktree')?.created ?? []
      expect(recorded).toHaveLength(1)
      const worktree = recorded[0]!.worktree
      expect(worktree.path.startsWith(join(scaffold.workspaceCwd, '.agents', 'worktrees') + '/')).toBe(true)
      expect(scaffold.ctx.workingDirectory.get(created.handle.agent.session)).toBe(worktree.path)
      expect(await readFile(join(worktree.path, 'responsive-preview.txt'), 'utf8')).toBe('Initial local content.\n')
      expect(await readFile(join(scaffold.workspaceCwd, 'responsive-preview.txt'), 'utf8')).toBe(sourceContent)
      const checkoutBranch = await run('git', ['branch', '--show-current'], { cwd: worktree.path })
      expect(checkoutBranch.stdout.trim()).toBe(worktree.branch)
      await created.page.locator('[data-forge-creation]').waitFor({ state: 'detached' })
      expect(await created.page.getByRole('checkbox', { name: 'New worktree', exact: true }).count()).toBe(0)
      await auditWorkflowState(created.page, 'worktree', 'created-checkout', created.page.locator('[data-conversation-region="chat"]'))
      await compareWorkflowGolden(join(REPO_ROOT, 'apps/web/tests/expected/experimental-panels/worktree-created.expected.md'),
        await captureStableAria(created.page, '[data-conversation-region="chat"]', scaffold.workspaceCwd), webSnapshotMode())
      expect(createdTripwire.pageErrors).toEqual([])
    } catch (error) {
      for (const [index, page] of pages.entries()) await saveFailureShot(page, `experimental-worktree-${index}`)
      throw error
    } finally {
      for (const release of releases) await writeFile(release, 'cleanup')
      try { await Promise.all(handles.map(handle => handle.dispose())) }
      finally {
        replay.dispose()
        try { await scaffold.ctx.agentDefaultModel.saveSelection(originalModel) }
        finally { await Promise.all(pages.map(page => page.close())) }
      }
    }
    replay.assertConsumed()
  }, 360_000)

  it('reads local changes in unified and split views across every responsive width', async () => {
    const page = await open()
    const tripwire = watchConsole(page)
    try {
      await page.locator('[data-forge-header]').click()
      const local = page.locator('[data-forge-local]')
      await local.getByRole('button', { name: /View.*changes/u }).click()
      const changes = page.locator('[data-forge-changes="local"]')
      await changes.waitFor()
      for (const viewport of responsiveViewports) {
        await page.setViewportSize(viewport)
        await page.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
        }))
        await expectViewportFit(page, changes)
        for (const name of ['Wrap lines', 'Wrap lines', 'Side by side', 'Side by side']) {
          const button = changes.getByRole('button', { name, exact: true })
          if (await button.isVisible()) await button.click()
          else {
            await changes.getByRole('button', { name: 'More view options' }).click()
            await page.getByRole('menuitem', { name, exact: true }).click()
          }
        }
      }
      await page.setViewportSize({ width: 390, height: 844 })
      await screenshot(page, 'forge-local-phone')
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'experimental-forge-local')
      console.log(await page.locator('body').ariaSnapshot())
      throw error
    } finally { await page.close() }
  }, 120_000)

  it('opens deep log details, filters types and changes Inspector presentation on phones', async () => {
    const page = await open()
    try {
      await page.locator('[data-forge-header]').click()
      await page.locator('[data-sidebar-right-panel]').getByRole('button', { name: 'New tab', exact: true }).click()
      await page.getByRole('button', { name: 'Session Log', exact: true }).click()
      const inspector = page.locator('section[aria-label="Raw Log"]')
      const table = inspector.getByRole('table', { name: 'Raw Log' })
      await table.waitFor()
      expect(Number(await table.getAttribute('aria-rowcount'))).toBeGreaterThan(100)
      const scroller = inspector.getByRole('region', { name: 'Raw Log', exact: true })
      await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight / 2 })
      await table.locator('tbody tr:not([aria-hidden])').first().locator('td').nth(1).getByRole('button').last().click()
      const details = inspector.getByRole('separator', { name: 'Resize raw data panel' })
      await details.waitFor()
      await details.focus()
      await details.press('ArrowUp')
      await auditWorkflowState(page, 'session-inspector', 'deep-raw-log-details', inspector,
        [inspector.getByRole('combobox', { name: 'Presentation' }), details])
      await page.setViewportSize({ width: 390, height: 844 })
      await inspector.getByRole('button', { name: 'Filter types' }).click()
      await page.getByRole('combobox', { name: 'Type keyword' }).fill('assistant/message')
      await auditWorkflowState(page, 'session-inspector', 'type-filter', page.getByRole('dialog', { name: 'Filter types', exact: true }))
      await page.getByRole('button', { name: 'Apply filter', exact: true }).click()
      await auditWorkflowState(page, 'session-inspector', 'filtered-raw-log', inspector)
      await screenshot(page, 'inspector-filter-phone')
      await inspector.getByRole('button', { name: 'Filter types' }).click()
      await page.getByRole('combobox', { name: 'Type keyword' }).fill('no-such-session-event')
      await page.getByRole('status').filter({ hasText: 'No suggestions. You can still apply this keyword.' }).waitFor()
      await auditWorkflowState(page, 'session-inspector', 'type-filter-no-match', page.getByRole('dialog', { name: 'Filter types', exact: true }))
      await page.getByRole('button', { name: 'Apply filter', exact: true }).click()
      await inspector.getByText('No records', { exact: true }).waitFor()
      await auditWorkflowState(page, 'session-inspector', 'empty-filtered-log', inspector)
      await inspector.getByRole('button', { name: 'Filter types' }).click()
      await page.getByRole('button', { name: 'Clear', exact: true }).click()
      await page.getByRole('button', { name: 'Apply filter', exact: true }).click()
      await expect.poll(async () => Number(await table.getAttribute('aria-rowcount'))).toBeGreaterThan(100)
      await inspector.getByRole('combobox', { name: 'Presentation' }).selectOption('chat-node')
      const chat = page.locator('section[aria-label="Chat Group"]')
      await auditWorkflowState(page, 'session-inspector', 'chat-group', chat)
      await chat.getByRole('table').locator('tbody tr:not([aria-hidden])').first().locator('td').nth(1).getByRole('button').last().click()
      await auditWorkflowState(page, 'session-inspector', 'chat-group-details', chat)
      await screenshot(page, 'inspector-chat-phone')
    } catch (error) {
      await saveFailureShot(page, 'experimental-inspector')
      console.log(await page.locator('body').ariaSnapshot())
      throw error
    } finally { await page.close() }
  }, workflowMatrixEnabled ? 300_000 : 120_000)

  it('starts phone diffs unified and preserves an explicit column choice across rotation', async () => {
    const page = await open()
    try {
      await page.locator('[data-forge-header]').click()
      await page.setViewportSize({ width: 390, height: 844 })
      await page.locator('[data-forge-local]').getByRole('button', { name: /View.*changes/u }).click()
      const changes = page.locator('[data-forge-changes="local"]')
      const file = changes.locator('[data-forge-diff-file="responsive-preview.txt"]')
      await file.waitFor()
      expect(await file.locator('[data-split]').count()).toBe(0)
      await changes.getByRole('button', { name: 'More view options' }).click()
      await page.getByRole('menuitem', { name: 'Side by side', exact: true }).click()
      await expect.poll(() => file.locator('[data-split]').count()).toBe(1)
      await page.setViewportSize({ width: 844, height: 390 })
      expect(await file.locator('[data-split]').count()).toBe(1)
      await page.setViewportSize({ width: 390, height: 844 })
      expect(await file.locator('[data-split]').count()).toBe(1)
      await changes.getByRole('button', { name: 'More view options' }).click()
      await page.getByRole('menuitem', { name: 'Side by side', exact: true }).click()
      await expect.poll(() => file.locator('[data-split]').count()).toBe(0)
      await screenshot(page, 'forge-unified-phone')
    } catch (error) {
      await saveFailureShot(page, 'experimental-forge-phone-choice')
      throw error
    } finally { await page.close() }
  }, 60_000)

  it('saves and reloads worktree retention from the actual installed package page', async () => {
    const page = await open()
    try {
      await page.getByRole('navigation', { name: 'Panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
      await page.locator('[data-plugin-item="worktree"]').getByRole('button').first().click()
      const detail = page.locator('[data-plugin-item-detail="worktree"]')
      const toggle = detail.getByRole('switch', { name: 'Keep worktrees when archiving' })
      await toggle.waitFor()
      await page.setViewportSize({ width: 320, height: 568 })
      await expectViewportFit(page, detail, [toggle])
      await toggle.tap()
      await detail.getByRole('button', { name: 'Save', exact: true }).click()
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
      await page.reload()
      await page.getByText('Local inspection 100 is complete.', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
      await page.getByRole('navigation', { name: 'Panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
      await page.locator('[data-plugin-item="worktree"]').getByRole('button').first().click()
      await toggle.waitFor()
      expect(await toggle.getAttribute('aria-checked')).toBe('true')
      const expected = join(REPO_ROOT, 'apps/web/tests/expected/experimental-panels/worktree-settings.expected.md')
      await mkdir(join(expected, '..'), { recursive: true })
      await compareOrRefreshGolden(expected, await captureStableAria(page, '[data-plugin-item-detail] [data-plugin-config]', scaffold.workspaceCwd), webSnapshotMode())
      await screenshot(page, 'worktree-settings-phone')
    } catch (error) {
      await saveFailureShot(page, 'experimental-worktree-settings')
      console.log(await page.locator('body').ariaSnapshot())
      throw error
    } finally { await page.close() }
  }, 60_000)
})
