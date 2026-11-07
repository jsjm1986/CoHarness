/** Two actual plan-review turns exercise live approval and a cancelled caller with a late answer. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Question lifecycle fixture requires src or lib')
const artifact = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
const entry = path => new URL(`../../../../${path}/${artifact}`, import.meta.url)
const { boot } = await import(entry('boot/app-boot'))
const { createUserMessage } = await import(entry('llm/llm'))
const { SessionId } = await import(entry('core/session'))
const sources = new Map([
  ['@deepseek-ai/dsh-session', 'core/session'], ['@deepseek-ai/dsh-agent', 'core/agent'],
  ['@deepseek-ai/dsh-llm', 'llm/llm'], ['@deepseek-ai/dsh-tools', 'core/tools'],
  ['@deepseek-ai/dsh-system-prompt', 'core/system-prompt'], ['@deepseek-ai/dsh-session-projection', 'session/session-projection'],
  ['@deepseek-ai/dsh-agent-loop', 'core/agent-loop'], ['@deepseek-ai/dsh-user-questions', 'interaction/user-questions'],
  ['@deepseek-ai/dsh-plan-mode', 'plan/plan-mode'],
])
const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/interaction/question-lifetime/cordis.yml', import.meta.url)
const plugins = JSON.parse(await readFile(fixture, 'utf8'))
const config = join(process.cwd(), 'cordis.yml')
await writeFile(config, JSON.stringify(plugins.map(plugin => {
  if (plugin.name.startsWith('./')) return { ...plugin, name: new URL(plugin.name, fixture).href }
  const source = sources.get(plugin.name)
  assert.ok(source, `No artifact selection for ${plugin.name}`)
  return { ...plugin, name: entry(source).href }
})))
const ctx = await boot('question-lifetime-fixture', config)
const approved = { answers: [{ id: 'plan-review', selected: ['Approve'] }] }
try {
  const state = ctx.get('fixtureQuestionLifetime')
  for (const kind of ['approved', 'cancelled']) {
    state.entered = Promise.withResolvers()
    const handle = await ctx.agents.create({ sessionId: SessionId(`question-lifetime-${kind}`),
      agentOptions: { provider: 'question-lifetime-fixture', model: 'local' } })
    let reply
    try {
      ctx.planMode.set(handle.agent, true)
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Review the implementation plan.' }] }))
      const entered = await state.entered.promise
      reply = entered.reply
      assert.equal(entered.request.agent, handle.agent)
      if (kind === 'cancelled') handle.agent.cancel({ kind: 'user' })
      reply.resolve(approved)
      await handle.agent.whenIdle()
      await setImmediate()
      const mode = ctx.planMode.get(handle.agent)
      assert.deepEqual(mode, { active: kind !== 'approved' })
      const calls = state.modelCalls.get(handle.agent.id)
      assert.equal(calls, kind === 'approved' ? 2 : 1)
      const events = handle.agent.session.snapshotEvents()
      const ending = events.findLast(event => event.type === 'turn/end')
      assert.equal(ending.data.reason.kind, kind === 'approved' ? 'completed' : 'aborted')
      process.stdout.write(`${JSON.stringify({ operation: `${kind}-review`, mode, modelRequests: calls,
        turn: ending.data.reason.kind, questionAborted: entered.request.signal.aborted })}\n`)
    } finally { reply?.resolve(approved); await handle.dispose() }
  }
} finally { await ctx.fiber.dispose() }
