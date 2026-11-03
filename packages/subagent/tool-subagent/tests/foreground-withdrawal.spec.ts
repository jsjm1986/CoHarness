/** Foreground result collection hands cleanup back before its runtime scope can finish. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentCarrier } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it } from 'vitest'
import * as tool from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

it.each(['completed', 'rejected'] as const)('joins foreground %s result and transferred cleanup during withdrawal', async (mode) => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  provideWorkingDirectoryFixture(ctx)
  const runtime = ctx.plugin(SubagentRuntime)
  await runtime.await()
  await ctx.plugin(AgentRegistry)
  const published = Promise.withResolvers<undefined>(), stopping = Promise.withResolvers<undefined>()
  const result = Promise.withResolvers<SubagentResult>()
  let resourceLive = true, attempts = 0, starts = 0, childSignal: AbortSignal | undefined
  const release = async () => { if (++attempts === 1) throw new Error('child cleanup needs retry'); resourceLive = false }
  ctx.subagents.registerProvider({ name: 'foreground-child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async (spec) => {
      starts++
      childSignal = spec.signal
      return { id: SessionId('foreground-withdrawal-child'), localAgent: undefined, result: result.promise, dispose: release }
    } })
  ctx.on('subagent/start', () => { published.resolve(undefined) }, { global: true })
  runtime.ctx.effect(() => () => { stopping.resolve(undefined) })
  await ctx.plugin(tool, { provider: 'foreground-child', enableRunInBackground: false, maxDepth: 'provider-managed' })
  const parent = { id: SessionId('foreground-withdrawal-parent'), ctx: ctx.plugin(() => {}).ctx, options: {},
    session: Session.create(SessionId('foreground-withdrawal-parent')) } as unknown as Agent
  ctx.agents.register(parent)
  const execution = ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('foreground-withdrawal'),
    name: 'subagent', arguments: { description: 'owned foreground', prompt: 'work' }, agent: parent })
  let withdrawal: Promise<boolean> | undefined
  try {
    await published.promise
    withdrawal = runtime.dispose().then(() => !resourceLive)
    await stopping.promise
    expect(childSignal?.aborted).toBe(true)
    expect(ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent })).toBe('busy')
    if (mode === 'completed') result.resolve({ output: [{ type: 'text', text: 'partial child answer' }], stopReason: 'completed' })
    else result.reject(new Error('child result unavailable'))
    expect((await execution).isError).toBe(true)
    expect(await withdrawal).toBe(true)
    expect(attempts).toBe(2)
    expect(starts).toBe(1)
  } finally {
    result.resolve({ output: [], stopReason: 'completed' })
    await execution
    await withdrawal
    await release()
  }
})
