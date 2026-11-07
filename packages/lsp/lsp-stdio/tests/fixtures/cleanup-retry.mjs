/** A real language server survives a failed cleanup observation and must stop before replacement. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [mode] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const root = new URL('../../../../../', import.meta.url)
const entry = path => new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root).href
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
const { boot } = await import(entry('boot/app-boot'))
const home = join(process.cwd(), '.dsh'), workspace = join(process.cwd(), 'workspace')
const config = join(process.cwd(), 'cordis.yml'), pidFile = join(process.cwd(), 'server.pid')
const preload = join(process.cwd(), 'record-pid.mjs')
await mkdir(workspace)
await writeFile(join(workspace, 'source.ts'), 'const source = 1\n')
await writeFile(preload, "import {writeFileSync} from 'node:fs';writeFileSync(process.env.LSP_NATIVE_PID_FILE,String(process.pid))\n")
await writeFile(config, JSON.stringify([
  { name: entry('credentials/credentials-local'), config: { path: join(home, 'credentials.yaml'), dshHome: home, watch: false } },
  { name: entry('core/session') }, { name: entry('lsp/lsp') },
  { name: entry('fs/fs-local'), config: { cwd: workspace } }, { name: entry('subprocess/subprocess-local') },
]))
const ctx = await boot('lsp-cleanup-retry', config), originalSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
let allocations = 0, retryEnabled = false, firstPid, firstFailure
const pids = new Set()
try {
  ctx.subprocess.spawn = async spec => {
    allocations++
    if (allocations > 1) {
      const oldProcessStopped = !alive(firstPid)
      console.log(JSON.stringify({ phase: 'replacement', oldProcessStopped }))
      assert.equal(oldProcessStopped, true, 'A new LSP allocation began before failed native cleanup was retried')
    }
    const handle = await originalSpawn({ ...spec, env: { ...spec.env,
      ...allocations === 1 ? { LSP_FAKE_ENCODING: 'utf-8', LSP_FAKE_NO_SHUTDOWN: '1' } : {},
    } })
    if (allocations !== 1) return handle
    return { ...handle,
      terminate() { if (retryEnabled) handle.terminate() },
      async waitForExit(signal) {
        if (!retryEnabled) { retryEnabled = true; throw new Error('LSP native cleanup observation unavailable') }
        return handle.waitForExit(signal)
      },
    }
  }
  const lsp = await import(entry('lsp/lsp-stdio'))
  const mounted = ctx.plugin(lsp, { servers: { fixture: {
    command: process.execPath,
    args: ['--import', import.meta.resolve('tsx/esm'), '--import', pathToFileURL(preload).href,
      fileURLToPath(new URL('../fixture-server.ts', import.meta.url))],
    env: { LSP_NATIVE_PID_FILE: pidFile, LSP_FAKE_HOVER: JSON.stringify({ contents: 'recovered' }) },
    extensionToLanguage: { '.ts': 'typescript' }, shutdownTimeoutMs: 30, killGraceMs: 30,
  } } })
  await mounted
  const query = { operation: 'hover', filePath: 'source.ts', position: { line: 0, character: 6 }, workspaceRoot: workspace }
  try { await ctx.lsp.query(query) } catch (error) { firstFailure = error }
  assert.ok(firstFailure instanceof AggregateError)
  assert.ok(firstFailure.errors.some(error => error.message === 'LSP native cleanup observation unavailable'))
  firstPid = Number(await readFile(pidFile, 'utf8')); pids.add(firstPid)
  assert.equal(alive(firstPid), true, 'The controlled original cleanup failure did not retain a real native server')
  console.log(JSON.stringify({ phase: 'failed-cleanup', nativeServerStillLive: true, allocations }))
  assert.deepEqual(await ctx.lsp.query(query), { kind: 'hover', hover: { contents: 'recovered' } })
  pids.add(Number(await readFile(pidFile, 'utf8')))
  await mounted.dispose()
  assert.ok([...pids].every(pid => !alive(pid)))
  console.log(JSON.stringify({ phase: 'settled', allocations, nativeServersStopped: pids.size }))
} finally {
  ctx.subprocess.spawn = originalSpawn
  await ctx.fiber.dispose()
}
