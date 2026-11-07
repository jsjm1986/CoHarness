/** Built HMR lifecycle acceptance; requires `pnpm run build` and Node `--expose-internals`. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { FSWatcher } from 'chokidar'
import Hmr from '../../lib/index.js'

const directory = await mkdtemp(join(tmpdir(), 'dsh-hmr-built-owner-'))
const filename = join(directory, 'plugins.yml')
const ctx = new Context()
ctx.baseUrl = pathToFileURL(directory).href + '/'
let starting, watcher, restore = () => {}, emit
try {
  await writeFile(filename, '[]')
  await ctx.plugin(Loader)
  await ctx.plugin(Timer)
  const provider = ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  await provider
  const prototype = FSWatcher.prototype
  const descriptors = { emit: Object.getOwnPropertyDescriptor(prototype, 'emit'), add: Object.getOwnPropertyDescriptor(prototype, 'add') }
  emit = prototype.emit
  const add = prototype.add
  let ready
  const nativeReady = new Promise(resolve => { ready = resolve })
  Object.defineProperty(prototype, 'add', { configurable: true, writable: true, value: function (...args) {
    watcher = this
    return Reflect.apply(add, this, args)
  } })
  Object.defineProperty(prototype, 'emit', { configurable: true, writable: true, value: function (event, ...args) {
    if (this === watcher && event === 'ready') { ready(); return false }
    return Reflect.apply(emit, this, [event, ...args])
  } })
  restore = () => {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor === undefined) Reflect.deleteProperty(prototype, key)
      else Object.defineProperty(prototype, key, descriptor)
    }
  }
  starting = ctx.hmr.watchConfig(filename, async () => {}).then(dispose => ({ dispose }), error => ({ error }))
  await nativeReady
  assert(Object.values(watcher.getWatched()).flat().includes('plugins.yml'), 'Native config watch did not allocate')
  await provider.dispose()
  assert.deepEqual(watcher.getWatched(), {}, 'Provider unloading retained a native watch before readiness')
  assert.equal((await starting).error?.message, 'Configuration watch stopped during startup')
  restore()
  await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  await (await ctx.hmr.watchConfig(filename, async () => {}))()
  process.stdout.write(JSON.stringify({ closedBeforeReady: true, replacementReady: true }) + '\n')
} finally {
  restore()
  if (watcher !== undefined && emit !== undefined) Reflect.apply(emit, watcher, ['ready'])
  if (starting !== undefined) { const outcome = await starting; await outcome.dispose?.() }
  try { await watcher?.close(); await ctx.fiber.dispose() }
  finally { await rm(directory, { recursive: true, force: true }) }
}
