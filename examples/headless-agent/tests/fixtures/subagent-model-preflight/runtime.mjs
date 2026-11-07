/** Own Core withdrawal independently of the live model adapter and SDK host. */
export const inject = ['tools', 'llm', 'workingDirectory', 'systemPrompt', 'sessionProjections']
export async function apply(ctx) {
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const load = relative => import(new URL(`../../../../../packages/${relative}/${face}`, import.meta.url))
  const core = ctx.plugin((await load('subagent/subagent')).default)
  await core.await()
  await ctx.plugin(await load('subagent/tool-subagent'), { provider: 'preflight-child', maxDepth: 'provider-managed',
    agentOptions: { provider: 'preflight-fixture', model: 'child-model' } })
  ctx.provide('preflightHost', {
    register: provider => ctx.get('subagents').registerProvider(provider),
    withdraw: () => core.dispose(),
  })
}
