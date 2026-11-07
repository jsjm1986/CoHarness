/** Real Loader and PTY ownership under wall-clock changes and recovered process observation. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import filesystem from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { installWindowsObservationInput } from './windows-observation-input.mjs'

const config = process.argv[2], bootEntry = process.env.DSH_TERMINAL_CLOCK_BOOT_ENTRY
const selected = process.env.DSH_TERMINAL_CLOCK_SCENARIO ?? 'all'
assert.ok(config !== undefined && bootEntry !== undefined)
assert.ok(['all', 'normal', 'frozen', 'recovery', 'partial', 'windows-read'].includes(selected))
const { boot, resolveConfigPath } = await import(bootEntry)
const inspectProcessFile = filesystem.readFileSync

async function bounded(operation, timeoutMs) {
  let timer
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Terminal termination did not settle under its owner')), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}

async function until(check) {
  const deadline = performance.now() + 20_000
  for (;;) {
    if (await check()) return
    if (performance.now() >= deadline) throw new Error('Terminal fixture readiness or cleanup was not observed')
    await delay(10)
  }
}

async function json(path) {
  let value
  await until(async () => {
    try { value = JSON.parse(await readFile(path, 'utf8')); return true }
    catch (error) { if (error.code === 'ENOENT') return false; throw error }
  })
  return value
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    if (process.platform === 'linux') {
      try {
        const raw = inspectProcessFile(`/proc/${pid}/stat`, 'utf8')
        return !['Z', 'X'].includes(raw.slice(raw.lastIndexOf(')') + 2).split(/\s+/u)[0])
      } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error }
    }
    return true
  }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}

const descendantProgram = `
  const fs = require('node:fs');
  const publish = (path, value) => { const pending = path + '.' + process.pid; fs.writeFileSync(pending, JSON.stringify(value)); fs.renameSync(pending, path) };
  process.on('SIGTERM', () => { publish(process.argv[2], { termObserved: true }) });
  process.on('SIGHUP', () => {});
  publish(process.argv[1], { pid: process.pid });
  setInterval(() => {}, 60000);
`
const leaderProgram = `
  const { spawn } = require('node:child_process');
  process.on('SIGTERM', () => {});
  process.on('SIGHUP', () => {});
  spawn(process.execPath, ['-e', ${JSON.stringify(descendantProgram)}, process.argv[1], process.argv[2]], { stdio: 'ignore' });
  setInterval(() => {}, 60000);
`

for (const scenario of selected === 'all' ? ['normal', 'frozen', 'recovery', 'partial', 'windows-read'] : [selected]) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-terminal-clock-'))
  const originalNow = Date.now, originalPath = process.env.PATH
  const originalReadDirectory = filesystem.readdirSync, originalReadFile = filesystem.readFileSync, originalCommand = childProcess.execFileSync
  const originalPrepend = process.prependListener
  let ctx, handle, descendant, sibling, siblingDescendant, termination, primaryError, retainedExits = [], unreadable = false
  let windowsInput
  const failures = []
  const confirmed = new Set()
  const close = async operation => { try { await operation() } catch (error) { failures.push(error) } }
  try {
    if (scenario === 'recovery' || scenario === 'partial' || scenario === 'windows-read') process.prependListener = function (event, listener) {
      if (event === 'exit') retainedExits.push(listener)
      return originalPrepend.call(this, event, listener)
    }
    ctx = await boot('terminal-clock', resolveConfigPath(config, undefined))
    process.prependListener = originalPrepend
    if (scenario === 'windows-read') {
      const inspectorEntry = process.env.DSH_TERMINAL_CLOCK_WINDOWS_INSPECTOR_ENTRY
      const posixEntry = process.env.DSH_TERMINAL_CLOCK_POSIX_INSPECTOR_ENTRY
      assert.ok(inspectorEntry !== undefined && posixEntry !== undefined)
      const { createProcessInspector } = await import(posixEntry)
      windowsInput = installWindowsObservationInput(inspectorEntry, createProcessInspector(1000), () => [handle?.pid, descendant].filter(pid => pid !== undefined))
      const { createWindowsProcessInspector } = await import(inspectorEntry)
      ctx.subprocess.terminalInspector = createWindowsProcessInspector(1000)
      ctx.subprocess.internals.platform = 'win32'
    }
    // Without a user-manager executable, Linux selects its documented terminal-session fallback.
    process.env.PATH = ''
    handle = await ctx.subprocess.spawnTerminal({ argv: [process.execPath, '-e', leaderProgram, join(root, 'child.json'), join(root, 'term.json')],
      cwd: root, rows: 24, cols: 80, terminalType: 'dumb', graceMs: 100, shellActivity: scenario === 'partial' || scenario === 'windows-read' })
    handle.output.resume()
    descendant = (await json(join(root, 'child.json'))).pid
    assert.ok(Number.isSafeInteger(descendant) && descendant > 0 && descendant !== handle.pid)
    assert.equal(alive(handle.pid), true); assert.equal(alive(descendant), true)
    process.kill(descendant, 'SIGTERM')
    assert.deepEqual(await json(join(root, 'term.json')), { termObserved: true })
    assert.equal(alive(descendant), true)
    if (scenario === 'recovery') {
      assert.equal(retainedExits.length, 1)
      await handle.inspectForeground()
      sibling = await ctx.subprocess.spawnTerminal({ argv: [process.execPath, '-e', leaderProgram, join(root, 'sibling.json'), join(root, 'sibling-term.json')],
        cwd: root, rows: 24, cols: 80, terminalType: 'dumb', graceMs: 100 })
      sibling.output.resume()
      siblingDescendant = (await json(join(root, 'sibling.json'))).pid
      assert.ok(Number.isSafeInteger(siblingDescendant) && siblingDescendant > 0 && siblingDescendant !== sibling.pid)
      await sibling.inspectForeground()
      const expected = new Error('Owned terminal process-table observation is unavailable')
      const logged = []
      let observationRefusals = 0
      ctx.logger.error = error => { logged.push(error) }
      filesystem.readdirSync = (...args) => {
        if (unreadable && args[0] === '/proc') { observationRefusals++; throw expected }
        return originalReadDirectory(...args)
      }
      childProcess.execFileSync = (...args) => {
        if (unreadable && args[0] === '/bin/ps') { observationRefusals++; throw expected }
        return originalCommand(...args)
      }
      // The failed unload's host-exit finalizer may force-stop live members
      // where identity signalling survives the observation fault: /bin/ps is
      // already refused on darwin, and on linux each signal's identity fence
      // reads the target's own stat row — refuse the sibling's so its shell
      // provably survives and stays unconfirmed for the retention checks
      // below, instead of racing the kill's done→release() settle edge.
      if (process.platform === 'linux') {
        const siblingStat = `/proc/${sibling.pid}/stat`
        filesystem.readFileSync = (...args) => {
          if (unreadable && args[0] === siblingStat) { observationRefusals++; throw expected }
          return originalReadFile(...args)
        }
      }
      syncBuiltinESMExports()
      unreadable = true
      await ctx.fiber.dispose()
      const unavailable = error => error === expected || process.platform === 'linux'
        && error instanceof Error && error.message === 'Cannot inspect processes: /proc directory is unreadable'
      assert.ok(observationRefusals > 0, 'The owned process-table fault must reach cleanup')
      assert.ok(logged.some(error => unavailable(error) || error?.errors?.some(unavailable)))
      assert.ok(retainedExits.every(listener => process.listeners('exit').includes(listener)))
      unreadable = false
    }
    if (scenario === 'partial') {
      await handle.inspectForeground()
      filesystem.readFileSync = (...args) => {
        if (unreadable && args[0] === `/proc/${descendant}/stat`) throw Object.assign(new Error('Owned process row is unavailable'), { code: 'EACCES' })
        return originalReadFile(...args)
      }
      childProcess.execFileSync = (...args) => {
        const result = originalCommand(...args)
        if (!unreadable || args[0] !== '/bin/ps' || !args[1].includes('-axo')) return result
        return result.split('\n').filter(line => Number(line.trim().split(/\s+/u)[0]) !== descendant).join('\n') + '\nowned process row unavailable\n'
      }
      syncBuiltinESMExports(); unreadable = true
      process.kill(handle.pid, 'SIGKILL')
      await bounded(handle.done, 5000)
      await assert.rejects(bounded(handle.terminate(), 5000), /process observation is incomplete/u)
      assert.equal(alive(descendant), true)
      const logged = []
      ctx.logger.error = error => { logged.push(error) }
      await ctx.fiber.dispose()
      assert.ok(logged.length > 0)
      assert.equal(retainedExits.length, 1)
      assert.ok(retainedExits.every(listener => process.listeners('exit').includes(listener)))
      unreadable = false
    }
    if (scenario === 'windows-read') {
      await handle.inspectForeground()
      windowsInput.setUnavailable(true)
      process.kill(handle.pid, 'SIGKILL')
      await bounded(handle.done, 5000)
      await assert.rejects(bounded(handle.terminate(), 5000), /OpenProcess failed \(Win32 5\)/u)
      assert.equal(alive(descendant), true)
      const logged = []
      ctx.logger.error = error => { logged.push(error) }
      await ctx.fiber.dispose()
      assert.ok(logged.length > 0)
      assert.equal(retainedExits.length, 1)
      assert.ok(retainedExits.every(listener => process.listeners('exit').includes(listener)))
      windowsInput.setUnavailable(false)
    }
    if (scenario === 'frozen') Date.now = () => 1_700_000_000_000
    termination = handle.terminate()
    await bounded(termination, 5000)
    await handle.done
    await until(() => !alive(handle.pid) && !alive(descendant))
    if (scenario === 'recovery') {
      assert.ok(retainedExits.every(listener => process.listeners('exit').includes(listener)), 'Another unconfirmed terminal must retain the provider exit callback')
      await bounded(sibling.terminate(), 5000)
      await sibling.done
      await until(() => !alive(sibling.pid) && !alive(siblingDescendant))
      assert.ok(retainedExits.every(listener => !process.listeners('exit').includes(listener)), 'Recovered terminal cleanup must release its disposed provider exit callback')
    }
    if (scenario === 'partial' || scenario === 'windows-read') assert.ok(retainedExits.every(listener => !process.listeners('exit').includes(listener)), 'Unreadable observation must retain cleanup until the surviving descendant stops')
    await ctx.fiber.dispose(); ctx = undefined
    process.stdout.write(scenario === 'windows-read'
      ? 'Win32 identity-read failure retains a real PTY descendant and its disposed provider exit protection until verified cleanup.\n'
      : scenario === 'partial'
      ? 'Partial process observation retains a root-exited PTY and its live descendant until verified retry cleanup.\n'
      : scenario === 'recovery'
      ? 'Recovered terminal cleanup releases its disposed provider exit callback after verified process exit.\n'
      : scenario === 'normal'
      ? 'Terminal termination joins a real PTY and its TERM-resistant descendant.\n'
      : 'A frozen wall clock cannot prevent terminal escalation or retain the owned process session.\n')
  } catch (error) { primaryError = error; throw error }
  finally {
    Date.now = originalNow
    process.prependListener = originalPrepend
    unreadable = false
    windowsInput?.setUnavailable(false)
    filesystem.readdirSync = originalReadDirectory; filesystem.readFileSync = originalReadFile; childProcess.execFileSync = originalCommand; syncBuiltinESMExports()
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath
    if (handle !== undefined) await close(async () => {
      await bounded(handle.terminate(), 20_000)
      if (!alive(handle.pid)) confirmed.add(handle.pid)
      if (descendant !== undefined && !alive(descendant)) confirmed.add(descendant)
    })
    if (sibling !== undefined) await close(async () => {
      await bounded(sibling.terminate(), 20_000)
      if (!alive(sibling.pid)) confirmed.add(sibling.pid)
      if (siblingDescendant !== undefined && !alive(siblingDescendant)) confirmed.add(siblingDescendant)
    })
    if (termination !== undefined) await close(() => bounded(termination, 20_000))
    if (ctx !== undefined) await close(() => bounded(ctx.fiber.dispose(), 20_000))
    if (descendant === undefined) {
      try { descendant = JSON.parse(await readFile(join(root, 'child.json'), 'utf8')).pid }
      catch (error) { if (error.code !== 'ENOENT') failures.push(error) }
    }
    if (siblingDescendant === undefined) {
      try { siblingDescendant = JSON.parse(await readFile(join(root, 'sibling.json'), 'utf8')).pid }
      catch (error) { if (error.code !== 'ENOENT') failures.push(error) }
    }
    for (const pid of [descendant, handle?.pid, siblingDescendant, sibling?.pid]) {
      if (pid === undefined || confirmed.has(pid)) continue
      try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') failures.push(error) }
    }
    let stopped = true
    for (const pid of [descendant, handle?.pid, siblingDescendant, sibling?.pid]) if (pid !== undefined) {
      try { await until(() => !alive(pid)) } catch (error) { stopped = false; failures.push(error) }
    }
    if (stopped) {
      for (const listener of retainedExits) process.off('exit', listener)
      await close(() => rm(root, { recursive: true, force: true }))
    }
    else failures.push(new Error('Unconfirmed terminal ownership retained at ' + root))
    windowsInput?.restore()
    if (failures.length > 0) {
      // oxlint-disable-next-line no-unsafe-finally -- Preserve primary and cleanup failures together.
      throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], 'Terminal clock fixture cleanup failed')
    }
  }
}
