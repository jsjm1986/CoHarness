/**
 * Standing realms: a registered realm hook runs inside a fresh standing scope
 * BEFORE the preset subtree loads, so environment providers it installs are
 * what the composition's service lookups resolve — an SSH target's providers
 * shadowing `fs` for every agent joined to that realm's generation, while
 * agents outside the realm keep resolving the host's.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { PluginPackages } from '@deepseek-ai/dsh-app-boot'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentPresets from '../src/index.ts'
import { environmentForAgent } from '../src/mount.ts'
import type { Config } from '../src/index.ts'
import type {} from '../src/types.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
// The probe preset lives in its own root so the shared `system`/`user`
// fixture rosters keep their exact-enumeration assertions.
const ROOTS = [{ path: join(FIXTURES, 'realm'), trust: 'system' as const }]

/** Host-realm `fs` identity every unscoped composition resolves. */
const HOST_FS = { marker: 'host' }

declare global {
  var __PROBE_FS__: { tool: string; marker: string | undefined }[] | undefined
}

/** Boot the composition harness with a host `fs` a realm can shadow. */
async function harness(roster: Config = { default: 'probe', roots: ROOTS, includeUserRoot: false }): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  await ctx.plugin(PluginPackages)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, roster)
  ctx.provide('fs', HOST_FS)
  contexts.push(ctx)
  return ctx
}

/** Compose one agent under `presetId`, joining `realm`'s generation when given. */
async function agentOn(ctx: Context, id: string, presetId?: string, realm?: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, presetId, realm),
  })
  return handle.agent
}

/** The `fs` markers every probe row registration captured, in mount order. */
const probeMarkers = (): (string | undefined)[] =>
  (globalThis.__PROBE_FS__ ?? []).filter(entry => entry.tool === 'probe').map(entry => entry.marker)

/** Install one shadowed `fs` on the standing scope, mirroring an SSH realm. */
function shadowFs(scopeCtx: Context, marker: string): void {
  const isolate = Object.create(scopeCtx[Context.isolate]) as Record<string, symbol>
  isolate['fs'] = Symbol('fs')
  scopeCtx[Context.isolate] = isolate
  scopeCtx.provide('fs', { marker })
}

let ctx: Context
const contexts: Context[] = []
beforeEach(async () => {
  globalThis.__PROBE_FS__ = []
  ctx = await harness()
})
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  globalThis.__PROBE_FS__ = undefined
})

describe('standing realms', () => {
  it('runs the realm hook before the preset rows so they resolve the shadowed service', async () => {
    ctx.agentPresets.registerRealm('ssh-a', async (scopeCtx) => { shadowFs(scopeCtx, 'realm-a') })

    await agentOn(ctx, 'sess-a', 'probe', 'ssh-a')

    expect(probeMarkers()).toEqual(['realm-a'])
  })

  it('keeps the host service for agents outside the realm', async () => {
    ctx.agentPresets.registerRealm('ssh-a', async (scopeCtx) => { shadowFs(scopeCtx, 'realm-a') })

    await agentOn(ctx, 'sess-host', 'probe')
    await agentOn(ctx, 'sess-a', 'probe', 'ssh-a')

    expect(probeMarkers()).toEqual(['host', 'realm-a'])
    expect(ctx.fs).toBe(HOST_FS)
  })

  it('isolates two subjects of one target into separate generations', async () => {
    ctx.agentPresets.registerRealm('ssh-a', async (scopeCtx) => { shadowFs(scopeCtx, 'realm-a') })
    ctx.agentPresets.registerRealm('ssh-b', async (scopeCtx) => { shadowFs(scopeCtx, 'realm-b') })

    await agentOn(ctx, 'sess-a', 'probe', 'ssh-a')
    await agentOn(ctx, 'sess-b', 'probe', 'ssh-b')

    expect(probeMarkers()).toEqual(['realm-a', 'realm-b'])
  })

  it('reuses a live realm generation instead of remounting', async () => {
    const hook = vi.fn(async (scopeCtx: Context) => { shadowFs(scopeCtx, 'realm-a') })
    ctx.agentPresets.registerRealm('ssh-a', hook)

    await agentOn(ctx, 'sess-a', 'probe', 'ssh-a')
    await agentOn(ctx, 'sess-a2', 'probe', 'ssh-a')

    expect(hook).toHaveBeenCalledTimes(1)
    expect(probeMarkers()).toEqual(['realm-a'])
  })

  it('rejects an agent joining an unregistered realm', async () => {
    await expect(agentOn(ctx, 'sess-x', 'probe', 'ghost')).rejects.toThrow('unknown standing realm')
  })

  it('re-runs the hook on the first join after invalidation', async () => {
    let generation = 0
    ctx.agentPresets.registerRealm('ssh-a', async (scopeCtx) => {
      generation += 1
      shadowFs(scopeCtx, `realm-a-g${String(generation)}`)
    })

    await agentOn(ctx, 'sess-a', 'probe', 'ssh-a')
    ctx.agentPresets.invalidateRealm('ssh-a')
    await agentOn(ctx, 'sess-b', 'probe', 'ssh-a')

    expect(generation).toBe(2)
    expect(probeMarkers()).toEqual(['realm-a-g1', 'realm-a-g2'])
  })

  it('does not retire other realms when one is invalidated', async () => {
    const hooks = { a: 0, b: 0 }
    ctx.agentPresets.registerRealm('ssh-a', async (scopeCtx) => { hooks.a += 1; shadowFs(scopeCtx, 'a') })
    ctx.agentPresets.registerRealm('ssh-b', async (scopeCtx) => { hooks.b += 1; shadowFs(scopeCtx, 'b') })

    await agentOn(ctx, 'sess-a', 'probe', 'ssh-a')
    await agentOn(ctx, 'sess-b', 'probe', 'ssh-b')
    ctx.agentPresets.invalidateRealm('ssh-a')
    await agentOn(ctx, 'sess-b2', 'probe', 'ssh-b')

    expect(hooks).toEqual({ a: 1, b: 1 })
  })

  it('rolls the generation back when the realm hook fails', async () => {
    let calls = 0
    ctx.agentPresets.registerRealm('ssh-a', async () => {
      calls += 1
      if (calls === 1) throw new Error('realm admission failed')
    })

    await expect(agentOn(ctx, 'sess-a', 'probe', 'ssh-a')).rejects.toThrow('realm admission failed')
    await agentOn(ctx, 'sess-b', 'probe', 'ssh-a')
    expect(calls).toBe(2)
  })

  it('exposes the realm-installed environment through environmentForAgent', async () => {
    ctx.agentPresets.registerRealm('ssh-a', async (scopeCtx) => { shadowFs(scopeCtx, 'realm-a') })

    const agent = await agentOn(ctx, 'sess-env', 'probe', 'ssh-a')
    const hostAgent = await agentOn(ctx, 'sess-env-host', 'probe')

    expect(environmentForAgent(ctx, agent, 'fs')).toEqual({ marker: 'realm-a' })
    // A host composition has no realm environment: callers isolating on it
    // must see undefined, never the host's own `fs`.
    expect(environmentForAgent(ctx, hostAgent, 'fs')).toBeUndefined()
  })

  it('returns undefined from environmentForAgent for an agent joined to no preset', async () => {
    const unmounted = ctx.extend({})

    expect(environmentForAgent(ctx, { ctx: unmounted }, 'fs')).toBeUndefined()
  })
})
