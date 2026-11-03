/** Real Loader and POSIX child with an injected incomplete Linux process-table observation. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'

const config = process.argv[2], bootEntry = process.env.DSH_PROCESS_OBSERVATION_BOOT_ENTRY
if (config === undefined || bootEntry === undefined) throw new Error('Process observation fixture requires config and a boot module')
const root = await mkdtemp(join(tmpdir(), 'dsh-process-observation-'))
const original = { readFileSync: fs.readFileSync, readdirSync: fs.readdirSync }, originalPath = process.env.PATH
const observed = Promise.withResolvers()
let groupPid, descendant, ctx, handle, wait, settled = false
const descendantCode = `
  const fs = require('node:fs');
  process.on('SIGTERM', () => {});
  fs.writeFileSync(process.argv[1], String(process.pid));
  setInterval(() => {}, 60000);
`
const leaderCode = `
  const {spawn} = require('node:child_process');
  const fs = require('node:fs');
  fs.writeFileSync(process.argv[3], String(process.pid));
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}, process.argv[1]], {stdio:'ignore'});
  child.unref();
  const timer = setInterval(() => {if (fs.existsSync(process.argv[2])) {clearInterval(timer);process.exit(0)}}, 10);
`
function running(pid) {
  try {
    process.kill(pid, 0)
    if (process.platform === 'linux') {
      try {
        const raw = original.readFileSync(`/proc/${pid}/stat`, 'utf8')
        return !['Z', 'X'].includes(raw.slice(raw.lastIndexOf(')') + 2).split(/\s+/u)[0])
      } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error }
    }
    return true
  } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
async function bounded(pending) {
  let timer
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Process observation did not settle')), 10_000) })]) }
  finally { clearTimeout(timer) }
}
async function poll(operation) {
  const deadline = performance.now() + 10_000
  for (;;) {
    const value = await operation()
    if (value) return value
    if (performance.now() > deadline) throw new Error('Process observation fixture missed its readiness barrier')
    await delay(10)
  }
}
fs.readdirSync = (...args) => {
  if (args[0] === '/proc' && groupPid !== undefined && descendant !== undefined) return [String(groupPid), String(descendant)]
  return original.readdirSync(...args)
}
fs.readFileSync = (...args) => {
  if (groupPid !== undefined && args[0] === `/proc/${groupPid}/stat`) {
    const fields = ['Z', '1', String(groupPid), String(groupPid), '0', '-1']
    while (fields.length < 19) fields.push('0')
    fields.push('100')
    return `${groupPid} (observed zombie) ${fields.join(' ')}`
  }
  if (descendant !== undefined && args[0] === `/proc/${descendant}/stat`) {
    observed.resolve()
    throw Object.assign(new Error('Injected inaccessible process row'), { code: 'EACCES' })
  }
  return original.readFileSync(...args)
}
syncBuiltinESMExports()
try {
  const { boot, resolveConfigPath } = await import(bootEntry)
  ctx = await boot('subprocess-observation', resolveConfigPath(config, undefined))
  // The isolated fixture selects the documented no-systemd fallback and Linux process-table reader on POSIX.
  process.env.PATH = ''
  ctx.subprocess.internals = { platform: 'linux' }
  handle = await ctx.subprocess.spawn({ argv: [process.execPath, '-e', leaderCode, join(root, 'pid'), join(root, 'proceed'), join(root, 'group')],
    cwd: root, graceMs: 80, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
  groupPid = await poll(async () => {
    try { return Number(await readFile(join(root, 'group'), 'utf8')) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  })
  descendant = await poll(async () => {
    try { return Number(await readFile(join(root, 'pid'), 'utf8')) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  })
  assert.ok(running(descendant))
  wait = handle.waitForExit().then(() => { settled = true })
  await writeFile(join(root, 'proceed'), 'exit')
  assert.equal((await bounded(handle.done)).exitCode, 0)
  await bounded(observed.promise)
  await nextTurn()
  const heldWhileObservationIncomplete = !settled
  assert.equal(heldWhileObservationIncomplete, true)
  assert.equal(running(descendant), true)
  Object.assign(fs, original); syncBuiltinESMExports()
  handle.terminate()
  await wait
  await ctx.fiber.dispose(); ctx = undefined
  process.stdout.write(JSON.stringify({ heldWhileObservationIncomplete, descendantStoppedBeforeRelease: !running(descendant) }) + '\n')
} finally {
  Object.assign(fs, original); syncBuiltinESMExports()
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath
  handle?.terminate()
  if (groupPid === undefined) {
    try { groupPid = Number(await readFile(join(root, 'group'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (groupPid !== undefined) {
    try { process.kill(-groupPid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  await wait
  await ctx?.fiber.dispose()
  if (descendant !== undefined) await poll(() => !running(descendant))
  await rm(root, { recursive: true, force: true })
}
