/** Real standing-preset creation with a deterministic model response. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, deriveEventMessage, type SessionMessageProjection } from '@deepseek-ai/dsh-session'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'

import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as SubagentTool from '@deepseek-ai/dsh-tool-subagent'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'fixture/project': { seq: SessionSeq }
  }
}
class PresetAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!options.tools?.some(tool => tool.name === 'subagent')) throw new Error('first request lacks preset tool')
    if (!options.messages.some(message => message.content.some(block => block.type === 'text' && block.text === 'Projected preset request.'))) {
      throw new Error('request lacks projected message')
    }
    const text = 'First request includes subagent and projected input.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'serial-preset-fixture'
export const inject = ['agents', 'agentLoop', 'llm', 'tools', 'sessions', 'subagents', 'subagentModelSelection']

/**
 * Create a preset-bound Agent after proving a conflicting installation rolls back.
 * @param ctx - Loader-owned runtime services.
 * @returns after successful Agent publication.
 */
export async function apply(ctx: Context): Promise<void> {
  const projection: SessionMessageProjection<'fixture/project'> = {
    type: 'fixture/project',
    project(event, history) {
      const source = history.events[event.data.seq - history.baseSeq]!
      const message = deriveEventMessage(source, history.messages)!
      return new Map([[source.seq, deepFreeze({
        ...message, content: [{ type: 'text' as const, text: 'Projected preset request.' }],
      })]])
    },
  }
  ctx.sessions.registerMessageProjection(projection)
  ctx.on('agent/message-entered', ({ agent, event }) => {
    agent.session.append('fixture/project', { seq: event.seq })
    if (event.data.content[0]?.type !== 'text' || event.data.content[0].text !== 'Inspect the preset.') {
      throw new Error('projection mutated the durable input')
    }
  })
  ctx.effect(() => ctx.llm.registerAdapter(['preset-mock'], new PresetAdapter()))
  const preset = createScope(ctx, { preset: 'serial-preset' })
  ctx.effect(() => () => preset.ctx.fiber.dispose())
  await preset.ctx.plugin(SubagentTool, { provider: 'spawn', modelSelectionSettings: true, backgroundMode: 'continuable' })
  const sessionId = SessionId('serial-preset')
  const originalError = ctx.logger.error
  ctx.logger.error = () => {}
  let rejected = false
  try {
    await ctx.agents.create({
      sessionId,
      setup(agentCtx) {
        bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!)
        agentCtx.tools.register(defineContentToolFixture({
          name: 'subagent', description: 'occupied', parameters: {}, execute: async () => [],
        }))
      },
    })
  } catch (error: unknown) {
    if (!(error instanceof Error) || !error.message.includes('subagent')) throw error
    rejected = true
  } finally {
    ctx.logger.error = originalError
  }
  if (!rejected || ctx.agents.list().length !== 0 || ctx.sessions.list().length !== 0) {
    throw new Error('preset failure did not roll back Agent and Session')
  }
  process.stdout.write('Conflicting preset rejected; Agent and Session rolled back.\n')
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: 'preset-mock', model: 'preset-mock' },
    setup(agentCtx) { bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!) },
  })
  ctx.effect(() => () => handle.dispose())
}
