/** Blank Session reuse under the requested or default Agent preset through the shipped Web composition. */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: pulls the plan/mode SessionEventMap merge so the discriminant
// filter below types as the plan-mode event in the host aggregate.
import type {} from '@deepseek-ai/dsh-plan-mode'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

/** A preset these blank Sessions recorded that the deployment no longer declares. */
const UNDECLARED = 'liangshen'

describe('web e2e: blank Session reuse under the requested preset', () => {
  let scaffold: WebScaffold
  let browser: Browser
  const tripwires: ReturnType<typeof watchConsole>[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /** Store a blank Session recorded under `agentPreset`, with a plan-mode switch, as the only member of a new Workspace. */
  async function storeBlank(sessionId: SessionId, folder: string, agentPreset: string): Promise<void> {
    const path = join(scaffold.workspaceCwd, folder)
    await mkdir(path)
    const workspace = await scaffold.ctx.workspaceRegistry.create(path)
    const handle = await scaffold.ctx.agents.create({
      sessionId,
      meta: { cwd: path, agentPreset },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    try {
      // A standalone switch leaves the Session blank while proving the log
      // survives the reuse that follows.
      handle.agent.session.append('plan/mode', { active: true })
      await workspace.attachSession(sessionId)
    } finally {
      await handle.dispose()
    }
  }

  async function openPage(saved?: SessionId): Promise<Page> {
    const page = await newEnglishPage(browser)
    tripwires.push(watchConsole(page))
    if (saved !== undefined) {
      await page.addInitScript((id) => {
        localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
      }, saved)
    }
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    return page
  }

  async function selected(page: Page): Promise<string | undefined> {
    return page.evaluate(() => {
      const value = localStorage.getItem('dsh.sessions.current')
      return value === null ? undefined : (JSON.parse(value) as { sessionId?: string }).sessionId
    })
  }

  /** The live Agent's mounted preset and the preset its log resolves. */
  function liveComposition(sessionId: SessionId) {
    const agent = scaffold.ctx.agents.get(sessionId)
    const presets = scaffold.ctx.get('agentPresets')
    if (agent === undefined || presets === undefined) return undefined
    return {
      mounted: presets.composedPreset(agent.ctx),
      resolved: resolveSessionPreset(agent.session),
    }
  }

  async function storedEvents(sessionId: SessionId): Promise<readonly SessionEvent[]> {
    return (await scaffold.ctx.sessionPersistence.inspect(sessionId)).events
  }

  it('reuses a blank recorded under an undeclared preset under the default when startup connects its Workspace', async () => {
    const stale = SessionId('blank-undeclared')
    await storeBlank(stale, 'undeclared', UNDECLARED)

    const page = await openPage()
    onTestFailed(() => saveFailureShot(page, 'web-e2e-blank-preset-reuse-connect'))
    await expect.poll(() => selected(page), { timeout: 15_000 }).toBe(stale)
    await expect.poll(() => liveComposition(stale)).toMatchObject({ mounted: 'standard', resolved: 'standard' })
    const events = await storedEvents(stale)
    expect(events.filter(event => event.type === 'agent-preset/selected').map(event => event.data))
      .toEqual([{ agentPreset: 'standard' }])
    // The standalone switch survived the reuse rather than being replayed away.
    expect(events.some(event => event.type === 'plan/mode' && event.data.active === true)).toBe(true)
    expect(scaffold.ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(stale))?.sessionIds).toEqual([stale])
    expect(await page.getByRole('alert').count()).toBe(0)
  })

  it('restores a saved blank under the preset it recorded', async () => {
    const picked = SessionId('blank-picked')
    await storeBlank(picked, 'picked', 'minimal')

    const page = await openPage(picked)
    await expect.poll(() => selected(page)).toBe(picked)
    await expect.poll(() => liveComposition(picked)).toMatchObject({ mounted: 'minimal', resolved: 'minimal' })
    // Nothing recomposed, so no selection event is appended.
    expect((await storedEvents(picked)).filter(event => event.type === 'agent-preset/selected')).toEqual([])
  })

  it('restores a saved blank under the default once its recorded preset is undeclared', async () => {
    const saved = SessionId('saved-undeclared')
    await storeBlank(saved, 'saved-undeclared', UNDECLARED)

    const page = await openPage(saved)
    await expect.poll(() => selected(page)).toBe(saved)
    await expect.poll(() => liveComposition(saved)).toMatchObject({ mounted: 'standard', resolved: 'standard' })
    expect((await storedEvents(saved)).filter(event => event.type === 'agent-preset/selected').map(event => event.data))
      .toEqual([{ agentPreset: 'standard' }])
    expect(await page.getByRole('alert').count()).toBe(0)
    for (const tripwire of tripwires) {
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    }
  })
})
