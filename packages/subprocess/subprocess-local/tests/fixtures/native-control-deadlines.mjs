/** Real native helper deadlines and retained workload ownership through the Loader. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [config] = process.argv.slice(2)
const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
assert.ok(mode === 'src' || mode === 'lib')
const relative = mode === 'src' ? 'src' : 'lib/types'
const { createProcessInspector } = await import(new URL(`../../${relative}/process-inspector.${mode === 'src' ? 'ts' : 'js'}`, import.meta.url))
const { createWindowsProcessInspector } = await import(new URL(`../../${relative}/windows-inspector.${mode === 'src' ? 'ts' : 'js'}`, import.meta.url))
const { boot, resolveConfigPath } = await import(process.env.DSH_CONTROL_BOOT_ENTRY)
const originalExec = childProcess.execFileSync, originalSpawn = childProcess.spawnSync
const root = await mkdtemp(join(tmpdir(), 'subprocess-native-deadlines-'))
const frames = [], observations = []
let ctx, target, targetPid, sequence = 0
const commandTimeoutMs = 2000
const helperProgram = `
  const fs = require('node:fs');
  process.on('SIGTERM', () => {});
  fs.writeFileSync(process.argv[1], String(process.pid), { flag: 'wx', mode: 0o600 });
  setTimeout(() => process.exit(213), 5000);
`

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}

async function helperClosed(path) {
  const pid = Number(await readFile(path, 'utf8'))
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  return !alive(pid)
}

async function until(check) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Fixture readiness was not observed')), 15_000)
  try { while (!await check()) await delay(10, undefined, { signal: controller.signal }) }
  finally { clearTimeout(timer) }
}

try {
  ctx = await boot('native-control-deadlines', resolveConfigPath(config, undefined))
  ctx.subprocess.internals.platform = 'win32'
  target = await ctx.subprocess.spawn({ argv: [process.execPath, '-e',
    'const parent = process.ppid; process.stdout.write(String(process.pid)); setTimeout(() => process.exit(213), 30000); setInterval(() => { try { process.kill(parent, 0) } catch { process.exit(0) } }, 100)'],
    cwd: root, graceMs: commandTimeoutMs,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
  })
  await until(() => {
    const text = target.collected.stdout.readFrom(0).text
    if (!/^\d+$/u.test(text)) return false
    targetPid = Number(text)
    return true
  })
  assert.ok(alive(targetPid))

  let psPath, psTimedOut = false
  childProcess.execFileSync = (file, args, options) => {
    if (file !== '/bin/ps') return originalExec(file, args, options)
    psPath = join(root, `helper-${sequence++}`)
    return originalExec(process.execPath, ['-e', helperProgram, psPath], options)
  }
  syncBuiltinESMExports()
  try { createProcessInspector(commandTimeoutMs, 'darwin').snapshot().tree(targetPid) }
  catch (error) { psTimedOut = error.code === 'ETIMEDOUT' && error.signal === 'SIGKILL' }
  childProcess.execFileSync = originalExec
  syncBuiltinESMExports()
  frames.push({ operation: 'process-query', timedOut: psTimedOut, helperClosed: await helperClosed(psPath), targetAlive: alive(targetPid) })

  childProcess.spawnSync = (file, args, options) => {
    if (file !== 'taskkill') return originalSpawn(file, args, options)
    assert.equal(Number(args[1]), targetPid)
    const path = join(root, `helper-${sequence++}`)
    const result = originalSpawn(process.execPath, ['-e', helperProgram, path], options)
    observations.push({ path, timedOut: result.error?.code === 'ETIMEDOUT', signal: result.signal })
    return result
  }
  syncBuiltinESMExports()
  target.terminateForHostExit()
  const ordinary = observations.at(-1)
  assert.ok(ordinary !== undefined)
  frames.push({ operation: 'ordinary-termination', timedOut: ordinary.timedOut && ordinary.signal === 'SIGKILL', helperClosed: await helperClosed(ordinary.path), targetAlive: alive(targetPid) })

  const windows = createWindowsProcessInspector(commandTimeoutMs)
  windows.signalGroup(targetPid, 'SIGKILL')
  const terminal = observations.at(-1)
  assert.ok(terminal !== undefined && terminal !== ordinary)
  frames.push({ operation: 'terminal-termination', timedOut: terminal.timedOut && terminal.signal === 'SIGKILL', helperClosed: await helperClosed(terminal.path), targetAlive: alive(targetPid) })
  childProcess.spawnSync = originalSpawn
  syncBuiltinESMExports()

  const poll = new AbortController()
  poll.abort()
  assert.equal(await target.waitForExit(poll.signal), false)
  process.kill(targetPid, 'SIGKILL')
  await target.done
  assert.equal(await target.waitForExit(), true)
  const targetClosed = !alive(targetPid)
  targetPid = undefined
  frames.push({ operation: 'verified-workload-exit', targetClosed })
  for (const frame of frames) process.stdout.write(JSON.stringify(frame) + '\n')
  assert.equal(frames.slice(0, 3).every(frame => frame.timedOut && frame.helperClosed && frame.targetAlive), true)
} finally {
  childProcess.execFileSync = originalExec
  childProcess.spawnSync = originalSpawn
  syncBuiltinESMExports()
  if (targetPid !== undefined && alive(targetPid)) process.kill(targetPid, 'SIGKILL')
  if (target !== undefined) { await target.done; await target.waitForExit() }
  if (ctx !== undefined) await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
