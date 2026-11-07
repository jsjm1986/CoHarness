/** Goal commands across asynchronous authorization in a runnable Loader application. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Goal fixture requires src or lib')
const artifact = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
const entry = path => new URL(`../../../../${path}/${artifact}`, import.meta.url)
const { boot } = await import(entry('boot/app-boot'))
const { SessionId } = await import(entry('core/session'))
const plugins = [
  ['core/session'], ['core/agent'], ['llm/llm'], ['core/tools'], ['core/system-prompt'],
  ['session/session-projection'], ['core/agent-loop', { agents: [] }],
  ['interaction/commands'], ['goal/goal'], ['goal/command-goal'],
]
const config = join(process.cwd(), 'cordis.yml')
await writeFile(config, JSON.stringify(plugins.map(([path, options]) => ({
  name: entry(path).href, ...(options === undefined ? {} : { config: options }),
}))))
const ctx = await boot('goal-admission-fixture', config)
ctx.provide('executionAuthorityRequired', true)
try {
  for (const change of ['cancelled', 'replaced']) {
    const agent = await ctx.agentLoop.create(SessionId(`goal-admission-${change}`))
    const entered = Promise.withResolvers(), proceed = Promise.withResolvers(), finished = Promise.withResolvers()
    const authority = { async runRequest(owner, input, work) {
      assert.equal(owner, agent)
      assert.deepEqual(input, { command: 'goal', input: ' new objective', attachments: [] })
      entered.resolve()
      await proceed.promise
      try { return await work() } finally { finished.resolve() }
    } }
    let remove = ctx.provide('executionAuthority', authority)
    const controller = new AbortController()
    const cancelled = new Error('Fixture goal command cancelled')
    const outcome = ctx.commands.execute(agent, '/goal new objective', [], controller.signal)
      .then(result => ({ result }), error => ({ error }))
    try {
      await entered.promise
      if (change === 'cancelled') controller.abort(cancelled)
      else { remove(); remove = ctx.provide('executionAuthority', { ...authority }) }
      proceed.resolve()
      await finished.promise
      const result = await outcome
      assert.equal(ctx.goals.get(agent), undefined)
      if (change === 'cancelled') assert.equal(result.error, cancelled)
      else assert.equal(result.error.message, 'The execution authority changed before applying the goal command.')
      const events = agent.session.snapshotEvents()
      assert.deepEqual(events.map(event => event.type), ['command/run', 'command/done'])
      assert.equal(events.at(-1).data.kind, 'error')
      process.stdout.write(`${JSON.stringify({ operation: 'goal-command', admission: change, storedGoal: false, lifecycle: ['command/run', 'command/done'], result: 'error' })}\n`)
    } finally { proceed.resolve(); await outcome; remove() }
  }
} finally { await ctx.fiber.dispose() }
