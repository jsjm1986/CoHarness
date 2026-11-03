/** Loopback accountant and deterministic model for an actual SDK parent composition. */
export const name = 'sdk-completion-parent-fixture'
export const inject = ['llm']
export async function apply(ctx, config) {
  const [{ default: ResourceBudget }, { LlmAdapter }] = await Promise.all([import(config.budgetEntry), import(config.llmEntry)])
  async function post(path, body) {
    const response = await fetch(new URL(path, config.endpoint), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
    const value = await response.json()
    if (!response.ok) throw new Error('Accountant temporarily unavailable.')
    return value
  }
  class Budget extends ResourceBudget {
    async acquire(request) {
      const { id, cancelled } = await post('acquire', { kind: request.kind, sessionId: request.sessionId, origin: request.origin })
      const controller = new AbortController()
      if (cancelled) controller.abort(new Error('Fixture grant withdrawn before child publication.'))
      return { signal: controller.signal, release: () => post('release', { id }), uncertain: () => post('uncertain', { id }) }
    }
  }
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['completion-fixture'], new Adapter()))
  ctx.effect(() => ctx.provide('resourceBudgetRequired', true))
  await ctx.plugin(Budget)
}
