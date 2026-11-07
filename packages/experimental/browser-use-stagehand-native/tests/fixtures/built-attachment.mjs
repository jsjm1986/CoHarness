/** Plain-Node smoke of the published provider and its independently configured attachment Worker. */
import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import ResourceBudget from '@deepseek-ai/dsh-resource-budget'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Provider from '../../lib/index.js'

const [endpoint, target, extensionId] = process.argv.slice(2)
const owned = endpoint === '--launch'
const url = owned ? extensionId : target
const ctx = new Context()
const root = await mkdtemp(join(tmpdir(), 'dsh-built-stagehand-'))
const requested = Promise.withResolvers(), granted = Promise.withResolvers()
let admissions = 0, completions = 0
class Budget extends ResourceBudget {
  async acquire(request) {
    assert.equal(request.kind, 'process')
    assert.equal(request.sessionId, 'built-stagehand')
    admissions++
    requested.resolve()
    await granted.promise
    let released = false
    return { signal: new AbortController().signal,
      release: async () => { if (!released) { released = true; completions++ } },
      uncertain: async () => { throw new Error('unexpected uncertain browser process') } }
  }
}
try {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  await ctx.plugin(BrowserUseRegistry)
  ctx.provide('resourceBudgetRequired', true)
  await ctx.plugin(Budget)
  const provider = ctx.plugin(Provider, {
    ...owned ? { mode: 'launch', executablePath: target } : {
      mode: 'attach', cdpEndpoint: endpoint, ...extensionId === undefined ? {} : { extensionId },
    },
    model: { provider: 'browser-fixture', model: 'browser-model' },
  })
  await provider
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('built-stagehand'))
  const call = async (method, args) => {
    const result = await ctx.tools.execute({ agent, name: `stagehand_${method}`, arguments: args, callId: ToolCallId(`built-${method}`), signal: new AbortController().signal })
    if (result.isError) throw new Error(JSON.stringify(result.content))
    return result
  }
  let settled = false
  const pending = call('tabs', { action: 'new', url }).finally(() => { settled = true })
  await Promise.race([requested.promise, pending.then(() => { throw new Error('browser operation finished before process admission') })])
  const waited = !settled
  granted.resolve()
  await pending
  const result = await call('navigate', { url })
  await provider.dispose()
  assert.equal(completions, admissions)
  process.stdout.write(JSON.stringify({ result: result.content, admissions, completions, waited }) + '\n')
} finally {
  granted.resolve()
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
