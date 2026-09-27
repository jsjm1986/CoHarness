/** Read-only Cordis discovery and rejection through the real tool executor. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CordisHostRunner from '@deepseek-ai/dsh-cordis-host-runner'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished } from 'vitest'
import * as ToolCordis from '../src/index.ts'

const RETIRED = ['cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine'] as const

async function setup() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CordisHostRunner)
  const fiber = await ctx.plugin(ToolCordis)
  const id = SessionId('cordis-inspection')
  const agent = { id, ctx, session: ctx.sessions.create(id) } as Agent
  const execute = (name: string, args: Record<string, unknown> = {}) => ctx.tools.execute({
    name,
    callId: ToolCallId(`inspect-${name}`),
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
  return { ctx, fiber, agent, execute }
}

it('lists and queries callable tools without creating a dynamic definition', async () => {
  const { ctx, agent, execute } = await setup()
  expect((await execute('cordis_inspect_list')).isError).toBe(false)
  const result = await execute('cordis_inspect_query', {
    platform: 'host', provider: 'Tool', method: 'listTools',
  })
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('inspection failed')
  expect(result.value).toMatchObject({ platform: 'host', provider: 'Tool', method: 'listTools' })
  expect(ctx.tools.schemas(agent).map(tool => tool.name)).toEqual([
    'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',
  ])
  expect(ctx.dynamicCordisRunner.listPlugins(agent)).toEqual([])
})

it.each(RETIRED)('rejects %s through the executor without a hidden registration', async (name) => {
  const { ctx, agent, execute } = await setup()
  const result = await execute(name, {
    plugin: { kind: 'new', idPrefix: 'probe' },
    name: 'Unreachable plugin', purpose: 'Must not be registered',
    code: { host: 'return { apply() { throw new Error("must not execute") } }' },
    pluginId: 'probe-1', packageId: 'pkg-1', mode: 'run',
  })
  expect(result).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
  expect(ctx.dynamicCordisRunner.listPlugins(agent)).toEqual([])
})

it('does not turn an inspection query into a business service invocation', async () => {
  const { ctx, agent, execute } = await setup()
  const result = await execute('cordis_inspect_query', {
    platform: 'host', provider: 'Service', method: 'define',
    input: { name: 'Unreachable definition', code: { host: 'return { apply() {} }' } },
  })
  expect(result.isError).toBe(true)
  expect(result.error?.message).toContain('define')
  expect(ctx.dynamicCordisRunner.listPlugins(agent)).toEqual([])
})

it('reads retained Package source without activating that definition', async () => {
  const { ctx, agent, execute } = await setup()
  const code = 'return { apply() { throw new Error("inspection must not execute") } }'
  const definition = ctx.dynamicCordisRunner.define({
    sessionId: agent.id, plugin: { kind: 'new', idPrefix: 'read' },
    name: 'Retained source', purpose: 'Inspect a programmatically registered definition', code: { host: code },
  })
  const result = await execute('cordis_inspect_self', {
    pluginId: definition.pluginId, packageId: definition.packageId,
  })
  expect(result).toMatchObject({ isError: false, value: { mode: 'package', code: { host: code } } })
  expect((await ctx.dynamicCordisRunner.inventory())[0]?.activeRun).toBeUndefined()
})

it('removes inspection tools and providers when their owning plugin unloads', async () => {
  const { ctx, fiber, agent, execute } = await setup()
  await fiber.dispose()
  expect(ctx.tools.schemas(agent)).toEqual([])
  expect(ctx.cordisInspect.list()).toEqual([])
  expect(await execute('cordis_inspect_query', { platform: 'host', provider: 'Tool', method: 'listTools' }))
    .toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
})
