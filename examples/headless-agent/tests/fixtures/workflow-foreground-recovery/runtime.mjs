/** Select matching product service, engine and foreground Consumers. */
export const inject = ['ptcRuntime', 'sandboxPolicy', 'workingDirectory', 'sessionProjections', 'tools', 'systemPrompt']

export async function apply(ctx) {
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const load = relative => import(new URL(`../../../../../packages/${relative}/${face}`, import.meta.url))
  const subagents = await load('subagent/subagent')
  await ctx.plugin(subagents.default)
  const engine = await load('workflow/workflow-ptc')
  const workflow = await load('workflow/tool-workflow')
  const ralph = await load('workflow/tool-ralph')
  await ctx.plugin(engine.default, { provider: 'foreground-child' })
  await ctx.plugin(workflow)
  await ctx.plugin(ralph, { subagentProvider: 'foreground-child', maxRounds: 1 })
}
