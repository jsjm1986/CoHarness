/** Actual failed SDK initialization retains its exited process permit until acknowledged recovery. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const repository = new URL('../../../../../', import.meta.url)
const entry = path => path === 'subagent/subagent-dsh-sdk' && artifactRoot !== undefined
  ? pathToFileURL(`${resolve(artifactRoot)}/lib/index.js`).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, repository).href
const [{ boot }, { SessionId }] = await Promise.all([import(entry('boot/app-boot')), import(entry('core/session'))])
const pidFile = join(process.cwd(), 'first-child-pid.json'), operations = new Map()
let firstPid, exitedBeforeReport = false, completedBeforeReplacement = false, allocations = 0
function firstChildGone() {
  try { process.kill(firstPid, 0); return false }
  catch (error) { if (error.code === 'ESRCH') return true; throw error }
}
const accountant = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (request.url === '/acquire') {
      assert.equal(body.sessionId, 'startup-recovery-parent'); assert.equal(body.origin, 'execution')
      const id = ++allocations
      if (id === 2) completedBeforeReplacement = !operations.get(1).occupied
      operations.set(id, { kind: body.kind, occupied: true, reports: 0, acknowledgements: 0 })
      response.writeHead(200).end(JSON.stringify({ id })); return
    }
    assert.equal(request.url, '/release')
    const operation = operations.get(body.id); assert.ok(operation); operation.reports++
    if (body.id === 1) {
      firstPid ??= JSON.parse(await readFile(pidFile, 'utf8')).pid
      exitedBeforeReport = firstChildGone(); assert.equal(exitedBeforeReport, true)
      if (operation.reports === 1) { response.writeHead(503).end('{}'); return }
    }
    assert.equal(operation.occupied, true)
    operation.occupied = false; operation.acknowledgements++
    response.writeHead(200).end('{}')
  } catch (error) { response.writeHead(500).end(JSON.stringify({ error: String(error) })) }
})
let ctx, run, primaryError
try {
  await new Promise((ready, fail) => { accountant.once('error', fail); accountant.listen(0, '127.0.0.1', ready) })
  const endpoint = `http://127.0.0.1:${accountant.address().port}/`, patch = join(process.cwd(), 'child.patch.yml')
  await writeFile(patch, JSON.stringify([
    { id: 'llm-deepseek', disabled: true }, { id: 'agent-instructions', disabled: true },
    { id: 'skill-filesystem', config: { includeDefaultRoots: false } },
    { insert: [{ id: 'startup-recovery-child', name: new URL('./startup-recovery-child.mjs', import.meta.url).href,
      config: { marker: join(process.cwd(), 'first-start'), pidFile } }] },
  ]))
  const plugins = [
    ['core/session'], ['core/agent'], ['llm/llm'], ['core/tools'], ['core/system-prompt'], ['fs/fs-local'],
    ['session/session-persistence-jsonl', { root: join(process.cwd(), 'sessions'), compression: 'none' }],
    ['session/session-projection'], ['session/working-directory'], ['core/agent-loop', { agents: [] }], ['subagent/subagent'],
    ['subagent/subagent-dsh-sdk', { providerName: 'startup-child', profile: 'sdk', patches: [patch],
      dshHome: join(process.cwd(), 'child-home'), provider: 'completion-fixture', model: 'fixture',
      initializeTimeoutMs: 30_000, controlRequestTimeoutMs: 10_000, controlCleanupTimeoutMs: 20_000,
      env: { DSH_TELEMETRY_DISABLED: '1', TSX_TSCONFIG_PATH: fileURLToPath(new URL('tsconfig.json', repository)) } }],
  ].map(([path, config]) => ({ name: entry(path), ...(config === undefined ? {} : { config }) }))
  plugins.push({ name: new URL('./resource-completion-parent.mjs', import.meta.url).href,
    config: { endpoint, llmEntry: entry('llm/llm'), budgetEntry: entry('context/resource-budget') } })
  const config = join(process.cwd(), 'cordis.yml'); await writeFile(config, JSON.stringify(plugins))
  ctx = await boot('sdk-startup-recovery', config)
  const parent = await ctx.agentLoop.create(SessionId('startup-recovery-parent'), { provider: 'completion-fixture', model: 'fixture' }, { cwd: process.cwd() })
  let starts = 0, ends = 0
  const observers = [ctx.on('subagent/start', () => { starts++ }), ctx.on('subagent/end', () => { ends++ })]
  let rejected = false
  try { await ctx.subagents.start('startup-child', { parent, prompt: 'Fail startup.', signal: new AbortController().signal }) }
  catch (error) { assert.ok(error instanceof AggregateError); rejected = true }
  assert.equal(rejected, true); assert.equal(exitedBeforeReport, true)
  assert.equal(starts, 0); assert.equal(ends, 0); assert.equal(operations.get(1).occupied, true)
  console.log(JSON.stringify({ phase: 'rejected-start', rejected, processExited: exitedBeforeReport, publishedStarts: starts, occupied: 1, allocations }))
  run = await ctx.subagents.start('startup-child', { parent, prompt: 'Recover startup.', signal: new AbortController().signal })
  const result = await run.result
  assert.equal(result.stopReason, 'completed'); assert.deepEqual(result.output, [{ type: 'text', text: 'Startup recovery verified.' }])
  await run.dispose(); await ctx.subagents.waitForChildren(parent); await parent.whenIdle()
  assert.equal(completedBeforeReplacement, true); assert.equal(allocations, 3)
  assert.deepEqual([...operations.values()].map(value => value.kind), ['process', 'process', 'model'])
  assert.deepEqual([...operations.values()].map(value => value.reports), [2, 1, 1])
  assert.ok([...operations.values()].every(value => !value.occupied && value.acknowledgements === 1))
  assert.equal(starts, 1); assert.equal(ends, 1)
  for (const off of observers) off()
  console.log(JSON.stringify({ phase: 'recovered-start', completedBeforeReplacement, allocations, occupied: 0, acknowledgements: 3, publishedStarts: starts, publishedEnds: ends, outcome: result.stopReason }))
} catch (error) { primaryError = error; throw error }
finally {
  const failures = [], close = async operation => { try { await operation() } catch (error) { failures.push(error) } }
  await close(async () => { await run?.dispose() }); await close(async () => { await ctx?.fiber.dispose() })
  if (accountant.listening) await close(() => new Promise((ready, fail) => { accountant.closeAllConnections(); accountant.close(error => error ? fail(error) : ready()) }))
  if (failures.length > 0) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], 'SDK startup example cleanup failed')
}
