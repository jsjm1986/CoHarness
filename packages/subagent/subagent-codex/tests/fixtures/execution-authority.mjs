/** Real Loader and installed Codex retain authority-only parent model control without a resource budget. */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const root = new URL('../../../../../', import.meta.url)
const owned = new Set(['subagent/subagent', 'subagent/subagent-codex'])
const entry = path => mode === 'lib' && artifactRoot !== undefined && owned.has(path)
  ? pathToFileURL(resolve(artifactRoot, path.split('/').at(-1), 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root).href
const externalFixture = new URL('../responses-fixture.ts', import.meta.url)
const hook = registerHooks({ load(url, context, next) {
  if (url !== externalFixture.href) return next(url, context)
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(externalFixture, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText }
} })
const { startResponsesFixture } = await import(externalFixture.href)
const packageManifest = createRequire(import.meta.url).resolve('@openai/codex/package.json')
const codexPackage = JSON.parse(readFileSync(packageManifest, 'utf8'))
assert.equal(codexPackage.version, '0.153.4')
const bin = fileURLToPath(new URL('../../node_modules/.bin', import.meta.url))
let ctx, fixture, run
try {
  const { boot } = await import(entry('boot/app-boot'))
  const { SessionId } = await import(entry('core/session'))
  const { LlmError } = await import(entry('llm/llm'))
  const { LocalSubprocessRuntime } = await import(entry('subprocess/subprocess-local'))
  const workspace = join(process.cwd(), 'workspace'), codexHome = join(process.cwd(), 'codex-home')
  await mkdir(workspace); await mkdir(codexHome)
  for (const allowed of [true, false]) {
    const handles = []
    class ObservedSubprocess extends LocalSubprocessRuntime {
      async spawn(spec) {
        const handle = await super.spawn(spec)
        handles.push(handle)
        return handle
      }
    }
    fixture = await startResponsesFixture([{ kind: 'complete', text: 'AUTHORITY_DONE' }])
    await writeFile(join(codexHome, 'config.toml'), [
      'model = "fixture-model"', 'model_provider = "fixture"', 'approval_policy = "never"',
      'sandbox_mode = "read-only"', 'disable_response_storage = true', 'check_for_update_on_startup = false',
      '[model_providers.fixture]', 'name = "Fixture"', `base_url = "${fixture.baseUrl}"`,
      'env_key = "OPENAI_API_KEY"', 'wire_api = "responses"', 'requires_openai_auth = false',
      '[analytics]', 'enabled = false', '[features]', 'apps = false', 'plugins = false', 'in_app_updates = false', '',
    ].join('\n'))
    const config = join(process.cwd(), 'cordis.yml')
    await writeFile(config, JSON.stringify([
      ...['core/session', 'core/agent', 'llm/llm', 'core/tools', 'core/system-prompt', 'session/session-projection',
        'fs/fs-local', 'session/working-directory', 'subagent/subagent']
        .map(path => ({ name: entry(path) })),
      { name: entry('core/agent-loop'), config: { agents: [] } },
      { name: entry('session/session-persistence-jsonl'), config: { root: join(process.cwd(), `sessions-${allowed}`), compression: 'none' } },
      { name: entry('llm/llm-pi-ai'), config: { providers: { 'authority-fixture': {
        api: 'openai-responses', baseURL: fixture.baseUrl, headers: { authorization: 'Bearer parent-only-authority-fixture-key' },
        models: [{ id: 'fixture-model', maxTokens: 64 }],
      } } } },
      { name: entry('subagent/subagent-codex'), config: {
        stateDir: join(process.cwd(), `bindings-${allowed}`), permissionMode: 'dangerously-bypass-approvals-and-sandbox',
        env: { CODEX_HOME: codexHome, OPENAI_API_KEY: 'child-native-fixture-key',
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' },
        disposeGraceMs: 1000,
      } },
    ]))
    ctx = await boot('subagent-execution-authority', config, undefined, async setup => { await setup.plugin(ObservedSubprocess) })
    const parent = await ctx.agentLoop.create(SessionId(`authority-${allowed}`), { provider: 'authority-fixture', model: 'fixture-model' }, { cwd: workspace })
    const local = new AsyncLocalStorage(), scope = { parentSessionId: parent.id, inputs: [], unverifiedHistory: false }
    ctx.provide('executionAuthority', { capture: () => scope, current: () => local.getStore(),
      runCaptured: (_agent, saved, work) => local.run(saved, work),
    })
    assert.equal(ctx.get('resourceBudget'), undefined)
    assert.equal(ctx.get('modelAccess'), undefined)
    assert.notEqual(ctx.get('resourceBudgetRequired'), true)
    assert.notEqual(ctx.get('modelAccessRequired'), true)
    let checks = 0
    ctx.on('llm/pre-dispatch', async (_options, next) => {
      assert.equal(local.getStore(), scope)
      checks++
      if (!allowed) throw new LlmError('Execution authority denied the child request.', 'MODEL_POLICY_UNAVAILABLE')
      await next()
    })
    run = await local.run(scope, () => ctx.subagents.start('codex', {
      parent, prompt: [{ type: 'text', text: 'Return the fixture marker without tools.' }], signal: new AbortController().signal,
    }))
    const result = await run.result
    await run.dispose(); run = undefined
    await ctx.subagents.waitForChildren(parent); await parent.whenIdle()
    assert.ok(checks > 0)
    assert.equal(fixture.requests.length, allowed ? 1 : 0)
    assert.equal(result.stopReason, allowed ? 'completed' : 'error')
    if (allowed) assert.equal(fixture.requests[0].headers.authorization, 'Bearer parent-only-authority-fixture-key')
    await ctx.fiber.dispose(); ctx = undefined
    assert.ok(handles.length > 0)
    for (const handle of handles) {
      assert.equal(await handle.waitForExit(AbortSignal.timeout(3000)), true)
      await handle.done
    }
    console.log(JSON.stringify({ provider: 'codex', control: 'execution-owner', allowed,
      parentChecked: checks > 0, upstreamRequests: fixture.requests.length, outcome: result.stopReason, runtimeClosed: true }))
    await fixture.close(); fixture = undefined
  }
} finally {
  try { await run?.dispose() } finally {
    try { await ctx?.fiber.dispose() } finally { await fixture?.close(); hook.deregister() }
  }
}
