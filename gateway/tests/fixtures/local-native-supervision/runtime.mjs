/** Real Loader/process composition; the SDK fixture answers only its transport handshake. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

const sdk = process.argv[2] === '--profile'
const role = sdk ? 'sdk' : process.argv[2], root = sdk ? process.env.NATIVE_SUPERVISION_ROOT : process.argv[3]
assert.ok(root)
process.on('SIGTERM', () => {})
const own = { pid: process.pid, cgroup: (await readFile('/proc/self/cgroup', 'utf8')).trim().split('::')[1] }
if (role === 'escaped') {
  await writeFile(`${root}/${process.argv[4]}.json`, JSON.stringify(own))
} else if (role === 'pipe' || role === 'pty') {
  const name = process.argv[4]
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'escaped', root, `${name}-escaped`], { detached: true, stdio: 'ignore' }).unref()
  await writeFile(`${root}/${name}.json`, JSON.stringify(own))
  if (role === 'pty') process.stdout.write('NATIVE_PTY_READY\n')
} else {
  if (!sdk) assert.deepEqual(JSON.parse(readFileSync(3, 'utf8')), { fixture: true })
  const ctx = new Context()
  ctx.baseUrl = new URL('./', import.meta.url).href
  await ctx.plugin(Loader)
  await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-include', config: { path: './cordis.yml' } })
  await ctx.loader.await()
  assert.ok(ctx.subprocess, 'the real cordis.yml must load the local provider')
  const name = sdk ? 'sdk-pipe' : 'pipe'
  await ctx.subprocess.spawn({ argv: [process.execPath, fileURLToPath(import.meta.url), 'pipe', root, name], cwd: root,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 4096 } }, graceMs: 80 })
  if (sdk) {
    await writeFile(`${root}/sdk.json`, JSON.stringify(own))
    createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line)
      if (message.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        result: { serverInfo: { name: 'native-supervision-transport-fixture', version: '1' } } }) + '\n')
    })
  } else {
    const terminal = await ctx.subprocess.spawnTerminal({ argv: [process.execPath, fileURLToPath(import.meta.url), 'pty', root, 'pty'],
      cwd: root, rows: 24, cols: 80, terminalType: 'dumb', graceMs: 80 })
    let output = ''; terminal.output.on('data', chunk => { output += chunk.toString() })
    const harness = new DeepSeekHarness({ dshBin: fileURLToPath(import.meta.url), processCwd: root, cwd: root,
      env: { ...scrubbedParentEnv(), NATIVE_SUPERVISION_ROOT: root }, initializeTimeoutMs: 10_000 })
    await harness.start()
    const deadline = performance.now() + 15_000
    for (;;) {
      let filesReady = false
      try {
        await Promise.all(['pipe', 'pipe-escaped', 'pty', 'pty-escaped', 'sdk', 'sdk-pipe', 'sdk-pipe-escaped']
          .map(name => readFile(`${root}/${name}.json`, 'utf8').then(JSON.parse)))
        filesReady = true
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (filesReady && output.includes('NATIVE_PTY_READY')) break
      if (performance.now() >= deadline) throw new Error('Native process composition did not become ready')
      await delay(10)
    }
    await writeFile(`${root}/ready.json`, JSON.stringify(own))
  }
}
setInterval(() => {}, 60_000)
