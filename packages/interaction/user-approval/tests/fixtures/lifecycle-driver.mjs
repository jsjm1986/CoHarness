/** Real Loader and tool dispatch refuse cancelled decisions and grants from retired approval instances. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Approval fixture requires src or lib')
const artifact = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
const entry = path => new URL(`../../../../${path}/${artifact}`, import.meta.url)
const { boot } = await import(entry('boot/app-boot'))
const { SessionId } = await import(entry('core/session'))
const { ToolCallId } = await import(entry('llm/llm'))
const { defineTool } = await import(entry('core/tools'))
const { default: ApprovalService } = await import(entry('interaction/user-approval'))
const sources = new Map([
  ['@deepseek-ai/dsh-session', 'core/session'], ['@deepseek-ai/dsh-agent', 'core/agent'],
  ['@deepseek-ai/dsh-llm', 'llm/llm'], ['@deepseek-ai/dsh-tools', 'core/tools'],
  ['@deepseek-ai/dsh-system-prompt', 'core/system-prompt'], ['@deepseek-ai/dsh-session-projection', 'session/session-projection'],
  ['@deepseek-ai/dsh-agent-loop', 'core/agent-loop'], ['@deepseek-ai/dsh-user-approval', 'interaction/user-approval'],
])
const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/interaction/approval-lifecycle/cordis.yml', import.meta.url)
const config = JSON.parse(await readFile(fixture, 'utf8'))
const path = join(process.cwd(), 'cordis.yml')
await writeFile(path, JSON.stringify(config.map(plugin => {
  const source = sources.get(plugin.name)
  assert.ok(source, `No explicit artifact selection for ${plugin.name}`)
  return { ...plugin, name: entry(source).href }
})))
const ctx = await boot('approval-lifecycle-fixture', path)
let handle
try {
  handle = await ctx.agents.create({ sessionId: SessionId('approval-lifecycle') })
  const agent = handle.agent, service = ctx.approval
  agent.session.append('turn/start', { turn: 1 })
  let toolRuns = 0, answererRuns = 0
  ctx.tools.register(defineTool({
    name: 'sensitive', description: 'Fixture action requiring approval', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { toolRuns++; return 'ACTION_COMPLETED' },
  }))
  ctx.on('tools/pre-execute', async () => ({ kind: 'ask' }))
  const initial = ctx.on('approval/request', () => { answererRuns++; return Promise.resolve('allowed-once') })
  try {
    const cancelled = new AbortController()
    const decision = service.request({ agent, toolName: 'sensitive', signal: cancelled.signal })
    cancelled.abort(new Error('fixture cancellation before answerer entry'))
    assert.equal(await decision, 'cancelled')
    assert.equal(answererRuns, 0)
    process.stdout.write(`${JSON.stringify({ operation: 'cancelled-before-dispatch', answererRuns, outcome: 'cancelled' })}\n`)
    const accepted = await ctx.tools.execute({ agent, name: 'sensitive', arguments: {}, callId: ToolCallId('accepted'), signal: new AbortController().signal })
    assert.equal(accepted.isError, false)
    assert.equal(toolRuns, 1)
  } finally { initial() }
  const entered = Promise.withResolvers(), late = Promise.withResolvers()
  const waiting = ctx.on('approval/request', () => { entered.resolve(); return late.promise })
  const pending = ctx.tools.execute({ agent, name: 'sensitive', arguments: {}, callId: ToolCallId('withdrawn'), signal: new AbortController().signal })
  let unloading
  try {
    await entered.promise
    const owner = [...ctx.loader.entries()].find(candidate => candidate.options.name === entry('interaction/user-approval').href)
    assert.ok(owner?.fiber)
    unloading = owner.fiber.dispose()
    await unloading
    const result = await pending
    assert.equal(result.isError, true)
    assert.equal(toolRuns, 1)
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'approval/decided').at(-1).data.outcome, 'cancelled')
    process.stdout.write(`${JSON.stringify({ operation: 'withdrawn-approval-tool', lateGrantDispatches: toolRuns - 1, result: result.content, auditOutcome: 'cancelled' })}\n`)
  } finally { late.resolve('allowed-once'); waiting(); await Promise.allSettled([pending, unloading]) }
  await ctx.plugin(ApprovalService, { policy: 'never' })
  const before = agent.session.seq
  await assert.rejects(service.request({ agent, toolName: 'sensitive' }), /withdrawn/)
  assert.throws(() => service.setPolicy(agent, 'ask'), /withdrawn/)
  assert.equal(agent.session.seq, before)
  const denied = await ctx.tools.execute({ agent, name: 'sensitive', arguments: {}, callId: ToolCallId('replacement'), signal: new AbortController().signal })
  assert.equal(denied.isError, true)
  assert.equal(toolRuns, 1)
  process.stdout.write(`${JSON.stringify({ operation: 'replacement-never-policy', retiredReference: 'refused', retiredAuditWrites: 0, result: denied.content })}\n`)
  const audit = agent.session.snapshotEvents().filter(event => event.type.startsWith('approval/'))
    .map(event => ({ type: event.type, ...event.type === 'approval/decided' ? { outcome: event.data.outcome } : {} }))
  assert.equal(audit.filter(event => event.type === 'approval/asked').length, 4)
  assert.equal(audit.filter(event => event.type === 'approval/decided').length, 4)
  process.stdout.write(`${JSON.stringify({ operation: 'audit-completion', events: audit })}\n`)
} finally { await handle?.dispose(); await ctx.fiber.dispose() }
