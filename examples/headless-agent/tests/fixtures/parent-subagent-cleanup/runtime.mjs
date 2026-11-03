/** Replace only Core while retaining the original Agent and reloading real dependent Consumers. */
export const inject = ['ptcRuntime', 'sandboxPolicy', 'workingDirectory', 'sessionProjections', 'tools', 'systemPrompt']
export async function apply(ctx) {
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const load = relative => import(new URL(`../../../../../packages/${relative}/${face}`, import.meta.url))
  const Core = (await load('subagent/subagent')).default
  let core = ctx.plugin(Core)
  await core.await()
  const engine = ctx.plugin((await load('workflow/workflow-ptc')).default, { provider: 'retained-child' })
  await engine.await()
  const workflow = ctx.plugin(await load('workflow/tool-workflow'))
  await workflow.await()
  const ralph = ctx.plugin(await load('workflow/tool-ralph'), { subagentProvider: 'retained-child', maxRounds: 1 })
  await ralph.await()
  ctx.provide('parentCleanupHost', {
    register: provider => ctx.get('subagents').registerProvider(provider),
    replace: async provider => {
      await core.dispose()
      core = ctx.plugin(Core)
      await core.await()
      ctx.get('subagents').registerProvider(provider)
      await engine.await()
      await workflow.await()
      await ralph.await()
    },
  })
}
