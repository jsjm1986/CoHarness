/** Public CLI startup refuses managed effects before policy providers become available. */
import assert from 'node:assert/strict'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'managed-startup-probe'
export const inject = ['appExit', 'llm', 'subprocess']

/** Observe real model dispatch and process creation through the application's public services. */
export async function apply(ctx, config) {
  assert.ok(config.mode === 'src' || config.mode === 'lib')
  assert.equal(typeof config.managed, 'boolean')
  const repo = new URL('../../../../', import.meta.url)
  const suffix = config.mode === 'src' ? 'src/index.ts' : 'lib/index.js'
  const [{ LlmAdapter }, { executionAuthorityOf }] = await Promise.all([
    import(new URL(`packages/llm/llm/${suffix}`, repo)),
    import(new URL(`packages/context/execution-authority/${suffix}`, repo)),
  ])
  let modelDispatches = 0, processAllocated = false, executionDenied = false, modelError, processError
  class Adapter extends LlmAdapter {
    async *stream() { modelDispatches++; yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['startup-probe'], new Adapter()), 'fixture: model dispatch')
  const witness = join(process.env.HOME, 'startup-allocation')
  await rm(witness, { force: true })
  try {
    for await (const chunk of ctx.llm.stream({ provider: 'startup-probe', model: 'fixture', messages: [] })) {
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') modelError = chunk.reason.failure.code
    }
  } catch (error) { modelError = error.code }
  try {
    const handle = await ctx.subprocess.spawn({
      argv: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1],"allocated")', witness],
      cwd: process.env.HOME, graceMs: 100, signal: AbortSignal.timeout(5000),
      stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    })
    assert.deepEqual(await handle.done, { exitCode: 0, signal: null })
    assert.equal(await handle.waitForExit(AbortSignal.timeout(5000)), true)
    assert.equal(await readFile(witness, 'utf8'), 'allocated'); processAllocated = true
  } catch (error) { processError = error.reason ?? error.code ?? error.message }
  try { executionAuthorityOf(ctx) } catch (error) { executionDenied = error.code === 'execution/forbidden' }
  if (!processAllocated) await assert.rejects(stat(witness), { code: 'ENOENT' })
  const result = { modelDispatches, processAllocated, executionDenied, modelError, processError }
  process.stdout.write(`${JSON.stringify({ launch: config.label, ...result })}\n`)
  const expected = config.managed
    ? { modelDispatches: 0, processAllocated: false, executionDenied: true, modelError: 'MODEL_POLICY_UNAVAILABLE', processError: 'unavailable' }
    : { modelDispatches: 1, processAllocated: true, executionDenied: false }
  ctx.appExit(JSON.stringify(result) === JSON.stringify(expected) ? 0 : 1)
}
