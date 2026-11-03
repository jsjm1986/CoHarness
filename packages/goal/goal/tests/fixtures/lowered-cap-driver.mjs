/** User budget reduction after real goal rounds preserves checkpoint and lifetime accounting. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Goal fixture requires src or lib')
const artifact = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
const entry = path => new URL(`../../../../${path}/${artifact}`, import.meta.url)
const { boot } = await import(entry('boot/app-boot'))
const { LlmAdapter } = await import(entry('llm/llm'))
const { SessionId } = await import(entry('core/session'))
const plugins = [
  ['core/session'], ['core/agent'], ['llm/llm'], ['core/tools'], ['core/system-prompt'],
  ['session/session-projection'], ['core/agent-loop', { agents: [] }], ['interaction/commands'],
  ['goal/goal', { defaultMaxGoalRounds: 4 }], ['goal/command-goal'], ['goal/goal-round-driver'],
]
const config = join(process.cwd(), 'cordis.yml')
await writeFile(config, JSON.stringify(plugins.map(([path, options]) => ({
  name: entry(path).href, ...(options === undefined ? {} : { config: options }),
}))))
const ctx = await boot('goal-lowered-cap-fixture', config)
const arrived = Promise.withResolvers(), release = Promise.withResolvers()
let agent
class Adapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream() {
    if (ctx.goals.get(agent).roundsStarted === 2) { arrived.resolve(); await release.promise }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Round finished.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Round finished.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
try {
  ctx.llm.registerAdapter(['goal-fixture'], new Adapter())
  agent = await ctx.agentLoop.create(SessionId('goal-lowered-cap-fixture'), { provider: 'goal-fixture', model: 'fixture' })
  const signal = new AbortController().signal
  assert.equal((await ctx.commands.execute(agent, '/goal Finish the work within budget.', [], signal)).result.kind, 'success')
  await arrived.promise
  assert.equal((await ctx.commands.execute(agent, '/goal pause', [], signal)).result.kind, 'success')
  const lowered = ctx.goals.edit(agent, ctx.goals.get(agent), { maxGoalRounds: 1 })
  release.resolve()
  await agent.whenIdle()
  assert.equal(lowered.roundsStarted, 2)
  assert.equal((await ctx.commands.execute(agent, '/goal resume', [], signal)).result.kind, 'error')
  const stored = join(process.cwd(), 'projection.json')
  await writeFile(stored, JSON.stringify(ctx.sessionProjections.checkpoint(agent.session)))
  const checkpoint = JSON.parse(await readFile(stored, 'utf8'))
  const floor = ctx.sessionProjections.restoreFloor(checkpoint)
  assert.notEqual(floor, undefined)
  const restored = ctx.sessionProjections.restore(checkpoint, agent.session.snapshotEvents().slice(floor),
    floor, agent.session.header, agent.session.inheritedEventCount)
  assert.equal(restored.snapshot.values.goal.roundsStarted, 2)
  assert.equal(restored.snapshot.values.goal.goal.maxGoalRounds, 1)
  const finished = new Promise(resolve => {
    const stop = ctx.on('goal/changed', event => {
      if (event.agent !== agent || event.change.operation !== 'block') return
      stop(); resolve(ctx.goals.get(agent))
    })
  })
  ctx.goals.edit(agent, lowered, { maxGoalRounds: 3 })
  assert.equal((await ctx.commands.execute(agent, '/goal resume', [], signal)).result.kind, 'success')
  const final = await finished
  assert.equal(final.roundsStarted, 3)
  assert.equal(final.blockedReason.code, 'round-limit')
  process.stdout.write(`${JSON.stringify({ operation: 'goal-lowered-cap', admittedBeforeEdit: lowered.roundsStarted,
    loweredCap: lowered.maxGoalRounds, restoredRoundCount: restored.snapshot.values.goal.roundsStarted,
    exhaustedResumeRejected: true, finalRounds: final.roundsStarted, finalCap: final.maxGoalRounds,
    finalPhase: final.phase, finalReason: final.blockedReason.code })}\n`)
} finally {
  release.resolve()
  if (agent !== undefined) ctx.goals.disarm(agent)
  await ctx.fiber.dispose()
}
