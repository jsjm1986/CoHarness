/** Keep actual Core, workflow engine and Consumers in their ordinary service scope. */
export const inject = ['ptcRuntime', 'sandboxPolicy', 'workingDirectory', 'sessionProjections', 'tools', 'systemPrompt']
export async function apply(ctx) {
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const load = relative => import(new URL(`../../../../../packages/${relative}/${face}`, import.meta.url))
  const fiber = ctx.plugin((await load('subagent/subagent')).default)
  await fiber.await()
  await ctx.plugin((await load('workflow/workflow-ptc')).default, { provider: 'withdrawal-child' })
  await ctx.plugin(await load('workflow/tool-workflow'))
  await ctx.plugin(await load('workflow/tool-ralph'), { subagentProvider: 'withdrawal-child', maxRounds: 1 })
  ctx.provide('workflowWithdrawalHost', { runtime: ctx.get('subagents'), dispose: () => fiber.dispose(), observe: callback => fiber.ctx.effect(() => callback) })
}
