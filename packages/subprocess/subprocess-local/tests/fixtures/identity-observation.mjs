/** Real kernel processes and inspection; only one unavailable OS observation is injected. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, statSync } from 'node:fs'

const [mode] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
assert.ok(process.platform === 'darwin' || process.platform === 'linux')
const moduleUrl = new URL(`../../${mode === 'src' ? 'src' : 'lib/types'}/process-inspector.${mode === 'src' ? 'ts' : 'js'}`, import.meta.url)
const { createProcessInspector, parseProcStat } = await import(moduleUrl)
const child = spawn(process.execPath, ['-e', "setInterval(()=>{},1000);process.on('disconnect',()=>process.exit(0));process.send({ready:true})"], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {},
})
const watchdog = setTimeout(() => { child.kill('SIGKILL') }, 15_000)
let unavailable = false
const signals = []
const output = value => console.log(JSON.stringify(value))
const refused = operation => { try { operation(); return false } catch { return true } }
try {
  await once(child, 'message')
  assert.ok(child.pid)
  const linux = process.platform === 'linux'
  const statPath = `/proc/${child.pid}/stat`
  const identity = { pid: child.pid, started: linux ? parseProcStat(readFileSync(statPath, 'utf8')).started
    : execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(child.pid)], { encoding: 'utf8' }).trim() }
  const inspector = createProcessInspector(1000, process.platform, process.arch, {
    readFile(path) {
      if (unavailable && linux && path === statPath) throw Object.assign(new Error('fixture process stat unavailable'), { code: 'EACCES' })
      return readFileSync(path, 'utf8')
    },
    readDir: path => readdirSync(path), readLink: path => readlinkSync(path), stat: path => statSync(path),
    open: path => openSync(path, 'r'), read: (fd, buffer, length, position) => readSync(fd, buffer, 0, length, position), close: closeSync,
    exec(file, args) {
      const text = execFileSync(file, args, { encoding: 'utf8' })
      if (!unavailable || linux) return text
      return text.split('\n').map(line => new RegExp('^\\s*'+child.pid+'\\s').test(line) ? 'fixture unreadable process row' : line).join('\n')
    },
    kill(pid, signal) { assert.equal(pid, child.pid); signals.push(signal); process.kill(pid, signal) },
  })
  output({ operation: 'normal', alive: inspector.isAlive(identity) })
  unavailable = true
  const observed = inspector.snapshot()
  const liveRefused = refused(() => inspector.isAlive(identity))
  const snapshotRefused = refused(() => observed.alive(identity))
  const signalRefused = refused(() => inspector.signalProcess(identity, 'SIGKILL'))
  process.kill(child.pid, 0)
  output({ operation: 'unavailable', liveRefused, snapshotRefused, signalRefused,
    noSignalSent: signals.length === 0, childStillAlive: child.exitCode === null && child.signalCode === null })
  unavailable = false
  assert.equal(inspector.isAlive(identity), true)
  const closed = once(child, 'close')
  inspector.signalProcess(identity, 'SIGTERM')
  await closed
  output({ operation: 'recovered', signals, childClosed: child.exitCode !== null || child.signalCode !== null })
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close'); child.kill('SIGKILL'); await closed
  }
  clearTimeout(watchdog)
}
