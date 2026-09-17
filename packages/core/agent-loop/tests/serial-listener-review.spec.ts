/** Rollback when a real preset consumer rejects serial Agent initialization. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentTool from '@deepseek-ai/dsh-tool-subagent'
import Selection from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'

describe('serial creation listener integrations', () => {
  it('rolls back creation when a shared preset tool installation fails', async () => {
    const ctx = new Context()
    const errors = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(Selection)
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
      const preset = createScope(ctx, { preset: 'review' })
      await preset.ctx.plugin(SubagentTool, {
        provider: 'spawn',
        modelSelectionSettings: true,
        backgroundMode: 'continuable',
      })
      const sessionId = SessionId('review-tool')
      await expect(ctx.agents.create({
        sessionId,
        setup(agentCtx) {
          bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!)
          agentCtx.tools.register(defineContentToolFixture({
            name: 'subagent',
            description: 'occupied',
            parameters: {},
            execute: () => Promise.resolve([]),
          }))
        },
      })).rejects.toThrow('subagent')
      expect(errors.mock.calls.some(args => args.some(error => String(error).includes('subagent')))).toBe(true)
      expect(ctx.agents.list()).toEqual([])
      expect(ctx.sessions.list()).toEqual([])
      const handle = await ctx.agents.create({
        sessionId,
        setup(agentCtx) {
          bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!)
        },
      })
      expect(ctx.tools.schemas(handle.agent).some(tool => tool.name === 'subagent')).toBe(true)
      await handle.dispose()
      expect(ctx.agents.list()).toEqual([])
      expect(ctx.sessions.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      errors.mockRestore()
    }
  })
})
