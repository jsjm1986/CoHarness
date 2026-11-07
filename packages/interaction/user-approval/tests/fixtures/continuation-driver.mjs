/** Real Agent, Loader, scoped approval and tool providers refuse withdrawn continuation. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Approval fixture requires src or lib')
const artifact = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
const entry = path => new URL(`../../../../${path}/${artifact}`, import.meta.url)
const { boot } = await import(entry('boot/app-boot'))
const { SessionId } = await import(entry('core/session'))
const { ToolCallId } = await import(entry('llm/llm'))
const { defineTool } = await import(entry('core/tools'))
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
const ctx = await boot('approval-continuation-fixture', path)
let handle
try {
  handle = await ctx.agents.create({ sessionId: SessionId('approval-continuation') })
  const agent = handle.agent
  agent.session.append('turn/start', { turn: 1 })
  let toolRuns = 0
  ctx.tools.register(defineTool({
    name: 'sensitive', description: 'Fixture action requiring approval', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { toolRuns++; return 'ACTION_COMPLETED' },
  }))
  ctx.on('tools/pre-execute', async () => ({ kind: 'ask' }))
  const initial = ctx.on('approval/request', () => Promise.resolve('allowed-once'))
  try {
    const result = await ctx.tools.execute({ agent, name: 'sensitive', arguments: {}, callId: ToolCallId('approved'), signal: new AbortController().signal })
    assert.equal(result.isError, false)
    assert.equal(toolRuns, 1)
    process.stdout.write(`${JSON.stringify({ operation: 'live-approval', toolRuns, outcome: 'allowed-once' })}\n`)
  } finally { initial() }
  for (const operation of ['dispatch-cancelled', 'late-cancelled', 'late-withdrawn']) {
    const controller = new AbortController(), entered = Promise.withResolvers(), resume = Promise.withResolvers(), resumed = Promise.withResolvers()
    const disposers = []
    let answerers = 0
    if (operation === 'dispatch-cancelled') {
      disposers.push(ctx.on('internal/dispatch', (_mode, name) => { if (name === 'approval/request') controller.abort() }))
    } else {
      disposers.push(ctx.on('approval/request', async (_request, next) => {
        entered.resolve()
        await resume.promise
        try { return await next() } finally { resumed.resolve() }
      }))
    }
    disposers.push(ctx.on('approval/request', () => { answerers++; return Promise.resolve('allowed-once') }))
    const pending = ctx.tools.execute({ agent, name: 'sensitive', arguments: {}, callId: ToolCallId(operation), signal: controller.signal })
    try {
      if (operation !== 'dispatch-cancelled') {
        await entered.promise
        if (operation === 'late-cancelled') controller.abort()
        else {
          const owner = [...ctx.loader.entries()].find(candidate => candidate.options.name === entry('interaction/user-approval').href)
          assert.ok(owner?.fiber)
          await owner.fiber.dispose()
        }
      }
      const result = await pending
      assert.equal(result.isError, true)
      resume.resolve()
      if (operation !== 'dispatch-cancelled') await resumed.promise
      assert.equal(answerers, 0)
      assert.equal(toolRuns, 1)
      const auditOutcome = agent.session.snapshotEvents().filter(event => event.type === 'approval/decided').at(-1).data.outcome
      assert.equal(auditOutcome, 'cancelled')
      process.stdout.write(`${JSON.stringify({ operation, answerers, toolRuns, outcome: auditOutcome })}\n`)
    } finally {
      controller.abort()
      resume.resolve()
      for (const dispose of disposers) dispose()
      await pending
    }
  }
} finally { await handle?.dispose(); await ctx.fiber.dispose() }
