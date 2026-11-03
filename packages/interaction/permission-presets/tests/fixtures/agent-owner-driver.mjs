/** Real command dispatch refuses a stale Agent after an external permission decision waits across disposal. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Permission fixture requires src or lib')
const artifact = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
const entry = path => new URL(`../../../../${path}/${artifact}`, import.meta.url)
const { boot } = await import(entry('boot/app-boot'))
const { SessionId } = await import(entry('core/session'))
const sources = new Map([
  ['@deepseek-ai/dsh-session', 'core/session'], ['@deepseek-ai/dsh-agent', 'core/agent'],
  ['@deepseek-ai/dsh-llm', 'llm/llm'], ['@deepseek-ai/dsh-tools', 'core/tools'],
  ['@deepseek-ai/dsh-system-prompt', 'core/system-prompt'], ['@deepseek-ai/dsh-session-projection', 'session/session-projection'],
  ['@deepseek-ai/dsh-agent-loop', 'core/agent-loop'], ['@deepseek-ai/dsh-commands', 'interaction/commands'],
  ['@deepseek-ai/dsh-user-approval', 'interaction/user-approval'], ['@deepseek-ai/dsh-permission-presets', 'interaction/permission-presets'],
])
const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/interaction/permission-owner/cordis.yml', import.meta.url)
const plugins = JSON.parse(await readFile(fixture, 'utf8'))
const config = join(process.cwd(), 'cordis.yml')
await writeFile(config, JSON.stringify(plugins.map(plugin => {
  if (plugin.name.startsWith('./')) return { ...plugin, name: new URL(plugin.name, fixture).href }
  const source = sources.get(plugin.name)
  assert.ok(source, `No explicit artifact selection for ${plugin.name}`)
  return { ...plugin, name: entry(source).href }
})))
const ctx = await boot('permission-owner-fixture', config)
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`)
try {
  ctx.permissionPresets.registerAuto(() => {})
  const active = await ctx.agents.create({ sessionId: SessionId('permission-owner-active') })
  try {
    const execution = await ctx.commands.execute(active.agent, '/permission auto', [], new AbortController().signal)
    assert.equal(execution.result.kind, 'success')
    assert.equal(ctx.permissionPresets.current(active.agent.session), 'auto')
    output({ operation: 'active-permission-owner', result: execution.result.text, current: 'auto' })
  } finally { await active.dispose() }
  for (const kind of ['disposed', 'replaced']) {
    const handle = await ctx.agents.create({ sessionId: SessionId(`permission-owner-${kind}`) })
    const state = () => handle.agent.session.snapshotEvents().filter(event =>
      event.type === 'permission/preset' || event.type === 'sandbox/mode' || event.type === 'approval/policy')
    const before = state(), entered = Promise.withResolvers(), release = Promise.withResolvers()
    ctx.get('fixturePermissionDecision').pending = { entered, release }
    const pending = ctx.commands.execute(handle.agent, '/permission auto', [], new AbortController().signal)
    const outcome = pending.then(value => ({ value }), error => ({ error }))
    let replacement
    try {
      await entered.promise
      await handle.dispose()
      if (kind === 'replaced') replacement = await ctx.agents.create({ sessionId: handle.agent.id })
      release.resolve()
      const result = await outcome
      assert.match(result.error?.message ?? '', /Agent is no longer active/)
      assert.deepEqual(state(), before)
      const done = handle.agent.session.snapshotEvents().filter(event => event.type === 'command/done').at(-1)
      assert.equal(done.data.kind, 'error')
      if (replacement !== undefined) assert.equal(ctx.permissionPresets.current(replacement.agent.session), 'workspace-write')
      output({ operation: `${kind}-permission-owner`, result: 'refused', permissionWrites: 0, commandResult: done.data.kind, message: done.data.text,
        ...replacement === undefined ? {} : { replacementPreset: 'workspace-write' } })
    } finally {
      release.resolve(); await outcome; ctx.get('fixturePermissionDecision').pending = undefined
      await replacement?.dispose(); await handle.dispose()
    }
  }
} finally { await ctx.fiber.dispose() }
