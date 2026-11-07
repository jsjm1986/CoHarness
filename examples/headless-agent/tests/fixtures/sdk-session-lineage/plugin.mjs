/** Real three-level delegation for SDK ancestry and queue limits. */
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'

export const inject = ['llm', 'agents', 'workingDirectory']

/** Install scoped delegation tools and a deterministic model at every level. */
export async function apply(ctx) {
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'owned-spawn' })
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.inject(ToolSubagent.inject, scope => ToolSubagent.apply(scope, { provider: 'owned-spawn',
      enableRunInBackground: false, maxDepth: 3, modelSelectionSettings: false,
    }, agent.session))
  })
  class Adapter extends LlmAdapter {
    async *stream(options) {
      const hasPrompt = text => options.messages.some(message => message.role === 'user'
        && message.content.some(block => block.type === 'text' && block.text === text))
      const level = hasPrompt('grandchild') ? 'grandchild' : hasPrompt('child') ? 'child' : 'root'
      if (level !== 'grandchild' && !options.messages.some(message => message.role === 'tool')) {
        const id = ToolCallId(`delegate-${level}`), name = 'subagent'
        const args = JSON.stringify({ description: `Owned ${level} delegation`, prompt: level === 'root' ? 'child' : 'grandchild' })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const text = level === 'root' ? 'SDK_LINEAGE_DONE' : `${level.toUpperCase()}_DONE`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['sdk-lineage'], new Adapter()))
}
