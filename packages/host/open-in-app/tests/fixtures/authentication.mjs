/** Real Loader, HTTP and browser authentication with a paused desktop request. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, root] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const repo = new URL('../../../../../', import.meta.url)
const suffix = mode === 'src' ? 'ts' : 'js'
const load = path => import(new URL(`${path}/${mode}/index.${suffix}`, repo))
const [{ Context }, { default: Loader }, { default: Include }, { default: WebServer }, OpenInApp, Connection] = await Promise.all([
  load('vendor/cordis'), load('vendor/loader'), load('vendor/include'),
  load('packages/host/webserver'), load('packages/host/open-in-app'), load('packages/client/connection'),
])
const ctx = new Context()
let record, releaseRequest, enteredRequest, heldRequest, pending
let hold = false
const status = async (path, headers) => {
  const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(5_000) })
  await response.arrayBuffer()
  return response.status
}
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`)
let base
try {
  ctx.provide('credentials', { async modifyRecord(_key, mutate) { record = await mutate(record) ?? record; return record } })
  ctx.provide('subprocess', { async resolveExecutable() { throw new Error('fixture has no desktop launcher') } })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map([
    ['fixture:webserver', WebServer], ['fixture:desktop', OpenInApp], ['fixture:connection', Connection],
  ])
  ctx.loader.internal = { version: 'v2', async import(name) {
    assert.ok(modules.has(name), `Unexpected fixture module: ${name}`)
    return modules.get(name)
  } }
  const config = join(root, 'cordis.yml')
  await writeFile(config, [
    '- id: webserver', '  name: fixture:webserver', '  config:', '    host: 127.0.0.1', '    port: 0',
    '',
  ].join('\n'))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  base = ctx.webServer.getOrigin()
  const server = ctx.webServer, register = server.register.bind(server)
  server.register = route => register({ ...route, handler: async (req, res) => {
    if (hold && route.path === '/open-in-app/open') {
      enteredRequest(); await heldRequest
    }
    return route.handler(req, res)
  } })
  const desktopConfig = join(root, 'desktop.yml')
  await writeFile(desktopConfig, [
    '- id: desktop', '  name: fixture:desktop', '  config:', '    probeTimeoutMs: 1000', '    iconTimeoutMs: 1000', '    launchWatchMs: 50',
    '- id: connection', '  name: fixture:connection', '  disabled: true', '',
  ].join('\n'))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(desktopConfig).href } })
  await ctx.loader.await()
  output({ operation: 'before-authentication', statuses: await Promise.all([
    status('/open-in-app/apps'), status('/open-in-app/icon/finder'), status('/open-in-app/open'),
  ]) })
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'connection')
  assert.ok(entry)
  await entry.update({ disabled: false }); await ctx.loader.await()
  assert.ok(ctx.get('connection'))
  // The actual Connection exchanges its synthetic process token for a scoped browser cookie.
  let cookie
  const target = new URL(ctx.connection.authenticatedUrl(base))
  const response = {
    writeHead(code, headers) { assert.equal(code, 303); cookie = headers['set-cookie'].split(';', 1)[0] },
    end() {},
  }
  assert.equal(ctx.connection.authorizeIndex({ method: 'GET', url: target.pathname + target.search,
    headers: { host: target.host } }, response), false)
  assert.ok(cookie)
  const headers = { cookie }
  output({ operation: 'active-authentication', anonymous: await status('/open-in-app/open'), authenticated: await status('/open-in-app/open', headers) })
  heldRequest = new Promise(resolve => { releaseRequest = resolve })
  const entered = new Promise(resolve => { enteredRequest = resolve })
  hold = true
  pending = status('/open-in-app/open', headers)
  void pending.catch(() => {})
  await entered
  const original = entry.fiber
  await entry.update({ disabled: true }); await original.dispose()
  assert.equal(ctx.get('connection'), undefined)
  releaseRequest(); hold = false
  output({ operation: 'authentication-withdrawal', admittedRequest: await pending, newRequest: await status('/open-in-app/open') })
  await entry.update({ disabled: false }); await ctx.loader.await()
  output({ operation: 'authentication-replacement', anonymous: await status('/open-in-app/open'), authenticated: await status('/open-in-app/open', headers) })
  const desktop = [...ctx.loader.entries()].find(entry => entry.options.id === 'desktop')
  await desktop.fiber.dispose()
  output({ operation: 'desktop-unload', status: await status('/open-in-app/open') })
} finally {
  releaseRequest?.()
  if (pending) await Promise.allSettled([pending])
  await ctx.fiber.dispose()
}
