/** Select normal source or published workflow entries inside the SDK profile. */
export const inject = ['subagents', 'ptcRuntime', 'sandboxPolicy', 'workingDirectory', 'tools', 'systemPrompt']

/** Mount the product workflow implementation and its normal tool Consumer. */
export async function apply(ctx) {
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const engine = await import(new URL(`../../../../../packages/workflow/workflow-ptc/${face}`, import.meta.url))
  const tool = await import(new URL(`../../../../../packages/workflow/tool-workflow/${face}`, import.meta.url))
  await ctx.plugin(engine.default, { provider: 'cleanup-child' })
  await ctx.plugin(tool)
}
