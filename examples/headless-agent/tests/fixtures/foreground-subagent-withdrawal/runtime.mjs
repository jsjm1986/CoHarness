/** Real Core and foreground tool share the ordinary Loader and parent service namespace. */
export const inject = ['workingDirectory', 'sessionProjections', 'tools', 'systemPrompt']
export async function apply(ctx) {
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const core = await import(new URL(`../../../../../packages/subagent/subagent/${face}`, import.meta.url))
  const consumer = await import(new URL(`../../../../../packages/subagent/tool-subagent/${face}`, import.meta.url))
  const fiber = ctx.plugin(core.default)
  await fiber.await()
  await ctx.plugin(consumer, { provider: 'foreground-child', enableRunInBackground: false, modelSelectionSettings: false, maxDepth: 'provider-managed' })
  ctx.provide('foregroundWithdrawalHost', { runtime: ctx.get('subagents'), dispose: () => fiber.dispose(), observe: callback => fiber.ctx.effect(() => callback) })
}
