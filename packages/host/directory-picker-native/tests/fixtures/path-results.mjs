/** Real provider, Loader, processes and POSIX paths; only the interactive choice is replaced. */
import assert from 'node:assert/strict'
import { mkdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, root] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
assert.ok(process.platform === 'darwin' || process.platform === 'linux')
const repo = new URL('../../../../../', import.meta.url), suffix = mode === 'src' ? 'ts' : 'js'
const load = path => import(new URL(`${path}/${mode}/index.${suffix}`, repo))
const [{ Context }, { default: Loader }, { default: Include }, NativePicker] = await Promise.all([
  load('vendor/cordis'), load('vendor/loader'), load('vendor/include'), load('packages/host/directory-picker-native'),
])
await mkdir(root, { recursive: true, mode: 0o700 })
const bin = join(root, 'bin'), choice = join(root, 'choice.json')
await mkdir(bin, { mode: 0o700 })
await symlink(process.execPath, join(bin, 'node'))
const producer = `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const selected = JSON.parse(readFileSync(${JSON.stringify(choice)}, 'utf8'))
if (process.platform === 'darwin') {
  const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
    'function run() { return '+JSON.stringify(selected ?? '')+'; }'], { timeout: 5000 })
  if (result.error) throw result.error
  if (result.signal || result.status !== 0) throw new Error('Native JXA path serialization failed')
  process.stdout.write(result.stdout)
} else process.stdout.write((selected ?? '')+'\\n')
`
await writeFile(join(bin, process.platform === 'darwin' ? 'osascript' : 'zenity'), producer, { mode: 0o700 })
process.env.PATH = bin
const ctx = new Context()
let finished = false
const consumer = { name: 'native-path-consumer', inject: ['directoryPicker'], async apply(scope) {
  const capability = scope.directoryPicker.capability()
  assert.equal(capability.kind, 'native')
  for (const [name, ending] of [['normal', ''], ['lf', '\n'], ['cr', '\r'], ['crlf', '\r\n'], ['two-lf', '\n\n']]) {
    const selected = join(root, name + '-目录' + ending)
    await mkdir(selected, { mode: 0o700 })
    await writeFile(choice, JSON.stringify(selected), { mode: 0o600 })
    const actual = await capability.pick(new AbortController().signal)
    const exists = actual !== null && await stat(actual).then(info => info.isDirectory(), () => false)
    console.log(JSON.stringify({ case: name, exactPath: actual === selected, directoryExists: exists }))
  }
  await writeFile(choice, 'null')
  assert.equal(await capability.pick(new AbortController().signal), null)
  console.log(JSON.stringify({ case: 'cancel', selected: null }))
  finished = true
} }
try {
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map([['fixture:native-picker', NativePicker], ['fixture:consumer', consumer]])
  ctx.loader.internal = { version: 'v2', async import(name) { assert.ok(modules.has(name)); return modules.get(name) } }
  const config = join(root, 'cordis.yml')
  await writeFile(config, '- name: fixture:native-picker\n- name: fixture:consumer\n')
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const errors = ctx.logger.buffer.filter(message => message.type === 'error')
  assert.equal(finished, true, errors.flatMap(message => message.args).map(String).join('\n'))
} finally { await ctx.fiber.dispose() }
assert.equal(ctx.get('directoryPicker'), undefined)
