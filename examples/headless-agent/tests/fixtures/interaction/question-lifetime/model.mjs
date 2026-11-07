/** A local model requests one plan review per Agent; its answerer exposes a controlled external reply. */
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'question-lifetime-model'
export const inject = ['llm', 'userQuestions']

export function apply(ctx) {
  const state = { entered: Promise.withResolvers(), replies: new Set(), modelCalls: new Map() }
  ctx.effect(() => ctx.provide('fixtureQuestionLifetime', state))
  class Model extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, defaultMaxTokens: 64 } }
    async *stream(options) {
      const calls = (state.modelCalls.get(options.sessionId) ?? 0) + 1
      state.modelCalls.set(options.sessionId, calls)
      if (calls === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('plan-review'),
          name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# Implementation plan\n\nImplement the requested task.' }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'AFTER_REVIEW' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['question-lifetime-fixture'], new Model()))
  ctx.on('user-questions/request', async (request) => {
    const reply = Promise.withResolvers()
    state.replies.add(reply)
    state.entered.resolve({ request, reply })
    try { return await reply.promise }
    finally { state.replies.delete(reply) }
  })
  ctx.effect(() => () => {
    for (const reply of state.replies) reply.resolve({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
  })
}
