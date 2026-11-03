/** Loader parent and actual SDK child close a paused model without consuming another chunk. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const root = new URL('../../../../../', import.meta.url)
const entry = path => path === 'subagent/subagent-dsh-sdk' && artifactRoot !== undefined
  ? pathToFileURL(`${resolve(artifactRoot)}/lib/index.js`).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root).href
const { boot } = await import(entry('boot/app-boot'))
const { SessionId } = await import(entry('core/session'))
const operations = []
const coordinator = createServer(async (request, response) => {
  try {
    const parts = []; for await (const part of request) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
    if (request.url === '/acquire') {
      assert.equal(body.sessionId, 'model-shutdown-parent'); assert.equal(body.origin, 'execution')
      operations.push({ kind: body.kind, occupied: true })
      response.writeHead(200).end(JSON.stringify({ id: operations.length })); return
    }
    assert.equal(request.url, '/release')
    const operation = operations[body.id - 1]
    assert.equal(operation?.occupied, true); operation.occupied = false
    response.writeHead(200).end('{}')
  } catch (error) { response.writeHead(500).end(JSON.stringify({ error: String(error) })) }
})
let ctx, run, primaryError
try {
  await new Promise((ready, fail) => { coordinator.once('error', fail); coordinator.listen(0, '127.0.0.1', ready) })
  const endpoint = `http://127.0.0.1:${coordinator.address().port}/`, record = join(process.cwd(), 'model-shutdown.jsonl')
  const childPatch = join(process.cwd(), 'child.patch.yml')
  await writeFile(childPatch, JSON.stringify([
    { id: 'llm-deepseek', disabled: true }, { id: 'agent-instructions', disabled: true },
    { id: 'skill-filesystem', config: { includeDefaultRoots: false } },
    { insert: [{ id: 'shutdown-child', name: new URL('./model-shutdown-child.mjs', import.meta.url).href, config: { record } }] },
  ]))
  const plugins = [
    ['core/session'], ['core/agent'], ['llm/llm'], ['core/tools'], ['core/system-prompt'],
    ['session/session-persistence-jsonl', { root: join(process.cwd(), 'sessions'), compression: 'none' }],
    ['session/session-projection'], ['fs/fs-local'], ['session/working-directory'], ['core/agent-loop', { agents: [] }], ['subagent/subagent'],
    ['subagent/subagent-dsh-sdk', { providerName: 'shutdown-child', profile: 'sdk', patches: [childPatch],
      dshHome: join(process.cwd(), 'child-home'), provider: 'completion-fixture', model: 'fixture', initializeTimeoutMs: 30_000,
      maxControlOperations: 5,
      env: { DSH_TELEMETRY_DISABLED: '1', TSX_TSCONFIG_PATH: fileURLToPath(new URL('tsconfig.json', root)) } }],
  ].map(([path, config]) => ({ name: entry(path), ...(config === undefined ? {} : { config }) }))
  plugins.push({ name: new URL('./resource-completion-parent.mjs', import.meta.url).href,
    config: { endpoint, llmEntry: entry('llm/llm'), budgetEntry: entry('context/resource-budget') } })
  const config = join(process.cwd(), 'cordis.yml'); await writeFile(config, JSON.stringify(plugins))
  ctx = await boot('sdk-model-shutdown', config)
  const parent = await ctx.agentLoop.create(SessionId('model-shutdown-parent'), { provider: 'completion-fixture', model: 'fixture' }, { cwd: process.cwd() })
  run = await ctx.subagents.start('shutdown-child', { parent, prompt: 'Verify paused model shutdown.', signal: new AbortController().signal })
  const result = await run.result
  assert.equal(result.stopReason, 'completed'); assert.deepEqual(result.output, [{ type: 'text', text: 'Model shutdown verified.' }])
  await run.dispose()
  const records = (await readFile(record, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(records, [{ phase: 'model-close-recovered' }, { phase: 'consumer-paused' },
    { phase: 'adapter-stopped' }, { phase: 'consumer-closed' }, { phase: 'process-stopped' }])
  assert.deepEqual(operations, [{ kind: 'process', occupied: false }, { kind: 'model', occupied: false }, { kind: 'model', occupied: false },
    { kind: 'process', occupied: false }, { kind: 'model', occupied: false }])
  for (const value of records) console.log(JSON.stringify(value))
  console.log(JSON.stringify({ outcome: result.stopReason, allocations: operations.length, occupied: 0 }))
} catch (error) { primaryError = error; throw error }
finally {
  const failures = [], close = async work => { try { await work() } catch (error) { failures.push(error) } }
  await close(async () => { await run?.dispose() }); await close(async () => { await ctx?.fiber.dispose() })
  if (coordinator.listening) await close(() => new Promise((ready, fail) => { coordinator.closeAllConnections(); coordinator.close(error => error ? fail(error) : ready()) }))
  if (failures.length > 0) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], 'SDK model shutdown example cleanup failed')
}
