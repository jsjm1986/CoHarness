/** Host retains the real runtime fiber independently of its accepted callers. */
import assert from 'node:assert/strict'
export const inject = ['workingDirectory', 'sessionProjections']
export async function apply(ctx) {
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const service = await import(new URL(`../../../../../packages/subagent/subagent/${face}`, import.meta.url))
  const mount = async () => {
    const fiber = ctx.plugin(service.default)
    await fiber.await()
    const runtime = ctx.get('subagents')
    assert.ok(runtime)
    return { runtime, dispose: () => fiber.dispose() }
  }
  ctx.provide('drainingCleanupHost', { ...await mount(), mount })
}
