/** Human resume starts a fresh self-block interval through the real Loader and automatic goal driver. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
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
  ['goal/goal', { defaultMaxGoalRounds: 8 }], ['goal/tool-goal', { blockedAfterConsecutiveRounds: 3 }],
  ['goal/command-goal'], ['goal/goal-round-driver'],
]
const config = join(process.cwd(), 'cordis.yml')
await writeFile(config, JSON.stringify(plugins.map(([path, options]) => ({
  name: entry(path).href, ...(options === undefined ? {} : { config: options }),
}))))
const ctx = await boot('goal-resume-block-fixture', config)
let agent
const attempted = new Set()
class Adapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream() {
    const goal = ctx.goals.get(agent), round = goal.roundsStarted
    if (goal.phase === 'active' && round >= 3 && !attempted.has(round)) {
      attempted.add(round)
      const id = `block-${round}`, name = 'update_goal'
      const args = JSON.stringify({ goal_id: goal.id, revision: goal.revision, action: 'blocked', blocked_reason: 'Waiting for access.' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Round finished.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Round finished.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
function blockedAtOrAfter(round) {
  return new Promise(resolve => {
    const stop = ctx.on('agent/status', event => {
      if (event.agent !== agent || event.status !== 'idle') return
      const goal = ctx.goals.get(agent)
      if (goal.phase === 'blocked' && goal.roundsStarted >= round) { stop(); resolve(goal) }
    })
  })
}
try {
  ctx.llm.registerAdapter(['goal-fixture'], new Adapter())
  agent = await ctx.agentLoop.create(SessionId('goal-resume-block-fixture'), { provider: 'goal-fixture', model: 'fixture' })
  const signal = new AbortController().signal
  const first = blockedAtOrAfter(1)
  assert.equal((await ctx.commands.execute(agent, '/goal Continue until access is available.', [], signal)).result.kind, 'success')
  const before = await first
  assert.equal(before.roundsStarted, 3)
  const second = blockedAtOrAfter(4)
  assert.equal((await ctx.commands.execute(agent, '/goal resume', [], signal)).result.kind, 'success')
  const after = await second
  assert.equal(after.roundsStarted, 6)
  const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result'
    && event.data.message.toolCallId.startsWith('block-')).map(event => {
    const message = event.data.message, round = Number(message.toolCallId.slice(6)), accepted = message.isError !== true
    if (!accepted) {
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      assert.ok(text.includes(`current round is ${round - 3}`), text)
    }
    return { round, accepted }
  })
  assert.deepEqual(results, [{ round: 3, accepted: true }, { round: 4, accepted: false }, { round: 5, accepted: false }, { round: 6, accepted: true }])
  process.stdout.write(`${JSON.stringify({ operation: 'goal-resume-block-threshold', firstBlockedRound: before.roundsStarted,
    resumedBlockedRound: after.roundsStarted, results })}\n`)
} finally {
  if (agent !== undefined) ctx.goals.disarm(agent)
  await ctx.fiber.dispose()
}
