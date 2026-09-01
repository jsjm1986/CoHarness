import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { afterEach, describe, expect, it } from 'vitest'
import AgentPresets, { COMPOSITION_FILE, METADATA_FILE } from '../src/index.ts'
import type { Config } from '../src/preset.ts'
import { fileComposition, mountedCompositionRows } from '../src/composition-inventory.ts'
import { livePresetMounts } from '../src/mount.ts'

const roots: string[] = []
const contexts: Context[] = []
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('preset composition inventory', () => {
  it('flattens nested groups and evaluates disabled expressions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-composition-inventory-'))
    roots.push(root)
    const path = join(root, 'agent.cordis.yml')
    await writeFile(path, [
      '- id: global\n  name: global-plugin',
      '- group: true\n  name: group\n  disabled: true\n  config:\n    - id: nested\n      name: nested-plugin',
      '- id: conditional\n  name: conditional-plugin\n  disabled: !!js process.env.DSH_MISSING_FLAG',
    ].join('\n'))
    const result = await fileComposition(path, (expression) => {
      if (expression.includes('DSH_MISSING_FLAG')) throw new Error('not available')
      return false
    })
    expect(result).toEqual({ rows: [
      { entryId: 'global', moduleName: 'global-plugin', enabled: true },
      { entryId: 'nested', moduleName: 'nested-plugin', enabled: false },
      { entryId: 'conditional', moduleName: 'conditional-plugin', enabled: 'conditional', condition: 'process.env.DSH_MISSING_FLAG' },
    ] })
  })

  it('preserves anonymous rows and evaluates both decidable and conditional gates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-composition-inventory-'))
    roots.push(root)
    const path = join(root, 'agent.cordis.yml')
    await writeFile(path, [
      '- name: anonymous-plugin',
      '- id: evaluated-off\n  name: off-plugin\n  disabled: !!js 1 === 1',
      '- id: evaluated-on\n  name: on-plugin\n  disabled: !!js 1 === 2',
      '- id: conditional-group\n  name: group\n  group: true\n  disabled: !!js unknown.value\n  config:\n    - id: conditional-child\n      name: child-plugin',
    ].join('\n'))
    expect(await fileComposition(path, (expression) => {
      if (expression === '1 === 1') return true
      if (expression === '1 === 2') return false
      throw new Error('no loader context')
    })).toEqual({ rows: [
      { entryId: null, moduleName: 'anonymous-plugin', enabled: true },
      { entryId: 'evaluated-off', moduleName: 'off-plugin', enabled: false, condition: '1 === 1' },
      { entryId: 'evaluated-on', moduleName: 'on-plugin', enabled: true, condition: '1 === 2' },
      { entryId: 'conditional-child', moduleName: 'child-plugin', enabled: 'conditional' },
    ] })
  })

  it('reports malformed composition files instead of dropping them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-composition-inventory-'))
    roots.push(root)
    const path = join(root, 'agent.cordis.yml')
    await writeFile(path, 'not: a plugin list\n')
    const result = await fileComposition(path, () => false)
    expect('broken' in result).toBe(true)
    if ('broken' in result) expect(result.broken).toContain('top-level list')
  })

  it('reports a missing or unparsable file with its read reason', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-composition-inventory-'))
    roots.push(root)
    const missing = await fileComposition(join(root, 'missing.yml'), () => false)
    expect('broken' in missing).toBe(true)
    const invalid = join(root, 'invalid.yml')
    await writeFile(invalid, 'foo: [')
    const result = await fileComposition(invalid, () => false)
    expect('broken' in result && result.broken.length > 0).toBe(true)
  })
})

describe('mounted composition inventory', () => {
  it('reads evaluated enablement and fiber state while skipping groups', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.active = () => {}
    const activeId = await ctx.loader.create({ name: 'cordis:active' })
    const disabledId = await ctx.loader.create({ name: 'cordis:active', disabled: true })
    const conditionalId = await ctx.loader.create({
      name: 'cordis:active',
      disabled: { __jsExpr: 'false' } as unknown as boolean,
    })
    await ctx.loader.create({ name: 'cordis:active', group: true })

    const rows = mountedCompositionRows(ctx.loader)
    const byId = new Map(rows.map(row => [row.entryId, row]))
    expect(rows).toHaveLength(3)
    expect(byId.get(activeId)).toEqual({
      entryId: activeId, moduleName: 'cordis:active', enabled: true, fiberState: FiberState.ACTIVE,
    })
    expect(byId.get(disabledId)).toEqual({
      entryId: disabledId, moduleName: 'cordis:active', enabled: false,
    })
    expect(byId.get(conditionalId)).toEqual({
      entryId: conditionalId, moduleName: 'cordis:active', enabled: true,
      condition: 'false', fiberState: FiberState.ACTIVE,
    })
  })
})

describe('AgentPresets.compositionInventory', () => {
  async function harness(config: Config): Promise<Context> {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = `${pathToFileURL(FIXTURES).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(AgentPresets, config)
    return ctx
  }

  it('reads an unmounted preset from its file and marks the configured default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-composition-roster-'))
    roots.push(root)
    await mkdir(join(root, 'documented'))
    await writeFile(join(root, 'documented', COMPOSITION_FILE), [
      '- id: prompt\n  name: cordis:group\n  group: true\n  config:\n    - id: child\n      name: \'@deepseek-ai/dsh-system-prompt\'',
    ].join('\n'))
    await writeFile(join(root, 'documented', METADATA_FILE), 'name: 我的模式\n')
    const ctx = await harness({
      default: 'documented',
      roots: [{ path: root, trust: 'user' }],
      includeUserRoot: false,
    })
    expect(await ctx.agentPresets.compositionInventory()).toEqual([{
      id: 'documented', trust: 'user', name: '我的模式', isDefault: true,
      rows: [{ entryId: 'child', moduleName: '@deepseek-ai/dsh-system-prompt', enabled: true }],
    }])
    expect(livePresetMounts()).toEqual([])
  })

  it('prefers live mounted rows and preserves a broken discovered preset', async () => {
    const ctx = await harness({
      default: 'standard',
      roots: [{ path: join(FIXTURES, 'system'), trust: 'system' }],
      includeUserRoot: false,
    })
    const handle = await ctx.agents.create({
      sessionId: SessionId('composition-inventory-live'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })
    const live = (await ctx.agentPresets.compositionInventory()).find(item => item.id === 'standard')
    expect(live?.rows.some(row => row.fiberState === FiberState.ACTIVE)).toBe(true)
    await handle.dispose()

    const brokenRoot = await mkdtemp(join(tmpdir(), 'dsh-composition-broken-'))
    roots.push(brokenRoot)
    await mkdir(join(brokenRoot, 'broken'))
    const brokenCtx = await harness({
      default: 'broken',
      roots: [{ path: brokenRoot, trust: 'user' }],
      includeUserRoot: false,
    })
    const [broken] = await brokenCtx.agentPresets.compositionInventory()
    expect(broken?.rows).toEqual([])
    expect(broken?.broken).toContain('is missing')
  })
})
