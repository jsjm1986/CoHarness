/** Mount the actual workflow provider and retain only the tool definition's disposer. */
export const inject = ['ptcRuntime', 'sandboxPolicy', 'workingDirectory', 'sessionProjections', 'tools', 'systemPrompt']
export async function apply(ctx) {
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const load = relative => import(new URL(`../../../../../packages/${relative}/${face}`, import.meta.url))
  await ctx.plugin((await load('subagent/subagent')).default)
  await ctx.plugin((await load('workflow/workflow-ptc')).default, { provider: 'record-child' })
  if (ctx.get('jobs') === undefined) await ctx.plugin((await load('jobs/jobs-local')).default)
  await ctx.plugin(await load('jobs/tool-jobs'))
  const tool = ctx.plugin(await load('workflow/tool-workflow'))
  await tool.await()
  ctx.provide('workflowRecordHost', { withdraw: () => tool.dispose() })
}
