/** External browser and model fixtures around the real provider, Worker, and RPC. */
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import workerThreads from 'node:worker_threads'
import ts from 'typescript'
import assert from 'node:assert/strict'

export const name = 'browser-use-stagehand-native-fixture'
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt', 'llm', 'attachments']

const packageRoot = new URL('../../../packages/experimental/browser-use-stagehand-native/', import.meta.url)
const sdkFixture = new URL('tests/fixtures/stagehand.ts', packageRoot).href
const chromiumFixture = new URL('tests/fixtures/chromium.ts', packageRoot).href
const cdpFixture = new URL('tests/fixtures/cdp.ts', packageRoot).href
const urlCodec = pathToFileURL(createRequire(import.meta.url).resolve('punycode/')).href

/**
 * Install three external browser fixtures while preserving their original import locations.
 * @returns the disposer for this isolate's resolve hook and compiled-fixture maps.
 */
export function installExternalBrowserHooks() {
  const compiled = new Map(), origins = new Map()
  const fixture = (url) => {
    let target = compiled.get(url)
    if (target === undefined) {
      const source = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText
      target = new URL(`data:text/javascript,${encodeURIComponent(source)}#${encodeURIComponent(url)}`).href
      compiled.set(url, target); origins.set(target, url)
    }
    return { url: target, shortCircuit: true }
  }
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      context = { ...context, parentURL: origins.get(context.parentURL) ?? context.parentURL }
      if (specifier === 'punycode' && /\/(?:whatwg-url\/lib\/url-state-machine|tr46\/index)\.js$/u.test(context.parentURL ?? '')) {
        return { url: urlCodec, shortCircuit: true }
      }
      if (specifier === 'playwright-core') return fixture(cdpFixture)
      if (specifier === '@puppeteer/browsers') return fixture(chromiumFixture)
      if (specifier === '@deepseek-ai/dsh-subprocess-local') {
        const actual = nextResolve(specifier, context).url
        const proxy = `export * from ${JSON.stringify(actual)};
import { LocalSubprocessRuntime as Base } from ${JSON.stringify(actual)};
import { allocateChromium } from ${JSON.stringify(chromiumFixture)};
export class LocalSubprocessRuntime extends Base {
  spawnProcess(spec) {
    if (spec.argv.some(arg => arg.startsWith('--user-data-dir=') && arg.includes('dsh-stagehand-chrome-'))) return allocateChromium(spec);
    return super.spawnProcess(spec);
  }
}`
        return { url: `data:text/javascript,${encodeURIComponent(proxy)}`, shortCircuit: true }
      }
      if (specifier !== '@browserbasehq/stagehand') {
        const result = nextResolve(specifier, context)
        return [sdkFixture, chromiumFixture, cdpFixture].includes(result.url) ? fixture(result.url) : result
      }
      const actual = nextResolve(specifier, context).url
      const proxy = `export * from ${JSON.stringify(sdkFixture)}; export { ClientLLMSchema } from ${JSON.stringify(actual)};`
      return { url: `data:text/javascript,${encodeURIComponent(proxy)}`, shortCircuit: true }
    },
  })
  return () => { hooks.deregister(); compiled.clear(); origins.clear() }
}

/**
 * Prepend external SDK fixtures only to the production Stagehand Worker entry.
 * @param {string | URL} filename - Original Worker entry from the real provider.
 * @returns {string | URL} The original entry or a fixture-prefixed bootstrap.
 */
export function wrapStagehandWorkerEntry(filename) {
  const sourceWorker = new URL('src/worker.ts', packageRoot).href
  const builtWorker = new URL('lib/worker.js', packageRoot).href
  const stagehand = filename instanceof URL && (filename.href === builtWorker
    || filename.protocol === 'data:' && filename.href.includes(encodeURIComponent(sourceWorker)))
  if (!stagehand) return filename
  const bootstrap = `import { installExternalBrowserHooks } from ${JSON.stringify(import.meta.url)}; installExternalBrowserHooks(); await import(${JSON.stringify(filename.href)});`
  return new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`)
}

/** Keep the real Stagehand Worker while installing its external SDK fixture before entry. */
export function installBrowserFixtureHooks() {
  const removeHooks = installExternalBrowserHooks()
  const NativeWorker = workerThreads.Worker
  class BrowserFixtureWorker extends NativeWorker {
    constructor(filename, options) {
      super(wrapStagehandWorkerEntry(filename), options)
    }
  }
  workerThreads.Worker = BrowserFixtureWorker
  syncBuiltinESMExports()
  return () => {
    workerThreads.Worker = NativeWorker
    syncBuiltinESMExports()
    removeHooks()
  }
}

export async function apply(ctx) {
  ctx.effect(installBrowserFixtureHooks, 'browser-use-stagehand-native-fixture.module')
  const { LlmAdapter } = await import('@deepseek-ai/dsh-llm')
  ctx.llm.registerAdapter(['browser-fixture'], new class extends LlmAdapter {
    async * stream() {
      assert.ok(ctx.agents.currentInitiator(), 'browser inference must have a live initiating Agent')
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"extraction":"Fixture heading"}' } }
      yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }())
  const lifetime = new AbortController(), active = new Set()
  let sessionProcesses = 0, sessionModels = 0, closing = false
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('resourceBudget', { async acquire(request) {
    assert.equal(closing, false)
    request.signal?.throwIfAborted()
    if (request.kind === 'process' && request.sessionId !== undefined) {
      assert.ok(ctx.agents.get(request.sessionId), 'browser process must retain its live Session')
      sessionProcesses++
    }
    if (request.kind === 'model' && request.sessionId !== undefined) {
      assert.equal(ctx.agents.currentInitiator()?.id, request.sessionId)
      sessionModels++
    }
    const completion = Promise.withResolvers()
    active.add(completion)
    return { signal: lifetime.signal,
      async release() { active.delete(completion); completion.resolve() },
      async uncertain() { throw new Error('Browser snapshot did not confirm managed process completion') },
    }
  } })
  ctx.effect(() => async () => {
    closing = true
    lifetime.abort(new Error('Native browser snapshot accountant disposed'))
    await Promise.all([...active].map(completion => completion.promise))
    assert.ok(sessionProcesses >= 2, 'owned Chromium and connection Worker both require Session admission')
    assert.ok(sessionModels >= 1, 'extension inference must use Session model admission')
  })
  const provider = await import('@deepseek-ai/dsh-experimental-browser-use-stagehand-native')
  await ctx.plugin(provider, {
    mode: 'launch', model: { provider: 'browser-fixture', model: 'browser-model' },
  })
}
