/** Real Loader/Web composition keeps unrestricted debugging out of managed execution. */
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const t0 = Date.now()
const mark = step => process.stderr.write(`[fixture] ${step} +${Date.now() - t0}ms\n`)
mark('argv parsed')
const root = new URL('../../../../../', import.meta.url)
const entry = path => path === 'experimental/inspector' && artifactRoot !== undefined
  ? pathToFileURL(join(artifactRoot, mode === 'src' ? 'src/index.ts' : 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root).href
const threads = createRequire(import.meta.url)('node:worker_threads')
const OriginalWorker = threads.Worker, workers = []
threads.Worker = class extends OriginalWorker {
  constructor(...args) {
    super(...args)
    const record = { exited: false }
    record.completion = new Promise(ready => this.once('exit', () => { record.exited = true; ready() }))
    workers.push(record)
  }
}
syncBuiltinESMExports()
const print = console.log
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('dsh inspector: ')) return
  Reflect.apply(print, console, args)
}
const { boot } = await import(entry('boot/app-boot'))
mark('app-boot imported')
const { default: ExecutionAuthority } = await import(entry('context/execution-authority'))
mark('execution-authority imported')
class FixtureAuthority extends ExecutionAuthority {
  stamp() { throw new Error('Fixture does not stamp messages') }
  answer() { throw new Error('Fixture does not answer questions') }
  runCaptured() { throw new Error('Fixture does not run captured work') }
  runRequest() { throw new Error('Fixture does not run requests') }
  capture() { throw new Error('Fixture does not capture execution') }
  current() { return undefined }
  captureSession() { throw new Error('Fixture does not capture Sessions') }
  inherit() { throw new Error('Fixture does not inherit execution') }
  relay() { throw new Error('Fixture does not relay execution') }
  authorize() { throw new Error('Fixture does not authorize debugging') }
  authorizeSelection() { throw new Error('Fixture does not select presets') }
}

let ctx, unblock, socket
try {
  const config = join(process.cwd(), 'cordis.yml'), home = join(process.cwd(), '.dsh')
  await writeFile(config, JSON.stringify([
    { name: entry('credentials/credentials-local'), config: { path: join(home, 'credentials.yaml'), dshHome: home, watch: false } },
    { name: entry('host/webserver'), config: { host: '127.0.0.1', port: 0 } },
    { name: entry('client/connection') },
  ]))
  mark('config written')
  ctx = await boot('inspector-managed-debugging', config)
  mark('boot settled')
  const origin = ctx.webServer.getOrigin()
  mark('origin acquired')
  const fetchBootstrap = async () => {
    const response = await fetch(ctx.connection.authenticatedUrl(`${origin}/api/experimental-inspector/bootstrap`))
    await response.body?.cancel()
    return response.status
  }
  const evaluate = async () => {
    socket = new WebSocket(ctx.connection.authenticatedUrl(`${origin.replace(/^http/u, 'ws')}/inspector/devtools/cdp`))
    socket.on('error', () => {})
    await new Promise((ready, reject) => { socket.once('open', ready); socket.once('error', reject) })
    const answer = new Promise((ready, reject) => {
      socket.on('message', raw => { const message = JSON.parse(raw.toString()); if (message.id === 1) ready(message) })
      socket.once('error', reject)
    })
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '21*2' } }))
    const result = await answer
    assert.equal(result.result?.result?.value, 42)
    return true
  }
  for (const control of ['independent', 'required', 'provider']) {
    for (const isolated of control === 'independent' ? [false] : [false, true]) {
    for (const timing of control === 'independent' ? ['before'] : ['before', 'queued', 'running']) {
      const before = workers.length
      let policy, budget, mounted, evaluated = false, status, closedByPolicy = false
      let releases = 0, uncertainties = 0, admissions = 0
      const entered = Promise.withResolvers(), grant = Promise.withResolvers()
      unblock = () => grant.resolve()
      const install = async () => {
        if (control === 'required') return ctx.effect(() => ctx.provide('executionAuthorityRequired', true))
        const fiber = await ctx.plugin(FixtureAuthority)
        return () => fiber.dispose()
      }
      try {
        if (timing === 'before' && control !== 'independent') policy = await install()
        if (timing === 'queued') budget = ctx.effect(() => ctx.provide('resourceBudget', { async acquire() {
          admissions++; entered.resolve(); await grant.promise
          return { signal: new AbortController().signal, release: async () => { releases++ },
            uncertain: async () => { uncertainties++ } }
        } }))
        const id = `debug-${control}-${String(isolated)}-${timing}`
        mark(`${id} loader.create`)
        const pending = ctx.loader.create({ id, name: entry('experimental/inspector'),
          ...isolated ? { isolate: { executionAuthority: true, executionAuthorityRequired: true } } : {}, config: { port: 0, captureFetch: false } })
          .then(async () => {
            mounted = [...ctx.loader.entries()].find(row => row.options.id === id)
            assert.ok(mounted?.fiber)
            await mounted.fiber.await()
            return { ready: true }
          }).catch(error => ({ ready: false, forbidden: error.message.includes('Inspector requires an independent local runtime') }))
        if (timing === 'queued') { await entered.promise; policy = await install(); grant.resolve() }
        const outcome = await pending
        mark(`${id} loader settled ready=${outcome.ready}`)
        if (outcome.ready) { status = await fetchBootstrap(); mark(`${id} bootstrap ${status}`); evaluated = await evaluate(); mark(`${id} evaluated=${evaluated}`) }
        if (timing === 'running') {
          policy = await install()
          await Promise.all(workers.slice(before).map(worker => worker.completion))
          closedByPolicy = workers.slice(before).every(worker => worker.exited)
          const response = await fetch(`${origin}/inspector/devtools/devtools_app.html`)
          status = response.status; await response.body?.cancel()
        }
        await mounted?.fiber?.dispose()
        socket?.terminate(); socket = undefined
        await Promise.all(workers.slice(before).map(worker => worker.completion))
        mark(`${id} workers settled`)
        console.log(JSON.stringify({ control, isolated, timing, ...outcome, evaluated,
          ...status === undefined ? {} : { status }, closedByPolicy,
          published: ctx.get('inspector') !== undefined,
          workers: workers.length - before, exited: workers.slice(before).every(worker => worker.exited),
          admissions, releases, uncertainties }))
        if (control === 'independent' || timing === 'running') {
          assert.equal(outcome.ready, true)
          assert.equal(evaluated, true)
          assert.equal(workers.length - before, 1)
          if (timing === 'running') { assert.equal(closedByPolicy, true); assert.equal(status, 404) }
          else assert.equal(status, 200)
        } else {
          assert.deepEqual(outcome, { ready: false, forbidden: true })
          assert.equal(workers.length - before, 0)
          assert.equal(evaluated, false)
        }
        assert.equal(ctx.get('inspector'), undefined)
        assert.equal(admissions, releases)
        assert.equal(uncertainties, 0)
      } finally {
        grant.resolve(); socket?.terminate(); socket = undefined
        await mounted?.fiber?.dispose(); await policy?.(); await budget?.()
      }
    }
    }
  }
} finally {
  unblock?.(); socket?.terminate()
  try { await ctx?.fiber.dispose() } finally {
    console.log = print; threads.Worker = OriginalWorker; syncBuiltinESMExports()
  }
}
