/**
 * Declared presets: a plugin registers a `PresetDefinition` instead of
 * shipping a directory, and the registry composes it through the same
 * generations, joins, and read surfaces file presets use. A retired
 * declaration keeps the generation its joined agents still run.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
import { afterEach, describe, expect, it } from 'vitest'
import AgentPresetRegistry, { PresetNotWritableError } from '@deepseek-ai/dsh-agent-preset-registry'
import type { Config, PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const CONTRIBUTE = pathToFileURL(join(FIXTURES, 'plugins', 'contribute.js')).href

const DECLARED: PresetDefinition = {
  id: 'declared',
  name: 'Declared preset',
  description: 'a preset declared in code',
  order: 5,
  plugins: [{ id: 'only', name: CONTRIBUTE, config: { tool: 'declaredTool' } }],
}

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function harness(): Promise<Context> {
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-preset-declared-'))
  roots.push(root)
  await ctx.plugin(AgentPresetRegistry, {
    default: 'declared',
    roots: [{ path: join(root, 'none'), trust: 'user' }],
    includeUserRoot: false,
  } satisfies Config)
  contexts.push(ctx)
  return ctx
}

async function agentOn(ctx: Context, id: string, presetId?: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, presetId),
  })
  return handle.agent
}

const toolNames = (ctx: Context, agent?: Agent): string[] =>
  ctx.tools.schemas(agent).map(schema => schema.name).sort()

describe('a plugin-declared preset', () => {
  it('joins the roster as a system row and resolves by id', async () => {
    const ctx = await harness()
    const dispose = await ctx.agentPresets.register(DECLARED)

    const presets = await ctx.agentPresets.list()
    const row = presets.find(preset => preset.id === 'declared')
    expect(row).toMatchObject({ id: 'declared', trust: 'system', name: 'Declared preset', order: 5 })
    expect(row?.path).toBeUndefined()
    expect((await ctx.agentPresets.resolve('declared')).id).toBe('declared')
    await dispose()
  })

  it('mounts an agent onto its generation and shares it across agents', async () => {
    const ctx = await harness()
    await ctx.agentPresets.register(DECLARED)

    const first = await agentOn(ctx, 'sess-declared-a', 'declared')
    const second = await agentOn(ctx, 'sess-declared-b', 'declared')

    expect(toolNames(ctx, first)).toContain('declaredTool')
    expect(toolNames(ctx, second)).toContain('declaredTool')
    expect(ctx.agentPresets.composedPreset(first.ctx)).toBe('declared')
  })

  it('keeps joined agents on a retired generation after unregister', async () => {
    const ctx = await harness()
    const dispose = await ctx.agentPresets.register(DECLARED)
    const agent = await agentOn(ctx, 'sess-declared-retired', 'declared')

    await dispose()

    expect(toolNames(ctx, agent)).toContain('declaredTool')
    await expect(ctx.agentPresets.resolve('declared')).rejects.toThrow(/not found/)
  })

  it('reports its mounted composition and declared rows to inventory', async () => {
    const ctx = await harness()
    await ctx.agentPresets.register(DECLARED)
    await agentOn(ctx, 'sess-declared-inspect', 'declared')

    const inspected = await ctx.agentPresets.inspectCompositions()
    const row = inspected.find(item => item.id === 'declared')
    expect(row?.modules.map(module => module.moduleName)).toEqual([CONTRIBUTE])

    const inventory = await ctx.agentPresets.compositionInventory()
    const declared = inventory.find(item => item.id === 'declared')
    expect(declared?.rows.map(row => row.entryId)).toEqual(['only'])
  })

  it('reads as entry-list YAML', async () => {
    const ctx = await harness()
    await ctx.agentPresets.register(DECLARED)

    const content = await ctx.agentPresets.read('declared')
    expect(content).toContain(CONTRIBUTE)
    expect(content).toContain('declaredTool')
  })

  it('refuses copy, remove, and duplicate registration', async () => {
    const ctx = await harness()
    await ctx.agentPresets.register(DECLARED)

    await expect(ctx.agentPresets.copy('declared', 'copy-of-declared')).rejects.toThrow(PresetNotWritableError)
    await expect(ctx.agentPresets.remove('declared')).rejects.toThrow(PresetNotWritableError)
    await expect(ctx.agentPresets.register(DECLARED)).rejects.toThrow(/Duplicate agent preset/)
  })

  it('leases its scope through acquireScope', async () => {
    const ctx = await harness()
    await ctx.agentPresets.register(DECLARED)

    const lease = await ctx.agentPresets.acquireScope('declared')
    expect(lease.key).toMatchObject({ agentPreset: 'declared' })
    await lease.dispose()
    await lease.dispose()
  })
})
