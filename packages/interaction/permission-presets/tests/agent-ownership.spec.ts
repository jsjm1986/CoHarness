/** Late permission decisions cannot mutate a disposed or replaced Agent's Session. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import Approval from '@deepseek-ai/dsh-user-approval'
import PermissionPresets from '../src/index.ts'
import { expect, it, onTestFinished } from 'vitest'

it.each(['disposed', 'replaced', 'registry-withdrawn'] as const)('refuses an authorized permission command after its Agent is %s', async (kind) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRuntime)
  const registry = await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Approval)
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('The permission fixture cannot execute shell commands.') },
    run() { throw new Error('The permission fixture cannot execute shell commands.') },
    start() { throw new Error('The permission fixture cannot execute shell commands.') },
  })
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  ctx.provide('permissionPresetAuthorization', {
    canSelect: () => true,
    async authorizeSelection() { entered.resolve(undefined); await release.promise },
  })
  await ctx.plugin(PermissionPresets)
  ctx.permissionPresets.registerAuto(() => {})
  const handle = await ctx.agents.create({ sessionId: SessionId('permission-owner') })
  let replacement: Awaited<ReturnType<typeof ctx.agents.create>> | undefined
  const state = () => handle.agent.session.snapshotEvents().filter(event =>
    event.type === 'permission/preset' || event.type === 'sandbox/mode' || event.type === 'approval/policy')
  const before = state()
  const pending = ctx.commands.execute(handle.agent, '/permission auto', [], new AbortController().signal)
  const result = pending.then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    await entered.promise
    if (kind === 'registry-withdrawn') await registry.dispose()
    else await handle.dispose()
    if (kind === 'replaced') replacement = await ctx.agents.create({ sessionId: handle.agent.id })
    release.resolve(undefined)
    expect(await result).toHaveProperty('error.message', "permission: the command's Agent is no longer active")
    expect(state()).toEqual(before)
    if (replacement !== undefined) expect(ctx.permissionPresets.current(replacement.agent.session)).toBe('workspace-write')
  } finally {
    release.resolve(undefined)
    await result
    await replacement?.dispose()
    await handle.dispose()
  }
})
