/** Lossless workflow returns through the real Loader, PTC process and workflow host. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Workflow result fixture requires src or lib')
const artifact = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
const entry = path => new URL(`../../../../${path}/${artifact}`, import.meta.url)
const { boot } = await import(entry('boot/app-boot'))
const { LlmAdapter } = await import(entry('llm/llm'))
const { SessionId } = await import(entry('core/session'))
const plugins = [
  ['core/session'], ['core/agent'], ['llm/llm'], ['core/tools'], ['core/system-prompt'],
  ['session/session-projection'], ['core/agent-loop', { agents: [] }],
  ['fs/fs-local'], ['session/working-directory'], ['subprocess/subprocess-local'], ['sandbox/sandbox-local'],
  ['sandbox/sandbox-policy', { mode: 'danger-full-access', workspaceRoot: process.cwd() }],
  ['ptc-runtime/ptc-runtime-node'], ['subagent/subagent'], ['workflow/workflow-ptc'],
]
const config = join(process.cwd(), 'cordis.yml')
await writeFile(config, JSON.stringify(plugins.map(([path, options]) => ({
  name: entry(path).href, ...(options === undefined ? {} : { config: options }),
}))))
const ctx = await boot('workflow-result-fixture', config)
class Adapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream() { throw new Error('The result fixture cannot request a model.') }
}
try {
  ctx.llm.registerAdapter(['result-fixture'], new Adapter())
  ctx.subagents.registerProvider({
    name: 'spawn', inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: false },
    start: () => Promise.reject(new Error('The result fixture cannot start a child.')),
  })
  const parent = await ctx.agentLoop.create(SessionId('workflow-result-fixture'), { provider: 'result-fixture', model: 'fixture' }, { cwd: process.cwd() })
  for (const key of [null, '00', '01', '1.0', '1e0', '0x1', ' 1', '-0', '']) {
    const run = ctx.workflowEngine.start({
      parent,
      meta: { name: 'lossless-result', description: 'Keep every returned array value or refuse serialization.' },
      script: key === null ? 'return [10, 20]' : `return Object.assign([10, 20], { [${JSON.stringify(key)}]: 'retained report' })`,
    })
    try {
      const result = await run.result
      assert.equal(result.stopReason, key === null ? 'completed' : 'error', result.error)
      assert.equal(result.agentsStarted, 0)
      if (key === null) assert.deepEqual(result.value, [10, 20])
      else { assert.equal(result.value, null); assert.match(result.error, /non-index properties/) }
      process.stdout.write(`${JSON.stringify({ key, status: result.stopReason, value: result.value })}\n`)
    } finally { await run.dispose() }
  }
} finally { await ctx.fiber.dispose() }
