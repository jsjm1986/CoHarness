/** Local model and title providers expose deterministic request barriers for two independent Loader trees. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'

export const name = 'request-origin-model'
export const inject = ['llm', 'sessionTitle']

export function apply(ctx) {
  const state = { requests: [], captured: Promise.withResolvers(), hold: undefined, titleCalls: 0 }
  ctx.effect(() => ctx.provide('fixtureRequestOrigin', state))
  class Model extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 64 }
    }
    async *stream() {
      await state.hold?.promise
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'LOCAL_REPLY' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['request-origin-fixture'], new Model()))
  ctx.sessionTitle.register({
    id: SessionTitleProviderId('request-origin-fixture'), automatic: 'all-prompts',
    async generate(request) {
      state.titleCalls++
      return { title: `Revision ${state.titleCalls}`, messageSeqs: request.messages.map(message => message.seq) }
    },
  })
  ctx.on('llm/stream', (request, next) => {
    state.requests.push(request)
    state.captured.resolve(request)
    return next()
  })
  ctx.effect(() => () => { state.hold?.resolve() })
}
