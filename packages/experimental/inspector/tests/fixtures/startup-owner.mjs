/** Real Web/Connection/Inspector composition rejects stale resource owners before native startup. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scheduler } from 'node:timers/promises'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const root = new URL('../../../../../', import.meta.url)
const entry = path => path === 'experimental/inspector' && artifactRoot !== undefined
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
const print = console.log
let announcements = 0
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('dsh inspector: ')) { announcements++; return }
  Reflect.apply(print, console, args)
}
let ctx, unblock
try {
  const { boot } = await import(entry('boot/app-boot'))
  const { default: ResourceBudget } = await import(entry('context/resource-budget'))
  const config = join(process.cwd(), 'cordis.yml'), home = join(process.cwd(), '.dsh')
  await writeFile(config, JSON.stringify([
    { name: entry('credentials/credentials-local'), config: { path: join(home, 'credentials.yaml'), dshHome: home, watch: false } },
    { name: entry('host/webserver'), config: { host: '127.0.0.1', port: 0 } },
    { name: entry('client/connection') },
  ]))
  ctx = await boot('inspector-startup-owner', config)
  for (const change of ['replaced', 'withdrawn', 'unchanged', 'independent']) {
    let admissions = 0, releases = 0, uncertainties = 0, replacementAdmissions = 0
    const entered = Promise.withResolvers(), grant = Promise.withResolvers()
    unblock = () => grant.resolve()
    const lease = () => {
      let settled = false
      return { signal: new AbortController().signal,
        release: async () => { if (!settled) { settled = true; releases++ } },
        uncertain: async () => { uncertainties++ } }
    }
    class Budget extends ResourceBudget {
      async acquire(request) {
        assert.equal(request.kind, 'process'); assert.equal(request.origin, 'infrastructure')
        admissions++; entered.resolve(); await grant.promise; return lease()
      }
    }
    const requirement = change === 'independent' ? undefined : ctx.effect(() => ctx.provide('resourceBudgetRequired', true))
    const registration = change === 'independent' ? undefined : await ctx.plugin(Budget)
    let replacement, mounted
    const before = workers.length, announcedBefore = announcements
    try {
      const load = ctx.loader.create({ id: `inspector-${change}`, name: entry('experimental/inspector'), config: { port: 0, captureFetch: false } })
      const pending = load.then(async () => {
        mounted = [...ctx.loader.entries()].find(row => row.options.id === `inspector-${change}`)
        assert.ok(mounted?.fiber, 'Inspector did not mount')
        await mounted.fiber.await()
        return { ready: true }
      }).catch(error => ({ ready: false, unavailable: error.reason === 'unavailable' }))
      if (change !== 'independent') await entered.promise
      if (change === 'replaced' || change === 'withdrawn') {
        await registration.dispose(); await requirement()
        if (change === 'replaced') replacement = ctx.effect(() => ctx.provide('resourceBudget', {
          async acquire() { replacementAdmissions++; return lease() },
        }))
      }
      grant.resolve()
      const outcome = await pending
      const published = ctx.get('inspector') !== undefined
      await mounted?.fiber?.dispose()
      await Promise.all(workers.slice(before).map(worker => worker.completion))
      console.log(JSON.stringify({ change, ...outcome, published, announcements: announcements - announcedBefore,
        workers: workers.length - before, exited: workers.slice(before).every(worker => worker.exited),
        admissions, releases, uncertainties, replacementAdmissions }))
      if (!outcome.ready) {
        assert.equal(outcome.unavailable, true)
        await replacement?.()
        const fresh = await ctx.plugin(Budget)
        try {
          const retryBefore = workers.length
          await ctx.loader.create({ id: `retry-${change}`, name: entry('experimental/inspector'), config: { port: 0, captureFetch: false } })
          const retry = [...ctx.loader.entries()].find(row => row.options.id === `retry-${change}`)
          assert.ok(retry?.fiber)
          await retry.fiber.await()
          assert.ok(ctx.get('inspector'))
          await retry.fiber.dispose()
          await Promise.all(workers.slice(retryBefore).map(worker => worker.completion))
          assert.equal(workers.length - retryBefore, 1)
        } finally { await fresh.dispose() }
      }
    } finally {
      grant.resolve()
      await mounted?.fiber?.dispose(); await replacement?.(); await registration?.dispose(); await requirement?.()
    }
  }
  for (const clientMode of ['live', 'abandoned']) {
    let releases = 0, mounted, response, received, startup
    const grant = Promise.withResolvers(), entered = Promise.withResolvers(), requestClosed = Promise.withResolvers()
    unblock = () => grant.resolve()
    const client = new AbortController(), before = workers.length
    const registration = ctx.effect(() => ctx.provide('resourceBudget', { async acquire(request) {
      assert.equal(request.kind, 'process'); assert.equal(request.origin, 'infrastructure')
      entered.resolve(); await grant.promise
      return { signal: new AbortController().signal, release: async () => { releases++ },
        uncertain: async () => { throw new Error('Unexpected bootstrap Worker uncertainty') } }
    } }))
    const carrier = createServer((request, reply) => {
      request.once('close', () => { requestClosed.resolve({ request, reply }) })
      request.resume()
      void ctx.connection.dispatchHttp(request, reply).then(matched => { if (!matched) reply.writeHead(404).end() })
    })
    try {
      startup = ctx.loader.create({ id: `bootstrap-${clientMode}`, name: entry('experimental/inspector'), config: { port: 0, captureFetch: false } })
        .then(async () => {
          mounted = [...ctx.loader.entries()].find(row => row.options.id === `bootstrap-${clientMode}`)
          assert.ok(mounted?.fiber)
          await mounted.fiber.await()
        })
      await entered.promise
      await new Promise((ready, reject) => { carrier.once('error', reject); carrier.listen(0, '127.0.0.1', ready) })
      const path = '/api/experimental-inspector/bootstrap'
      response = fetch(ctx.connection.authenticatedUrl(`http://127.0.0.1:${carrier.address().port}${path}`), { signal: client.signal })
      received = response.then(async value => ({ status: value.status, body: await value.text() }), error => ({ error }))
      const native = await requestClosed.promise
      await scheduler.yield()
      assert.equal(native.request.complete, true)
      const headersBefore = native.reply.headersSent
      let fetchRejected, replyUntouched
      if (clientMode === 'abandoned') {
        const socketClosed = native.reply.destroyed || native.reply.writableEnded ? Promise.resolve()
          : new Promise(ready => native.reply.once('close', ready))
        client.abort()
        fetchRejected = 'error' in await received
        await socketClosed; await scheduler.yield()
        replyUntouched = !native.reply.headersSent && !native.reply.writableEnded
      }
      grant.resolve()
      await startup
      const result = await received
      if ('status' in result && result.status === 200) assert.match(JSON.parse(result.body).endpoint, /\/ingest$/)
      await mounted.fiber.dispose()
      await Promise.all(workers.slice(before).map(worker => worker.completion))
      console.log(JSON.stringify({ phase: 'bootstrap', client: clientMode, headersBefore,
        ...clientMode === 'live' ? { status: result.status } : { fetchRejected, replyUntouched },
        workers: workers.length - before, exited: workers.slice(before).every(worker => worker.exited), releases }))
    } finally {
      grant.resolve(); client.abort()
      await received
      await startup?.catch(() => {})
      await mounted?.fiber?.dispose(); await registration()
      if (carrier.listening) await new Promise(ready => { carrier.closeAllConnections(); carrier.close(ready) })
    }
  }
} finally {
  unblock?.()
  try { await ctx?.fiber.dispose() } finally {
    console.log = print; threads.Worker = OriginalWorker; syncBuiltinESMExports()
  }
}
