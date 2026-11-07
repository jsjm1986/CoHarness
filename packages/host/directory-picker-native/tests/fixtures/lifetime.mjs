/** Actual Loader and native helper processes; only the interactive chooser is replaced. */
import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, root, scenario] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
assert.ok(['provider', 'root', 'caller'].includes(scenario))
assert.ok(process.platform === 'darwin' || process.platform === 'linux')
const repo = new URL('../../../../../', import.meta.url), suffix = mode === 'src' ? 'ts' : 'js'
const load = path => import(new URL(`${path}/${mode}/index.${suffix}`, repo))
const [{ Context }, { default: Loader }, { default: Include }, NativePicker] = await Promise.all([
  load('vendor/cordis'), load('vendor/loader'), load('vendor/include'), load('packages/host/directory-picker-native'),
])
await mkdir(root, { recursive: true, mode: 0o700 })
const bin = join(root, 'bin'), choice = join(root, 'choice.json'), selected = join(root, 'selected')
await mkdir(bin, { mode: 0o700 }); await mkdir(selected, { mode: 0o700 })
await symlink(process.execPath, join(bin, 'node'))
const producer = `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
const config=JSON.parse(readFileSync(${JSON.stringify(choice)},'utf8'))
if (!config.hold) process.stdout.write(config.path+'\\n')
else {
  const socket=connect(config.port,'127.0.0.1',()=>socket.write(JSON.stringify({pid:process.pid})+'\\n'))
  socket.on('data',()=>{process.stdout.write(config.path+'\\n');socket.end()})
}
`
await writeFile(join(bin, process.platform === 'darwin' ? 'osascript' : 'zenity'), producer, { mode: 0o700 })
process.env.PATH = bin
const sockets = new Set()
let accepted
const entered = new Promise(resolve => { accepted = resolve })
const server = createServer(socket => {
  sockets.add(socket); socket.once('close', () => sockets.delete(socket))
  let input = ''
  socket.on('data', bytes => {
    input += bytes.toString('utf8')
    if (input.includes('\n')) accepted(JSON.parse(input.split('\n', 1)[0]))
  })
})
server.listen(0, '127.0.0.1'); await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
const address = server.address(); assert.ok(address && typeof address !== 'string')
const ctx = new Context(), caller = new AbortController()
let pending, capability
const output = value => console.log(JSON.stringify(value))
const consumer = { name: 'native-lifetime-consumer', inject: ['directoryPicker'], apply(scope) {
  capability = scope.directoryPicker.capability()
} }
try {
  await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  const modules = new Map([['fixture:native-picker', NativePicker], ['fixture:consumer', consumer]])
  ctx.loader.internal = { version: 'v2', async import(name) { assert.ok(modules.has(name)); return modules.get(name) } }
  const config = join(root, 'cordis.yml')
  await writeFile(config, '- id: native-picker\n  name: fixture:native-picker\n- name: fixture:consumer\n')
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } }); await ctx.loader.await()
  assert.equal(capability?.kind, 'native')
  await writeFile(choice, JSON.stringify({ path: selected, hold: false }), { mode: 0o600 })
  output({ operation: 'normal', selected: await capability.pick(caller.signal) === selected })
  await writeFile(choice, JSON.stringify({ path: selected, hold: true, port: address.port }))
  let refused = false
  pending = capability.pick(caller.signal).then(() => {}, () => { refused = true })
  const { pid } = await entered
  process.kill(pid, 0)
  if (scenario === 'caller') { caller.abort(); await pending }
  else if (scenario === 'root') await ctx.fiber.dispose()
  else {
    const entry = [...ctx.loader.entries()].find(value => value.options.id === 'native-picker')
    assert.ok(entry)
    const fiber = entry.fiber
    await entry.update({ disabled: true }); await fiber.dispose()
    while (fiber.inertia) await fiber.inertia
  }
  let stopped = false
  try { process.kill(pid, 0) } catch (error) { if (error.code !== 'ESRCH') throw error; stopped = true }
  output({ operation: 'retire', pendingRefused: refused, helperStopped: stopped,
    capabilityAvailable: ctx.get('directoryPicker') !== undefined })
  await writeFile(choice, JSON.stringify({ path: selected, hold: false }))
  let lateSelected = false, lateRefused = false
  try { lateSelected = await capability.pick(new AbortController().signal) === selected } catch { lateRefused = true }
  output({ operation: 'retained-capability', selected: lateSelected, refused: lateRefused })
} finally {
  caller.abort()
  if (pending) await pending
  await ctx.fiber.dispose()
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
