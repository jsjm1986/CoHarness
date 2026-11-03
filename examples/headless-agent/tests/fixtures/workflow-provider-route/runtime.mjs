/** Mount the ordinary workflow engine and opt-in Ralph Consumer. */
export const inject = ['subagents', 'ptcRuntime', 'sandboxPolicy', 'workingDirectory', 'tools', 'systemPrompt']

export async function apply(ctx) {
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const engine = await import(new URL(`../../../../../packages/workflow/workflow-ptc/${face}`, import.meta.url))
  const ralph = await import(new URL(`../../../../../packages/workflow/tool-ralph/${face}`, import.meta.url))
  await ctx.plugin(engine.default, { provider: 'route-child' })
  await ctx.plugin(ralph, { subagentProvider: 'route-child', maxRounds: 2 })
}
