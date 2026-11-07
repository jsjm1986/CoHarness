/** Select the actual subagent service inside the normal SDK profile. */
export const inject = ['workingDirectory', 'sessionProjections']
export async function apply(ctx) {
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const service = await import(new URL(`../../../../../packages/subagent/subagent/${face}`, import.meta.url))
  await ctx.plugin(service.default)
}
