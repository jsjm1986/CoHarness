/** Independent real Inspector plugins restore ambient fetch while native requests retain their owners. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const root = new URL('../../../../../', import.meta.url)
const entry = path => path === 'experimental/inspector' && artifactRoot !== undefined
  ? pathToFileURL(resolve(artifactRoot, mode === 'src' ? 'src/index.ts' : 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root).href
const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
const threads = createRequire(import.meta.url)('node:worker_threads')
const OriginalWorker = threads.Worker, workers = [], contexts = []
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
const server = createServer((request, response) => { request.resume(); response.writeHead(204).end() })
let primaryError
try {
  const { boot } = await import(entry('boot/app-boot'))
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
  const url = `http://127.0.0.1:${server.address().port}/native`
  for (const order of [[1, 0], [0, 1]]) {
    const current = [], before = workers.length
    for (let index = 0; index < 2; index++) {
      const directory = join(process.cwd(), `owner-${order.join('')}-${index}`), home = join(directory, '.dsh')
      await mkdir(directory)
      const config = join(directory, 'cordis.yml')
      await writeFile(config, JSON.stringify([
        { name: entry('credentials/credentials-local'), config: { path: join(home, 'credentials.yaml'), dshHome: home, watch: false } },
        { name: entry('host/webserver'), config: { host: '127.0.0.1', port: 0 } },
        { name: entry('client/connection') },
        { id: 'capture-owner', name: entry('experimental/inspector'), config: { port: 0, captureFetch: true } },
      ]))
      const ctx = await boot(`inspector-fetch-owner-${index}`, config)
      contexts.push(ctx)
      const mounted = [...ctx.loader.entries()].find(row => row.options.id === 'capture-owner')
      assert.ok(mounted?.fiber)
      await mounted.fiber.await()
      assert.ok(ctx.get('inspector'))
      current.push({ ctx, fiber: mounted.fiber, fetch: globalThis.fetch })
    }
    const request = async callable => {
      const response = await callable(url)
      await response.arrayBuffer()
      assert.equal(response.status, 204)
      return true
    }
    await request(globalThis.fetch)
    await current[order[0]].fiber.dispose()
    const live = current[order[1]]
    const activeWrapperPreserved = globalThis.fetch === live.fetch
    assert.equal(activeWrapperPreserved, true)
    const activeRequestCompleted = await request(globalThis.fetch)
    await live.fiber.dispose()
    await Promise.all(workers.slice(before).map(record => record.completion))
    const originalFetchRestored = globalThis.fetch === descriptor.value
    const retainedRequestCompleted = await request(current[0].fetch)
    console.log(JSON.stringify({ order, workers: workers.length - before, exited: workers.slice(before).every(record => record.exited),
      activeWrapperPreserved, activeRequestCompleted, originalFetchRestored, retainedRequestCompleted }))
    assert.equal(originalFetchRestored, true, 'Disposed Inspector capture was restored as global fetch')
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'fetch'), descriptor)
  }
} catch (error) { primaryError = error; throw error }
finally {
  const errors = []
  for (const ctx of contexts.reverse()) { try { await ctx.fiber.dispose() } catch (error) { errors.push(error) } }
  await Promise.all(workers.map(record => record.completion))
  try {
    if (server.listening) await new Promise((ready, reject) => {
      server.closeAllConnections(); server.close(error => error ? reject(error) : ready())
    })
  } catch (error) { errors.push(error) }
  console.log = print; threads.Worker = OriginalWorker; syncBuiltinESMExports()
  if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'fetch')
  else Object.defineProperty(globalThis, 'fetch', descriptor)
  if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Inspector fetch fixture cleanup failed')
}
