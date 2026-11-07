/** Child model metadata preflight belongs to the admitting subagent runtime. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })


async function contextWithCore() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  provideWorkingDirectoryFixture(ctx)
  const runtime = ctx.plugin(SubagentRuntime)
  await runtime.await()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolJobs, {})
  return { ctx, runtime }
}

it.each(['foreground', 'background', 'continuable'] as const)('cancels pending %s child route preflight on runtime withdrawal', async (mode) => {
  const { ctx, runtime } = await contextWithCore()
  const entered = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
  const stopping = Promise.withResolvers<undefined>()
  let starts = 0
  const adapter = new MockAdapter([]), resolveModel = adapter.resolveModel.bind(adapter)
  vi.spyOn(adapter, 'resolveModel').mockImplementation(async (provider, model) => {
    entered.resolve(undefined); await finish.promise
    return resolveModel(provider, model)
  })
  ctx.llm.registerAdapter(['alpha'], adapter)
  const resolved = vi.spyOn(ctx.llm, 'resolveCallConfig')
  ctx.subagents.registerProvider({ name: 'preflight-child', inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: false },
    prepareContinuable: async () => { starts++; throw new Error('Cancelled metadata must not prepare a continuable child') },
    start: async () => {
      starts++
      return { id: SessionId('preflight-child'), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' as const }), dispose: async () => {} }
    } })
  runtime.ctx.effect(() => () => { stopping.resolve(undefined) })
  await ctx.plugin(tool, { provider: 'preflight-child', backgroundMode: mode === 'continuable' ? 'continuable' : 'one-shot', maxDepth: 'provider-managed', agentOptions: { provider: 'alpha', model: 'child-model' } })
  const parent = { id: SessionId('preflight-owner'), ctx: ctx.plugin(() => {}).ctx, options: {},
    session: Session.create(SessionId('preflight-owner')) } as unknown as Agent
  ctx.agents.register(parent)
  const execution = ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('pending-preflight'), name: 'subagent',
    arguments: { description: 'preflight', prompt: 'work', run_in_background: mode !== 'foreground' }, agent: parent })
  let withdrawal: Promise<void> | undefined
  try {
    await entered.promise
    const signal = resolved.mock.calls[0]?.[1]
    expect(signal).toBeDefined()
    withdrawal = Promise.resolve(runtime.dispose())
    await stopping.promise
    await expect.poll(() => signal?.aborted).toBe(true)
    finish.resolve(undefined)
    expect((await execution).isError).toBe(true)
    expect(starts).toBe(0)
    await withdrawal
  } finally {
    finish.resolve(undefined)
    await execution
    await withdrawal
  }
})

it('keeps a published background child independently cancellable after original Runtime withdrawal', async () => {
  const { ctx, runtime } = await contextWithCore()
  const published = Promise.withResolvers<undefined>(), result = Promise.withResolvers<SubagentResult>()
  let resourceLive = true, childSignal: AbortSignal | undefined
  ctx.subagents.registerProvider({ name: 'published-background', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async (spec) => {
      childSignal = spec.signal
      const cancel = () => { result.resolve({ output: [], stopReason: 'aborted' }) }
      spec.signal.addEventListener('abort', cancel, { once: true })
      return { id: SessionId('published-background-child'), localAgent: undefined, result: result.promise,
        dispose: async () => { spec.signal.removeEventListener('abort', cancel); resourceLive = false } }
    } })
  ctx.on('subagent/start', () => { published.resolve(undefined) }, { global: true })
  await ctx.plugin(tool, { provider: 'published-background', maxDepth: 'provider-managed' })
  const parent = { id: SessionId('published-background-owner'), ctx: ctx.plugin(() => {}).ctx, options: {},
    session: Session.create(SessionId('published-background-owner')) } as unknown as Agent
  ctx.agents.register(parent)
  const accepted = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('published-background'), name: 'subagent',
    arguments: { description: 'owned background', prompt: 'work', run_in_background: true }, agent: parent })
  expect(accepted.isError).toBe(false)
  const { jobId } = accepted.value as { jobId: JobId }
  try {
    await published.promise
    await runtime.dispose()
    expect(childSignal?.aborted).toBe(false)
    expect(resourceLive).toBe(true)
    expect(ctx.jobs.kill(jobId, parent.id, 'stop original background holder')).toBe('requested')
    expect((await ctx.jobs.wait(jobId, 5_000, parent.id)).status).toBe('killed')
    expect(resourceLive).toBe(false)
  } finally {
    result.resolve({ output: [], stopReason: 'completed' })
    if (resourceLive) { ctx.jobs.kill(jobId, parent.id, 'test cleanup'); await ctx.jobs.wait(jobId, 5_000, parent.id) }
  }
})
