/** A completed review cannot mutate plan selection after its caller or Agent is withdrawn. */
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import UserQuestionService, { type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { expect, it, onTestFinished } from 'vitest'
import PlanModeController, { EXIT_PLAN_MODE } from '../src/index.ts'

it.each(['cancelled', 'disposed', 'replaced', 'registry-withdrawn'] as const)('keeps plan mode when the review caller is %s after answering', async (kind) => {
  const ctx = new Context(), controller = new AbortController()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const registry = await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(PlanModeController, { section: 'Review the plan before implementation.' })
  const handle = await ctx.agents.create({ sessionId: SessionId(`plan-review-owner-${kind}`) })
  let replacement: Awaited<ReturnType<typeof ctx.agents.create>> | undefined
  class Review extends UserQuestionService {
    override async ask(request: AskUserQuestionRequest) {
      const answer = await super.ask(request)
      if (kind === 'cancelled') controller.abort(new Error('Plan review cancelled before applying the answer'))
      else if (kind === 'registry-withdrawn') await registry.dispose()
      else {
        await handle.dispose()
        if (kind === 'replaced') replacement = await ctx.agents.create({ sessionId: handle.agent.id })
      }
      return answer
    }
  }
  await ctx.plugin(Review)
  ctx.on('user-questions/request', async () => ({ answers: [{ id: 'plan-review', selected: ['Approve'] }] }))
  ctx.planMode.set(handle.agent, true)
  try {
    const result = await ctx.tools.execute({ callId: ToolCallId('review-owner'), name: EXIT_PLAN_MODE,
      arguments: { plan: '# Approved plan\n\nImplement the approved task.' }, agent: handle.agent, signal: controller.signal })
    await setImmediate()
    expect(ctx.planMode.get(handle.agent)).toEqual({ active: true })
    expect(result.isError).toBe(true)
    if (replacement !== undefined) expect(ctx.planMode.get(replacement.agent)).toEqual({ active: false })
  } finally { await replacement?.dispose(); await handle.dispose() }
})
