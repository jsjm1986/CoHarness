/** Actual authenticated file previews share one native socket without retaining completed reads. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { Agent, request } from 'node:http'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

const [mode] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const root = new URL('../../../../../', import.meta.url)
const entry = path => new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root).href
const http = createRequire(import.meta.url)('node:http'), originalCreate = http.createServer
const sockets = new Map()
http.createServer = (...args) => {
  const server = Reflect.apply(originalCreate, http, args)
  server.on('connection', socket => sockets.set(socket, socket.listenerCount('close')))
  return server
}
syncBuiltinESMExports()
const agent = new Agent({ keepAlive: true, maxSockets: 1 })
let ctx
try {
  const { boot } = await import(entry('boot/app-boot'))
  const home = join(process.cwd(), '.dsh'), config = join(process.cwd(), 'cordis.yml'), path = join(process.cwd(), 'preview.bin')
  await mkdir(home, { recursive: true })
  await writeFile(path, 'native preview')
  await writeFile(config, JSON.stringify([
    { name: entry('credentials/credentials-local'), config: { path: join(home, 'credentials.yaml'), dshHome: home, watch: false } },
    { name: entry('host/webserver'), config: { host: '127.0.0.1', port: 0 } },
    { name: entry('client/connection') }, { name: entry('typert/registry') },
    { name: entry('fs/fs-local'), config: { cwd: process.cwd() } },
    { name: entry('attachment/attachment-local'), config: { dshHome: home } },
    { name: entry('api/gateway') },
  ]))
  ctx = await boot('media-reference-lifetime', config)
  http.createServer = originalCreate
  syncBuiltinESMExports()
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/', handler(req, res) {
    if (ctx.connection.authorizeIndex(req, res)) res.end('ready')
  } }), 'fixture: authenticated index')
  const exchange = (url, method = 'GET', headers = {}) => new Promise((ready, reject) => {
    const pending = request(url, { method, headers, agent, signal: AbortSignal.timeout(10_000) }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('error', reject)
      response.once('end', () => ready({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }))
    })
    pending.once('error', reject)
    pending.end()
  })
  const origin = ctx.webServer.getOrigin(), login = await exchange(ctx.connection.authenticatedUrl(origin + '/'))
  assert.equal(login.status, 303)
  const cookie = login.headers['set-cookie'][0].split(';')[0]
  for (let index = 0; index < 16; index++) {
    const method = index % 2 === 0 ? 'GET' : 'HEAD'
    const result = await exchange(`${origin}/api/file?path=${encodeURIComponent(path)}`, method, { cookie })
    assert.equal(result.status, 200)
    assert.equal(result.text, method === 'HEAD' ? '' : 'native preview')
  }
  assert.equal(sockets.size, 1, 'The example did not reuse one keep-alive connection')
  const [[socket, before]] = sockets
  const orphanedReadCancellations = socket.listenerCount('close') - before
  console.log(JSON.stringify({ previews: 16, connections: sockets.size, authenticated: true,
    contentsVerified: true, orphanedReadCancellations }))
  assert.equal(orphanedReadCancellations, 0, 'Completed file previews retained socket cancellation listeners')
} finally {
  http.createServer = originalCreate
  syncBuiltinESMExports()
  agent.destroy()
  await ctx?.fiber.dispose()
}
