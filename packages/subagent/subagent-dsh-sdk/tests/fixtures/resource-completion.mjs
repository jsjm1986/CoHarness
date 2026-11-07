/** Full Loader parent, managed SDK child and native grandchildren retain completion ownership. */
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
const operations = new Map()
let next = 0, capacityRefusals = 0
const coordinator = createServer(async (request, response) => {
  try {
    const parts = []; for await (const part of request) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
    if (request.url === '/acquire') {
      assert.equal(body.sessionId, 'resource-completion-parent'); assert.equal(body.origin, 'execution')
      if (body.kind === 'process' && [...operations.entries()].some(([id, operation]) =>
        id !== 1 && operation.kind === 'process' && operation.occupied)) {
        capacityRefusals++
        throw new Error('Previous child process admission still occupies capacity')
      }
      const id = ++next
      operations.set(id, { kind: body.kind, occupied: true, attempts: 0, acknowledgements: 0, uncertainty: 0 })
      response.writeHead(200).end(JSON.stringify({ id, cancelled: id === 2 })); return
    }
    const operation = operations.get(body.id); assert.ok(operation)
    if (request.url === '/uncertain') {
      assert.equal(operation.occupied, true); operation.uncertainty++
      response.writeHead(200).end('{}'); return
    }
    assert.equal(request.url, '/release'); operation.attempts++
    if (body.id <= 3 && operation.attempts === 1) { response.writeHead(503).end('{}'); return }
    assert.equal(operation.occupied, true); operation.occupied = false; operation.acknowledgements++
    response.writeHead(200).end('{}')
  } catch (error) { response.writeHead(500).end(JSON.stringify({ error: String(error) })) }
})
let ctx, run, primaryError
try {
  await new Promise((ready, fail) => { coordinator.once('error', fail); coordinator.listen(0, '127.0.0.1', ready) })
  const endpoint = `http://127.0.0.1:${coordinator.address().port}/`, record = join(process.cwd(), 'native-completion.jsonl')
  const childPatch = join(process.cwd(), 'child.patch.yml')
  await writeFile(childPatch, JSON.stringify([
    { id: 'llm-deepseek', disabled: true }, { id: 'agent-instructions', disabled: true },
    { id: 'skill-filesystem', config: { includeDefaultRoots: false } },
    { insert: [{ id: 'completion-child', name: new URL('./resource-completion-child.mjs', import.meta.url).href,
      config: { record } }] },
  ]))
  const plugins = [
    ['core/session'], ['core/agent'], ['llm/llm'], ['core/tools'], ['core/system-prompt'],
    ['session/session-persistence-jsonl', { root: join(process.cwd(), 'sessions'), compression: 'none' }],
    ['session/session-projection'], ['fs/fs-local'], ['session/working-directory'], ['core/agent-loop', { agents: [] }], ['subagent/subagent'],
    ['subagent/subagent-dsh-sdk', { providerName: 'completion-child', profile: 'sdk', patches: [childPatch],
      dshHome: join(process.cwd(), 'child-home'), provider: 'completion-fixture', model: 'fixture',
      initializeTimeoutMs: 30_000, controlRequestTimeoutMs: 2000, controlCleanupTimeoutMs: 20_000,
      maxControlOperations: 2,
      env: { DSH_TELEMETRY_DISABLED: '1', TSX_TSCONFIG_PATH: fileURLToPath(new URL('tsconfig.json', root)) } }],
  ].map(([path, config]) => ({ name: entry(path), ...(config === undefined ? {} : { config }) }))
  plugins.push({ name: new URL('./resource-completion-parent.mjs', import.meta.url).href,
    config: { endpoint, llmEntry: entry('llm/llm'), budgetEntry: entry('context/resource-budget') } })
  const config = join(process.cwd(), 'cordis.yml'); await writeFile(config, JSON.stringify(plugins))
  ctx = await boot('sdk-resource-completion', config)
  const parent = await ctx.agentLoop.create(SessionId('resource-completion-parent'), { provider: 'completion-fixture', model: 'fixture' }, { cwd: process.cwd() })
  run = await ctx.subagents.start('completion-child', { parent, prompt: 'Verify resource cleanup.', signal: new AbortController().signal })
  const result = await run.result
  assert.equal(result.stopReason, 'completed'); assert.deepEqual(result.output, [{ type: 'text', text: 'Resource cleanup verified.' }])
  let runtimeCompletionRetried = false
  try { await run.dispose() } catch { runtimeCompletionRetried = true }
  assert.equal(runtimeCompletionRetried, true)
  await Promise.all([run.dispose(), run.dispose()]); await run.dispose()
  await ctx.subagents.waitForChildren(parent); await parent.whenIdle()
  const records = (await readFile(record, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(records, [{ scenario: 'unpublished', firstFailed: true }, { scenario: 'control-body-deadline', status: 400 },
    { scenario: 'control-concurrency', pendingUploads: 2, status: 200 },
    { scenario: 'retry', firstFailed: true, liveWhenUncertain: false, nativeStopped: true },
    { scenario: 'uncertain', firstFailed: false, liveWhenUncertain: true, nativeStopped: true, parentCancellationObserved: true },
    { scenario: 'early-cancellation', cancelled: 4, continued: true }])
  assert.equal(next, 6)
  assert.deepEqual([...operations.values()].map(value => value.kind), [...Array(5).fill('process'), 'model'])
  assert.deepEqual([...operations.values()].map(value => value.attempts), [2, 2, 2, ...Array(3).fill(1)])
  assert.equal(operations.get(4).uncertainty, 1)
  assert.ok([...operations.values()].every(value => !value.occupied && value.acknowledgements === 1))
  for (const value of records) console.log(JSON.stringify(value))
  console.log(JSON.stringify({ phase: 'completed', outcome: result.stopReason, allocations: next, occupied: 0,
    runtimeCompletionRetried, releaseAttempts: [...operations.values()].reduce((total, value) => total + value.attempts, 0),
    acknowledgements: [...operations.values()].reduce((total, value) => total + value.acknowledgements, 0) }))
} catch (error) {
  primaryError = error
  const nativeFailure = await readFile(join(process.cwd(), 'native-completion.jsonl.failure.json'), 'utf8').catch((reason) => {
    if (reason.code === 'ENOENT') return undefined
    throw reason
  })
  if (nativeFailure !== undefined) process.stderr.write(JSON.stringify({ nativeProbeFailure: JSON.parse(nativeFailure) }) + '\n')
  process.stderr.write(JSON.stringify({ fixturePhase: 'failed', allocations: next, capacityRefusals }) + '\n')
  throw error
}
finally {
  const failures = [], close = async work => { try { await work() } catch (error) { failures.push(error) } }
  await close(async () => { await run?.dispose() }); await close(async () => { await ctx?.fiber.dispose() })
  if (coordinator.listening) await close(() => new Promise((ready, fail) => { coordinator.closeAllConnections(); coordinator.close(error => error ? fail(error) : ready()) }))
  if (failures.length > 0) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], 'SDK resource example cleanup failed')
}
