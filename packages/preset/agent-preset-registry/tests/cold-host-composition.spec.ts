/** File presets join an asynchronously starting Host through the real Loader. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Llm from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Presets, { PresetMountError, livePresetMounts } from '../src/index.ts'
import { afterEach, expect, it, vi } from 'vitest'

declare module '@deepseek-ai/cordis' {
  interface Context { coldPresetHost: { ready: boolean } }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

async function fixture(outcome: 'ready' | 'missing' | 'failed' = 'ready') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cold-preset-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  const loader = ctx.loader
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  cleanups.push(async () => { release.resolve(undefined); await loader.await() })
  Object.assign(ctx.loader.builtins, {
    include: Include, llm: Llm, sessions: Sessions, tools: Tools, executor: NativeExecutor,
    prompt: SystemPrompt, agents: Agents, loop: AgentLoop, presets: Presets, persistence: Persistence, projections: Projections,
    cold: { name: 'cold-host-service', async apply(host: Context) {
      host.effect(() => () => { release.resolve(undefined) })
      entered.resolve(undefined)
      await release.promise
      if (outcome === 'failed') throw new Error('Host fixture failed to initialize')
      if (outcome === 'ready') host.provide('coldPresetHost', { ready: true })
    } },
  })
  const preset = join(root, 'presets', 'cold')
  await mkdir(preset, { recursive: true })
  await writeFile(join(preset, 'tool.js'), `export const inject = ['tools', 'coldPresetHost'];
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({ name: 'cold_ready', description: 'Host-backed tool',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'ready' }));
}
`)
  await writeFile(join(preset, 'agent.cordis.yml'), '- id: cold-tool\n  name: ./tool.js\n')
  const file = join(root, 'cordis.yml')
  await writeFile(file, JSON.stringify([
    ...['llm', 'sessions', 'tools', 'executor', 'prompt', 'agents', 'projections'].map(name => ({ id: name, name: `cordis:${name}` })),
    { id: 'loop', name: 'cordis:loop', config: { agents: [] } },
    { id: 'persistence', name: 'cordis:persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
    { id: 'presets', name: 'cordis:presets', config: { default: 'cold', roots: [{ path: join(root, 'presets'), trust: 'system' }], includeUserRoot: false } },
    { id: 'cold', name: 'cordis:cold' },
  ]))
  const spine = Promise.withResolvers<undefined>()
  ctx.inject(['agents', 'agentLoop', 'agentPresets', 'sessionPersistence'], () => { spine.resolve(undefined) })
  const boot = ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  cleanups.push(async () => { release.resolve(undefined); await boot })
  await Promise.all([entered.promise, spine.promise])
  const waiting = Promise.withResolvers<undefined>(), settle = ctx.loader.await.bind(ctx.loader)
  const wait = vi.spyOn(ctx.loader, 'await').mockImplementation(async () => { waiting.resolve(undefined); await settle() })
  const create = (signal?: AbortSignal) => ctx.agents.create({ sessionId: SessionId('cold-first'),
    ...(signal === undefined ? {} : { signal }),
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx) } })
  return { ctx, release, waiting, wait, create }
}

it('waits for the Host provider on the first file-preset creation without waiting for its own mount', async () => {
  const f = await fixture()
  const created = f.create()
  const result = created.then(handle => ({ handle }), (error: unknown) => ({ error }))
  try {
    expect(await Promise.race([f.waiting.promise.then(() => 'waiting'), result])).toBe('waiting')
    expect(f.ctx.agents.list()).toEqual([])
    f.release.resolve(undefined)
    const handle = await created
    expect(f.ctx.tools.schemas(handle.agent).map(tool => tool.name)).toEqual(['cold_ready'])
    expect(f.wait).toHaveBeenCalledTimes(1)
    await handle.dispose()
  } finally { f.release.resolve(undefined); await result }
})

it('cancels unpublished creation while the Host is pending and releases standing resources on owner disposal', async () => {
  const f = await fixture()
  const controller = new AbortController()
  const result = f.create(controller.signal).then(handle => ({ handle }), (error: unknown) => ({ error }))
  try {
    expect(await Promise.race([f.waiting.promise.then(() => 'waiting'), result])).toBe('waiting')
    controller.abort(new Error('Cancelled first creation'))
    expect(await result).toHaveProperty('error')
    expect(f.ctx.agents.list()).toEqual([])
    expect(f.ctx.sessions.list()).toEqual([])
    f.release.resolve(undefined)
    await f.ctx.loader.await()
    await f.ctx.fiber.dispose()
    expect(livePresetMounts(f.ctx.root.fiber)).toEqual([])
  } finally { f.release.resolve(undefined); await result }
})

it('rejects creation when only the preset registry unloads while its Host dependency is pending', async () => {
  const f = await fixture()
  const result = f.create().then(handle => ({ handle }), (error: unknown) => ({ error }))
  try {
    expect(await Promise.race([f.waiting.promise.then(() => 'waiting'), result])).toBe('waiting')
    const registry = [...f.ctx.loader.entries()].find(entry => entry.options.id === 'presets')!
    await registry.fiber!.dispose()
    expect(f.ctx.get('agentPresets')).toBeUndefined()
    expect(f.ctx.get('coldPresetHost')).toBeUndefined()
    expect(f.ctx.agents.list()).toEqual([])
    f.release.resolve(undefined)
    const settled = await result
    expect(settled).toHaveProperty('error')
    if (!('error' in settled)) throw new Error('Disposed preset unexpectedly published an Agent')
    expect(settled.error).toBeInstanceOf(PresetMountError)
    expect(f.ctx.agents.list()).toEqual([])
    expect(f.ctx.sessions.list()).toEqual([])
    expect(livePresetMounts(f.ctx.root.fiber)).toEqual([])
  } finally { f.release.resolve(undefined); await result }
})

it.each(['missing', 'failed'] as const)('rejects a genuinely %s Host dependency after startup settles', async (outcome) => {
  const f = await fixture(outcome)
  const result = f.create().then(handle => ({ handle }), (error: unknown) => ({ error }))
  try {
    expect(await Promise.race([f.waiting.promise.then(() => 'waiting'), result])).toBe('waiting')
    f.release.resolve(undefined)
    const settled = await result
    expect(settled).toHaveProperty('error')
    if (!('error' in settled)) throw new Error('Preset unexpectedly started')
    expect(settled.error).toBeInstanceOf(PresetMountError)
    expect((settled.error as Error).message).toContain('cold-tool (./tool.js): waiting for coldPresetHost')
    expect(f.ctx.agents.list()).toEqual([])
    expect(f.ctx.sessions.list()).toEqual([])
    expect(livePresetMounts(f.ctx.root.fiber)).toEqual([])
  } finally { f.release.resolve(undefined); await result }
})
