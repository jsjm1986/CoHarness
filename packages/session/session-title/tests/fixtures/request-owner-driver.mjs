/** Two real AgentLoops share a Session id without sharing main-request ownership or pending title work. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Request ownership fixture requires src or lib')
const artifact = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
const entry = path => new URL(`../../../../${path}/${artifact}`, import.meta.url)
const { boot } = await import(entry('boot/app-boot'))
const { createUserMessage } = await import(entry('llm/llm'))
const { SessionId } = await import(entry('core/session'))
const sources = new Map([
  ['@deepseek-ai/dsh-session', 'core/session'], ['@deepseek-ai/dsh-agent', 'core/agent'],
  ['@deepseek-ai/dsh-llm', 'llm/llm'], ['@deepseek-ai/dsh-tools', 'core/tools'],
  ['@deepseek-ai/dsh-system-prompt', 'core/system-prompt'], ['@deepseek-ai/dsh-session-projection', 'session/session-projection'],
  ['@deepseek-ai/dsh-agent-loop', 'core/agent-loop'], ['@deepseek-ai/dsh-session-title', 'session/session-title'],
])
const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/interaction/request-origin/cordis.yml', import.meta.url)
const plugins = JSON.parse(await readFile(fixture, 'utf8'))
const config = join(process.cwd(), 'cordis.yml')
await writeFile(config, JSON.stringify(plugins.map(plugin => {
  if (plugin.name.startsWith('./')) return { ...plugin, name: new URL(plugin.name, fixture).href }
  const source = sources.get(plugin.name)
  assert.ok(source, `No artifact selection for ${plugin.name}`)
  return { ...plugin, name: entry(source).href }
})))
const origin = await boot('request-origin-a', config)
let destination
const resume = Promise.withResolvers()
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const prompt = (agent, text) => agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
try {
  destination = await boot('request-origin-b', config)
  const a = origin.get('fixtureRequestOrigin'), b = destination.get('fixtureRequestOrigin')
  a.hold = Promise.withResolvers()
  const id = SessionId('same-session-in-two-loaders')
  const options = { provider: 'request-origin-fixture', model: 'local' }
  const original = await origin.agentLoop.create(id, options)
  prompt(original, 'Origin conversation')
  const foreign = await a.captured.promise
  assert.ok(Object.isFrozen(foreign))
  assert.equal(origin.llm.isAgentLoopRequest(foreign), true)
  assert.equal(destination.llm.isAgentLoopRequest(foreign), false)
  assert.equal(origin.llm.isAgentLoopRequest({ ...foreign }), false)
  output({ operation: 'frozen-loop-request', owningRuntime: true, foreignRuntime: false, copiedObject: false })

  const local = await destination.agentLoop.create(id, options)
  prompt(local, 'First local conversation')
  await local.whenIdle()
  await setImmediate()
  assert.equal(b.titleCalls, 1)
  const headers = () => local.session.snapshotEvents().filter(event => event.type === 'request/header').length
  const beforeHeaders = headers(), entered = Promise.withResolvers()
  destination.on('agent/request', async ({ agent, turn }, next) => {
    if (agent === local && turn === 2) { entered.resolve(); await resume.promise }
    return next()
  })
  prompt(local, 'Second local conversation')
  await entered.promise
  for await (const _chunk of destination.llm.stream(foreign)) { /* Drain the separate local adapter call. */ }
  await setImmediate()
  assert.equal(b.titleCalls, 1)
  assert.equal(destination.sessionTitle.get(local.session).title, 'Revision 1')
  output({ operation: 'foreign-request', titleCalls: b.titleCalls, pendingRevisionPreserved: true })
  resume.resolve()
  await local.whenIdle()
  await setImmediate()
  assert.equal(headers(), beforeHeaders)
  assert.equal(b.titleCalls, 2)
  assert.equal(destination.sessionTitle.get(local.session).title, 'Revision 2')
  assert.equal(destination.llm.isAgentLoopRequest(b.requests.at(-1)), true)
  assert.equal(origin.llm.isAgentLoopRequest(b.requests.at(-1)), false)
  output({ operation: 'local-loop-request', titleCalls: b.titleCalls, title: 'Revision 2', headerUnchanged: true })
  const retired = origin.llm
  a.hold.resolve()
  await original.whenIdle()
  await origin.fiber.dispose()
  assert.equal(retired.isAgentLoopRequest(foreign), false)
  assert.throws(() => retired.markAgentLoopRequest(foreign), { code: 'MODEL_REQUEST_ORIGIN_UNAVAILABLE' })
  output({ operation: 'withdrawn-service', recognized: false, newMarker: 'MODEL_REQUEST_ORIGIN_UNAVAILABLE' })
} finally {
  resume.resolve()
  origin.get('fixtureRequestOrigin')?.hold?.resolve()
  await destination?.fiber.dispose()
  await origin.fiber.dispose()
}
