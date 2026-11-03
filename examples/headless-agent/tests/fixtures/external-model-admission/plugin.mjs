/** Actual delegation tools refuse external inference under parent model governance. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Codex from '@deepseek-ai/dsh-subagent-codex'
import * as Claude from '@deepseek-ai/dsh-subagent-claude-code'
import * as Acp from '@deepseek-ai/dsh-subagent-acp'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'

export const inject = ['llm', 'agents', 'workingDirectory', 'subprocess']

/** Mount real providers with no external allocation allowed by the fixture budget. */
export async function apply(ctx) {
  await ctx.plugin(Subagents)
  const stateDir = join(process.cwd(), '.external-bindings')
  await ctx.plugin(Codex, { stateDir })
  await ctx.plugin(Claude, { stateDir })
  await ctx.plugin(Acp, { stateDir, command: process.execPath, resume: true })
  ctx.provide('modelAccessRequired', true)
  ctx.provide('modelAccess', { decide: target => ({ allowed: target.provider === 'external-control-parent' }) })
  const admissions = [], released = [], uncertain = [], refusals = []
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('resourceBudget', { async acquire(request) {
    admissions.push(request.kind)
    assert.equal(request.kind, 'model', 'An unsupported external runtime must not allocate a process')
    return { signal: new AbortController().signal,
      async release() { released.push(request.kind) }, async uncertain() { uncertain.push(request.kind) } }
  } })
  const providers = ['codex', 'claude-code', 'acp']
  const tools = providers.map(provider => `delegate_${provider.replaceAll('-', '_')}`)
  ctx.on('agent/created', ({ agent }) => {
    for (const [index, provider] of providers.entries()) {
      agent.ctx.inject(ToolSubagent.inject, scope => ToolSubagent.apply(scope, {
        provider, toolName: tools[index], enableRunInBackground: false,
        maxDepth: 'provider-managed', modelSelectionSettings: false,
      }, agent.session))
    }
  })
  class Parent extends LlmAdapter {
    async *stream(options) {
      const results = options.messages.filter(message => message.role === 'tool')
      if (results.length === 0) {
        for (const [index, name] of tools.entries()) {
          const id = ToolCallId(name), args = JSON.stringify({ description: 'External task', prompt: 'Return one answer.' })
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id, name, argumentsDelta: args }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } }
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      assert.equal(results.length, 3)
      refusals.push(...results.map(result => result.content.filter(block => block.type === 'text').map(block => block.text).join('')))
      const text = 'EXTERNAL_MODELS_REFUSED'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['external-control-parent'], new Parent()))
  ctx.on('agent/turn-stopping', ({ agent }) => appendPluginRecord(agent.session, 'plugin:external-model-admission/complete', {
    providers, admissions, released, uncertain, refusals,
  }))
  ctx.provide('externalModelAdmissionReady', true)
}
