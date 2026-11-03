/** Linux-only keyless acceptance through compiled Gateway, real Loader, pipe, PTY and SDK spawn. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { LocalLauncher } from '../lib/launcher.js'
import { localLinuxRuntimeEmpty, probeLocalLinuxScope } from '../lib/local-runtime-linux.js'
import { nativeFixture } from './fixtures/local-native-supervision/spec.mjs'

assert.equal(process.platform, 'linux', 'native supervision acceptance requires Linux')
assert.ok(await probeLocalLinuxScope(5000), 'native supervision acceptance requires a functioning user systemd manager')
const root = await mkdtemp(join(tmpdir(), 'hgw-native-supervision-')), entries = [], transcript = []
const execute = promisify(execFile)
const names = ['pipe', 'pipe-escaped', 'pty', 'pty-escaped', 'sdk', 'sdk-pipe', 'sdk-pipe-escaped']
async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function poll(operation, label) {
  const deadline = performance.now() + 30_000
  for (;;) {
    const value = await operation()
    if (value) return value
    if (performance.now() >= deadline) throw new Error(label)
    await delay(10)
  }
}
async function live(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
    return !['Z', 'X'].includes(raw.slice(raw.lastIndexOf(')') + 2).split(/\s+/u)[0])
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error }
}
async function start(directory) {
  const { cfg, runtime } = nativeFixture(directory), owner = new LocalLauncher(cfg).attach(runtime)
  const gateway = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/local-native-supervision/gateway.mjs', import.meta.url)), directory],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: process.env })
  const entry = { owner, gateway, directory, facts: undefined }; entries.push(entry)
  let diagnostics = ''; gateway.stderr.on('data', chunk => { diagnostics += chunk.toString() })
  await new Promise((resolve, reject) => {
    gateway.once('message', resolve); gateway.once('error', reject)
    gateway.once('exit', () => reject(new Error(`Disposable Gateway exited before readiness: ${diagnostics}`)))
  })
  const main = await poll(async () => {
    try { return await json(`${directory}/ready.json`) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  }, 'Native Runtime did not publish readiness')
  const descendants = await Promise.all(names
    .map(name => json(`${directory}/${name}.json`)))
  entry.facts = [main, ...descendants]
  const record = await owner.store.read()
  assert.equal(record.nativeRange, 'linux-slice')
  const slice = `dshruntime${record.nonce.replaceAll('-', '')}.slice`
  for (const facts of [main, ...descendants]) assert.ok(facts.cgroup.includes(`/${slice}/`), 'every process must remain in its inherited Runtime slice')
  assert.ok(descendants[0].cgroup.includes('dsh-subprocess-'))
  assert.ok(descendants[2].cgroup.includes('dsh-terminal-'))
  assert.ok(descendants[5].cgroup.includes('dsh-subprocess-'))
  return entry
}
async function killGateway(entry) {
  if (entry.gateway.exitCode !== null || entry.gateway.signalCode !== null) return
  const exited = once(entry.gateway, 'exit'); entry.gateway.kill('SIGKILL'); await exited
}
async function stopped(entry) {
  await entry.owner.terminate(1000)
  assert.equal(entry.owner.hasExited(), true)
  assert.equal(await localLinuxRuntimeEmpty(await entry.owner.store.read(), 5000), true)
  await poll(async () => (await Promise.all(entry.facts.map(facts => live(facts.pid)))).every(value => !value), 'Runtime descendant survived confirmed stop')
}
try {
  const recovered = await start(root)
  await killGateway(recovered)
  assert.equal(await recovered.owner.isAlive(), true)
  await stopped(recovered)
  transcript.push('Gateway SIGKILL: recovered stop joins pipe, PTY, SDK child scopes and setsid descendants.')

  const orphanRoot = await mkdtemp(join(tmpdir(), 'hgw-native-orphan-'))
  const orphan = await start(orphanRoot)
  await killGateway(orphan)
  const record = await orphan.owner.store.read()
  process.kill(-record.groupPid, 'SIGKILL')
  await poll(async () => !await live(record.groupPid) && !await live(orphan.facts[0].pid), 'original Runtime group survived fixture SIGKILL')
  assert.equal(await live(orphan.facts[1].pid), true)
  await assert.rejects(orphan.owner.isAlive())
  assert.equal(orphan.owner.hasExited(), false)
  await stopped(orphan)
  transcript.push('Owner SIGKILL: surviving native scopes retain occupancy and recover through the same generation slice.')

  const leftRoot = await mkdtemp(join(tmpdir(), 'hgw-native-left-')), rightRoot = await mkdtemp(join(tmpdir(), 'hgw-native-right-'))
  const left = await start(leftRoot), right = await start(rightRoot)
  await killGateway(left); await killGateway(right)
  await stopped(left)
  assert.equal(await right.owner.isAlive(), true)
  for (const facts of right.facts) assert.equal(await live(facts.pid), true)
  await stopped(right)
  transcript.push('Equal public owner and generation: one private slice stops without affecting another allocation.')
  const actual = transcript.join('\n') + '\n'
  assert.equal(actual, await readFile(new URL('./expected/local-runtime-native-supervision.expected.md', import.meta.url), 'utf8'))
  process.stdout.write(actual)
} finally {
  const failures = []
  for (const entry of entries.reverse()) {
    await killGateway(entry)
    if (entry.facts === undefined) {
      entry.facts = []
      for (const name of ['ready', ...names]) {
        try { entry.facts.push(await json(`${entry.directory}/${name}.json`)) } catch (error) { if (error.code !== 'ENOENT') failures.push(error) }
      }
    }
    const units = new Set(entry.facts.map(facts => facts.cgroup.split('/').at(-1)))
    for (const unit of units) {
      const members = entry.facts.filter(facts => facts.cgroup.endsWith(`/${unit}`))
      if (!(await Promise.all(members.map(facts => live(facts.pid)))).some(Boolean)) continue
      if (!/^dsh-(?:subprocess|terminal)-\d+-[a-f0-9]+\.scope$/u.test(unit) && !/^dshruntime[a-f0-9]{32}\.scope$/u.test(unit)) {
        failures.push(new Error('Fixture cleanup refuses an unrecognized owned scope')); continue
      }
      try {
        await execute('systemctl', ['--user', 'kill', '--kill-who=all', '--signal=SIGKILL', unit], { timeout: 5000, killSignal: 'SIGKILL' })
      } catch (error) {
        if ((await Promise.all(members.map(facts => live(facts.pid)))).some(Boolean)) failures.push(error)
      }
    }
    try {
      await entry.owner.terminate(0)
      await poll(async () => (await Promise.all(entry.facts.map(facts => live(facts.pid)))).every(value => !value), 'Owned fixture descendant survived cleanup')
      await rm(entry.directory, { recursive: true, force: true })
    } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Native supervision fixture cleanup failed')
}
