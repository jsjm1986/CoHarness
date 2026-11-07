/** Manual compaction through the real Loader, loop and summarizer with keyless external services. */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Compaction fixture requires src or lib')
const artifact = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
const entry = path => new URL(`../../../../${path}/${artifact}`, import.meta.url)
const { boot } = await import(entry('boot/app-boot'))
const { LlmAdapter, createUserMessage } = await import(entry('llm/llm'))
const { SessionId } = await import(entry('core/session'))
const { ExecutionAuthority } = await import(entry('context/execution-authority'))
const plugins = [
  ['core/session'], ['core/agent'], ['llm/llm'], ['core/tools'], ['core/system-prompt'],
  ['session/session-projection'], ['core/agent-loop', { agents: [] }],
  ['interaction/commands'], ['llm/token-meter'], ['compaction/compaction-basic', { auto: false }],
  ['compaction/command-compact'],
]
const config = join(process.cwd(), 'cordis.yml')
await writeFile(config, JSON.stringify(plugins.map(([path, options]) => ({
  name: entry(path).href, ...(options === undefined ? {} : { config: options }),
}))))
const ctx = await boot('compact-authority-fixture', config)
const caller = new AsyncLocalStorage()
const summaryCallers = []
class Adapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } } }
  async *stream(options) {
    const summary = options.purpose === 'compaction'
    if (summary) summaryCallers.push(caller.getStore() ?? 'previous-user')
    const text = summary ? 'The migration requires preserving user ownership.' : 'Ready.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
try {
  ctx.llm.registerAdapter(['compact-fixture'], new Adapter())
  const agent = await ctx.agentLoop.create(SessionId('compact-authority-fixture'), { provider: 'compact-fixture', model: 'fixture' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Preserve the migration details. '.repeat(100) }], source: { kind: 'user' } }))
  await agent.whenIdle()
  let denied = false
  const refusal = new Error('Fixture caller execution was revoked')
  const unsupported = () => { throw new Error('Compaction issuer fixture does not implement this authority operation') }
  // PostgreSQL integration separately verifies the external issuer's actual account permissions.
  class Issuer extends ExecutionAuthority {
    async runRequest(owner, input, work) {
      assert.equal(owner, agent)
      assert.deepEqual(input, { command: 'compact', input: '' })
      if (denied) throw refusal
      return await caller.run('current-user', work)
    }
    stamp = unsupported
    answer = unsupported
    runCaptured = unsupported
    capture = unsupported
    current() { return undefined }
    captureSession = unsupported
    inherit = unsupported
    relay = unsupported
    authorize = unsupported
    authorizeSelection = unsupported
  }
  await ctx.plugin(Issuer)
  ctx.provide('executionAuthorityRequired', true)
  const signal = new AbortController().signal
  const execution = await ctx.commands.execute(agent, '/compact', [], signal)
  assert.equal(execution.result.kind, 'success')
  assert.deepEqual(summaryCallers, ['current-user'])
  const events = agent.session.snapshotEvents()
  const summary = events.find(event => event.type === 'compaction/summary')
  assert.ok(summary)
  assert.equal(execution.result.sourceEventSeq, summary.seq)
  assert.equal(events.at(-1).type, 'command/done')
  process.stdout.write(`${JSON.stringify({ operation: 'compact-command', summaryCaller: summaryCallers[0], result: execution.result.kind, logged: true })}\n`)
  denied = true
  await assert.rejects(ctx.commands.execute(agent, '/compact', [], signal), error => error === refusal)
  assert.equal(summaryCallers.length, 1)
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'compaction/start').length, 1)
  assert.equal(agent.session.snapshotEvents().at(-1).type, 'command/done')
  process.stdout.write(`${JSON.stringify({ operation: 'revoked-compact-command', result: 'denied', newSummaryRequests: 0, newCompactionAttempts: 0 })}\n`)
} finally { await ctx.fiber.dispose() }
