/** Actual SDK composition retains a live process after refused termination and retries its original owner. */
import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const entry = mode === 'lib' && artifactRoot !== undefined
  ? pathToFileURL(`${resolve(artifactRoot)}/lib/index.js`).href
  : new URL(`../../${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, import.meta.url).href
const { DeepSeekHarness, TransportClosedError } = await import(entry)
const marker = join(process.cwd(), 'cleanup-entered'), patch = join(process.cwd(), 'runtime.patch.yml')
await writeFile(patch, JSON.stringify([
  { id: 'llm-deepseek', disabled: true }, { id: 'agent-instructions', disabled: true },
  { id: 'skill-filesystem', config: { includeDefaultRoots: false } },
  { insert: [{ id: 'close-recovery-runtime', name: new URL('./close-recovery-runtime.mjs', import.meta.url).href, config: { marker } }] },
]))
const harness = new DeepSeekHarness({ profile: 'sdk', patches: [patch], dshHome: join(process.cwd(), 'home'),
  provider: 'close-fixture', model: 'fixture', shutdownTimeoutMs: 5_000, disposeEofGraceMs: 100, disposeGraceMs: 1_000 })
let child, originalKill, primaryError
try {
  const result = await harness.run('Confirm runtime cleanup recovery.')
  assert.equal(result.finalResponse, 'Runtime cleanup recovery verified.')
  child = Reflect.get(harness.client, 'child')
  assert.ok(child instanceof ChildProcess); assert.ok(child.pid !== undefined)
  originalKill = child.kill
  let refusedSignals = 0
  child.kill = () => { refusedSignals++; return false }
  const first = harness.close(); assert.equal(harness.close(), first)
  await assert.rejects(first, /SIGKILL was refused/u)
  assert.equal(await readFile(marker, 'utf8'), 'cleanup-entered')
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null)
  assert.throws(() => harness.client.start(), TransportClosedError)
  await assert.rejects(harness.client.request('session/prompt', { sessionId: 'forbidden', contentBlocks: [] }), TransportClosedError)
  await assert.rejects(harness.client.subscribe().next(), TransportClosedError)
  console.log(JSON.stringify({ phase: 'unconfirmed-close', finalResponse: result.finalResponse,
    cleanupEntered: true, processAlive: true, signalsRefused: refusedSignals > 0, newWorkRefused: true }))
  child.kill = originalKill
  const recovered = harness.close(); assert.equal(harness.close(), recovered)
  await recovered
  assert.ok(child.exitCode !== null || child.signalCode !== null)
  assert.equal(Reflect.get(harness.client, 'child'), child)
  assert.throws(() => harness.client.start(), TransportClosedError)
  console.log(JSON.stringify({ phase: 'confirmed-close', originalProcessExited: true, replacementStarted: false, newWorkRefused: true }))
} catch (error) { primaryError = error; throw error }
finally {
  if (child instanceof ChildProcess && originalKill !== undefined) child.kill = originalKill
  if (child instanceof ChildProcess && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(ready => { child.once('exit', ready) })
    child.kill('SIGKILL'); await exited
  }
  try { await harness.close() }
  catch (error) { if (primaryError === undefined) throw error }
}
