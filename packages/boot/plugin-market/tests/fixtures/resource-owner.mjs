/** A real Loader, profile manager and HTTP index retain parser admission through queue waits. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const root = new URL('../../../../../', import.meta.url)
const entry = path => path === 'boot/plugin-market' && artifactRoot !== undefined
  ? pathToFileURL(resolve(artifactRoot, 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root).href
const threads = createRequire(import.meta.url)('node:worker_threads')
const OriginalWorker = threads.Worker, workers = []
threads.Worker = class extends OriginalWorker {
  constructor(...args) {
    super(...args)
    const record = { exited: false, completion: undefined }
    record.completion = new Promise(ready => this.once('exit', () => { record.exited = true; ready() }))
    workers.push(record)
  }
}
syncBuiltinESMExports()
let ctx, unblock
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ format: 1, title: 'Market', plugins: [] }))
})
try {
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
  const { boot, initProfile } = await import(entry('boot/app-boot'))
  const home = process.cwd(), dir = join(home, 'profile'), config = join(home, 'cordis.yml')
  initProfile(dir, [])
  const installAnchor = join(home, 'installation.json')
  await writeFile(installAnchor, JSON.stringify({ name: 'market-owner-installation', dependencies: {} }))
  const changes = ['replaced', 'withdrawn', 'unchanged', 'independent']
  const indexes = changes.map(change => `http://127.0.0.1:${server.address().port}/${change}.json`)
  await writeFile(config, JSON.stringify([
    { name: entry('boot/plugin-manager') }, { name: entry('boot/plugin-market'), config: { indexes } },
  ]))
  ctx = await boot('market-owner', config, undefined, inner => {
    inner.provide('profileContext', { name: 'market-owner', startedBundles: [], dir,
      patchPath: join(dir, 'cordis.patch.yml'), installAnchor, cwd: home, home, overlays: [], telemetryDisabledEnv: undefined })
  })
  const query = { sort: { kind: 'index' }, offset: 0, limit: 1 }
  for (const [index, change] of changes.entries()) {
    let admissions = 0, releases = 0, uncertainties = 0, replacementAdmissions = 0
    const entered = Promise.withResolvers(), grant = Promise.withResolvers()
    unblock = () => grant.resolve()
    const lease = () => {
      let settled = false
      return { signal: new AbortController().signal,
        release: async () => { if (!settled) { settled = true; releases++ } },
        uncertain: async () => { uncertainties++ } }
    }
    const budget = { async acquire(request) {
      assert.equal(request.kind, 'process'); assert.equal(request.origin, 'infrastructure')
      admissions++; entered.resolve(); await grant.promise; return lease()
    } }
    const requirement = change === 'independent' ? undefined : ctx.effect(() => ctx.provide('resourceBudgetRequired', true))
    const registration = change === 'independent' ? undefined : ctx.effect(() => ctx.provide('resourceBudget', budget))
    const before = workers.length
    let replacement, fresh
    try {
      const pending = ctx.pluginMarket.search(indexes[index], query).then(value => ({ success: true, total: value.total }),
        error => ({ success: false, code: error.code, unavailable: error.cause?.reason === 'unavailable' }))
      if (change !== 'independent') await entered.promise
      if (change === 'replaced' || change === 'withdrawn') {
        await registration(); await requirement()
        if (change === 'replaced') replacement = ctx.effect(() => ctx.provide('resourceBudget', {
          async acquire() { replacementAdmissions++; return lease() },
        }))
      }
      grant.resolve()
      const outcome = await pending
      await Promise.all(workers.slice(before).map(worker => worker.completion))
      console.log(JSON.stringify({ change, ...outcome, workers: workers.length - before,
        exited: workers.slice(before).every(worker => worker.exited), admissions, releases, uncertainties, replacementAdmissions }))
      if (!outcome.success) {
        assert.equal(outcome.unavailable, true)
        await replacement?.()
        fresh = ctx.effect(() => ctx.provide('resourceBudget', budget))
        const retryBefore = workers.length, retry = await ctx.pluginMarket.search(indexes[index], query)
        await Promise.all(workers.slice(retryBefore).map(worker => worker.completion))
        assert.equal(workers.length - retryBefore, 1)
        assert.equal(retry.total, 0)
      }
    } finally { await fresh?.(); await replacement?.(); await registration?.(); await requirement?.() }
  }
} finally {
  unblock?.()
  try { await ctx?.fiber.dispose() } finally {
    threads.Worker = OriginalWorker; syncBuiltinESMExports()
    await new Promise((ready, reject) => { server.close(error => error ? reject(error) : ready()) })
  }
}
