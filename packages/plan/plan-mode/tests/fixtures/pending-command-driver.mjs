/** A rejected command cannot hide an earlier accepted plan selection in a real Loader session. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Plan fixture requires src or lib')
const artifact = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
const entry = path => new URL(`../../../../${path}/${artifact}`, import.meta.url)
const { boot } = await import(entry('boot/app-boot'))
const { LlmAdapter, createUserMessage } = await import(entry('llm/llm'))
const { SessionId } = await import(entry('core/session'))
const { planProjectionDefinition } = await import(entry('plan/plan-mode'))
const { ExecutionAuthority } = await import(entry('context/execution-authority'))
const plugins = [
  ['core/session'], ['core/agent'], ['llm/llm'], ['core/tools'], ['core/system-prompt'],
  ['session/session-projection'], ['core/agent-loop', { agents: [] }],
  ['interaction/commands'], ['plan/plan-mode', { section: 'Explore before implementing.' }],
]
const config = join(process.cwd(), 'cordis.yml')
await writeFile(config, JSON.stringify(plugins.map(([path, options]) => ({
  name: entry(path).href, ...(options === undefined ? {} : { config: options }),
}))))
const ctx = await boot('plan-pending-fixture', config)
const entered = Promise.withResolvers(), release = Promise.withResolvers()
let requests = 0, verifiedInputReceived = false
const planInput = 'Draft the verified migration plan.'
class Adapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    if (options.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text === planInput))) verifiedInputReceived = true
    requests += 1
    if (requests === 1) { entered.resolve(); await release.promise }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Ready.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Ready.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
function turn(agent) {
  const idle = new Promise(resolve => {
    const stop = ctx.on('agent/status', event => {
      if (event.agent === agent && event.status === 'idle') { stop(); resolve() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
  return idle
}
try {
  ctx.llm.registerAdapter(['plan-fixture'], new Adapter())
  const agent = await ctx.agentLoop.create(SessionId('plan-pending-fixture'), { provider: 'plan-fixture', model: 'fixture' })
  const running = turn(agent)
  await entered.promise
  const signal = new AbortController().signal
  const accepted = await ctx.commands.execute(agent, '/plan', [], signal)
  assert.equal(accepted.result.kind, 'success')
  const rejected = await ctx.commands.execute(agent, '/plan off', [{ type: 'file', receiptId: 'unavailable-file' }], signal)
  assert.equal(rejected.result.kind, 'error')
  const view = ctx.sessionProjections.snapshot(agent.session).values.plan
  assert.deepEqual(view, { active: false, pending: true })
  assert.deepEqual(ctx.planMode.get(agent), { active: false, pending: true })
  let replay = planProjectionDefinition.init()
  for (const event of agent.session.snapshotEvents()) replay = planProjectionDefinition.apply(replay, event)
  assert.deepEqual(planProjectionDefinition.wire.view(replay), view)
  release.resolve(); await running
  await turn(agent)
  assert.deepEqual(ctx.planMode.get(agent), { active: true })
  assert.deepEqual(ctx.sessionProjections.snapshot(agent.session).values.plan, { active: true, pending: false })
  process.stdout.write(`${JSON.stringify({ operation: 'failed-plan-command', pendingPreserved: true, replayMatches: true, applied: true })}\n`)
  let stamped = 0, receipt
  // The issuer supplies opaque receipts; PostgreSQL integration checks actual caller authorization.
  const unsupported = () => { throw new Error('Plan receipt fixture does not implement this authority operation') }
  class ReceiptIssuer extends ExecutionAuthority {
    async stamp(session, message) {
      const owner = ctx.agents.get(session.id)
      assert.ok(owner && owner.session === session)
      assert.deepEqual(ctx.planMode.get(owner), { active: false })
      stamped++
      receipt = randomUUID()
      return { ...message, source: { ...message.source, gatewayExecutionInput: receipt } }
    }
    answer = unsupported
    runCaptured = unsupported
    runRequest = unsupported
    capture = unsupported
    current() { return undefined }
    captureSession = unsupported
    inherit = unsupported
    relay = unsupported
    authorize = unsupported
    authorizeSelection = unsupported
  }
  await ctx.plugin(ReceiptIssuer)
  ctx.provide('executionAuthorityRequired', true)
  const verified = await ctx.agentLoop.create(SessionId('plan-verified-fixture'), { provider: 'plan-fixture', model: 'fixture' })
  const execution = await ctx.commands.execute(verified, `/plan ${planInput}`, [], signal)
  assert.equal(execution.result.kind, 'success')
  await verified.whenIdle()
  const input = verified.session.snapshotEvents().find(event => event.type === 'user/message'
    && event.data.content.some(block => block.type === 'text' && block.text === planInput))
  assert.equal(input?.data.source.gatewayExecutionInput, receipt)
  assert.equal(stamped, 1)
  assert.equal(verifiedInputReceived, true)
  assert.deepEqual(ctx.planMode.get(verified), { active: true })
  process.stdout.write(`${JSON.stringify({ operation: 'verified-plan-command', stamped, identityLogged: true, modelReceivedInput: true, applied: true })}\n`)
} finally { release.resolve(); await ctx.fiber.dispose() }
