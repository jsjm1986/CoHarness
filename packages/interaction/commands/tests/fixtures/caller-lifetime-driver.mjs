/** Real Agent disposal and idle retirement while command image admission is pending. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Command fixture requires src or lib')
const artifact = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
const entry = path => new URL(`../../../../${path}/${artifact}`, import.meta.url)
const { boot } = await import(entry('boot/app-boot'))
const { SessionId } = await import(entry('core/session'))
const plugins = [
  ['core/session'], ['core/agent'], ['llm/llm'], ['core/tools'], ['core/system-prompt'],
  ['session/session-projection'], ['core/agent-loop', { agents: [] }], ['interaction/commands'],
  ['attachment/attachment-local', { dshHome: join(process.cwd(), '.dsh') }],
]
const config = join(process.cwd(), 'cordis.yml')
await writeFile(config, JSON.stringify(plugins.map(([path, options]) => ({
  name: entry(path).href, ...(options === undefined ? {} : { config: options }),
}))))
const ctx = await boot('command-caller-fixture', config)
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgYGAAAAAEAAGjChXjAAAAAElFTkSuQmCC'
let handlerRuns = 0
ctx.commands.register({ name: 'lifetime', description: 'Observe caller lifetime', input: { hint: '<input>', attachments: true }, handler: input => {
  assert.equal(ctx.agents.get(input.agent.id), input.agent)
  handlerRuns++
  return { kind: 'success' }
} })
const commands = ctx.commands
try {
  for (const change of ['disposed', 'replaced', 'idle', 'service-unloaded']) {
    const handle = await ctx.agents.create({ sessionId: SessionId(`command-caller-${change}`) })
    const agent = handle.agent, entered = Promise.withResolvers(), release = Promise.withResolvers()
    const save = ctx.attachments.saveImages.bind(ctx.attachments)
    ctx.attachments.saveImages = async inputs => { entered.resolve(); await release.promise; return save(inputs) }
    handlerRuns = 0
    const operation = commands.execute(agent, '/lifetime', [{ type: 'image', mediaType: 'image/png', data: PNG }], new AbortController().signal)
    let replacement, unloading
    try {
      await entered.promise
      if (change === 'service-unloaded') {
        const withdrawn = Promise.withResolvers()
        ctx.on('internal/service', (name, value) => { if (name === 'commands' && value === undefined) withdrawn.resolve() })
        const owner = [...ctx.loader.entries()].find(candidate => candidate.options.name === entry('interaction/commands').href)
        assert.ok(owner?.fiber)
        unloading = owner.fiber.dispose()
        await withdrawn.promise
        assert.equal(await handle.tryDisposeIdle(), false)
        release.resolve()
        await assert.rejects(operation, /commands service was withdrawn/)
        await unloading
        assert.equal(handlerRuns, 0)
        const events = agent.session.snapshotEvents().filter(event => event.type.startsWith('command/'))
        assert.deepEqual(events.map(event => [event.type, event.data.kind]), [['command/run', undefined], ['command/done', 'error']])
        assert.equal(await handle.tryDisposeIdle(), true)
        process.stdout.write(`${JSON.stringify({ operation: 'withdrawn-command-service', handlerRuns, result: 'error', retiredAfterCleanup: true })}\n`)
        continue
      } else if (change === 'idle') assert.equal(await handle.tryDisposeIdle(), false)
      else {
        await handle.dispose()
        assert.equal(ctx.agents.get(agent.id), undefined)
        if (change === 'replaced') replacement = await ctx.agents.create({ sessionId: agent.id })
      }
      release.resolve()
      const execution = await operation
      const events = agent.session.snapshotEvents().filter(event => event.type.startsWith('command/'))
      assert.deepEqual(events.map(event => event.type), ['command/run', 'command/done'])
      if (change === 'idle') {
        assert.equal(execution.result.kind, 'success')
        assert.equal(handlerRuns, 1)
        assert.equal(await handle.tryDisposeIdle(), true)
        process.stdout.write(`${JSON.stringify({ operation: 'pending-command-idle', retiredWhilePending: false, handlerRuns, result: 'success', retiredAfterCompletion: true })}\n`)
      } else {
        assert.equal(execution.result.kind, 'error')
        assert.equal(events.at(-1).data.kind, 'error')
        assert.equal(handlerRuns, 0)
        if (replacement) {
          assert.notEqual(replacement.agent, agent)
          const fresh = await commands.execute(replacement.agent, '/lifetime', [], new AbortController().signal)
          assert.equal(fresh.result.kind, 'success')
          assert.equal(handlerRuns, 1)
        }
        process.stdout.write(`${JSON.stringify({ operation: `${change}-caller`, staleHandlerRuns: 0, result: 'error', ...replacement ? { freshResult: 'success' } : {} })}\n`)
      }
    } finally {
      release.resolve()
      await Promise.allSettled([operation, unloading])
      ctx.attachments.saveImages = save
      await replacement?.dispose()
      await handle.dispose()
    }
  }
} finally { await ctx.fiber.dispose() }
