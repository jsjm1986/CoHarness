/** Complete InstanceManager start/stop, real supervisor and signed Runtime HTTP without a model provider. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

const [mode, artifactRoot = '-', selected = 'all'] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const base = artifactRoot === '-' ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const [{ InstanceManager }, { LocalLauncher }, { openDb }, { UserService }, { loadConfig }, { PostgresCheckoutQueueFullError }] = await Promise.all([
  'instances', 'launcher', 'db', 'users', 'config', 'postgres/database',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const transcript = []
const cases = ['healthy', 'wrong-identity', 'frozen-clock', 'probe-budget', 'late-registration', 'cancel-registration', 'late-ready-publication', 'registration-error', 'publication-error']
assert.ok(selected === 'all' || cases.includes(selected))
const nativeNow = performance.now.bind(performance)
async function bounded(pending, timeoutMs) {
  let timer
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Readiness operation did not settle under its owner')), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}
async function waitFor(check) {
  const deadline = nativeNow() + 20_000
  for (;;) { if (await check()) return; if (nativeNow() >= deadline) throw new Error('Runtime fixture observer timed out'); await delay(10) }
}
async function waitForJson(path) {
  let value
  await waitFor(async () => { try { value = JSON.parse(await readFile(path, 'utf8')); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } })
  return value
}
async function scenario(name) {
  const root = await mkdtemp(join(tmpdir(), 'hgw-readiness-lifecycle-')), marker = join(root, 'runtime.json'), probeMarker = join(root, 'probe.json')
  const sockets = new Set(), originalDate = Date.now, perfDescriptor = Object.getOwnPropertyDescriptor(performance, 'now'), originalTimeout = AbortSignal.timeout
  let manager, db, relay, processOwner, pending, stop, startupSignal, primaryError, relayFailure, frozen = false, offset = 0, recordBudgets = false
  const budgets = [], entered = Promise.withResolvers(), registration = Promise.withResolvers(), publication = Promise.withResolvers()
  const failure = new PostgresCheckoutQueueFullError(1)
  function clock() {
    Date.now = () => frozen ? 1_700_000_000_000 : originalDate() + offset
    Object.defineProperty(performance, 'now', { configurable: true, value: () => nativeNow() + offset })
  }
  function restoreClock() {
    Date.now = originalDate
    if (perfDescriptor === undefined) delete performance.now; else Object.defineProperty(performance, 'now', perfDescriptor)
  }
  try {
    const timeoutMs = name.includes('error') || name.startsWith('cancel') || name === 'healthy' ? 5000 : 500
    const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
      HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
      HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'),
      HGW_DEFAULT_ENV_FILE: '', HGW_GUARD_PATCH: 'off', HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)),
      HGW_READINESS_TIMEOUT_MS: String(timeoutMs) })
    db = openDb(join(root, 'gateway.sqlite'))
    const users = new UserService(db, cfg), actor = await users.create({ username: 'readiness-user', password: 'fixture-pw-12345' })
    relay = createServer(downstream => {
      const remember = socket => { sockets.add(socket); socket.on('error', () => socket.destroy()); socket.on('close', () => sockets.delete(socket)) }
      remember(downstream)
      let port
      try { port = JSON.parse(readFileSync(marker, 'utf8')).port } catch (error) { downstream.destroy(); if (error.code !== 'ENOENT') relayFailure ??= error; return }
      const upstream = connect(port, '127.0.0.1'); remember(upstream)
      downstream.on('close', () => upstream.destroy()); upstream.on('close', () => downstream.destroy())
      downstream.pipe(upstream).pipe(downstream)
    })
    await new Promise((done, fail) => { relay.once('error', fail); relay.listen(0, '127.0.0.1', done) })
    db.prepare('UPDATE instances SET port=? WHERE user_id=?').run(relay.address().port, actor.id)
    const httpMode = name === 'frozen-clock' ? 'status' : name === 'probe-budget' ? 'body-stall' : name === 'wrong-identity' ? 'wrong-identity' : 'valid'
    cfg.dshCommand = [process.execPath, ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./readiness-runtime.mjs', import.meta.url)), new URL(`runtime-readiness.${mode === 'src' ? 'ts' : 'js'}`, base).href,
      marker, httpMode, probeMarker]
    const native = new LocalLauncher({ ...cfg, readinessTimeoutMs: 30_000 })
    const launcher = { instancesOutliveGateway: false, start: async runtime => {
      startupSignal = runtime.signal
      processOwner = await native.start(runtime)
      await waitForJson(marker)
      if (name === 'frozen-clock') { frozen = true; clock() }
      if (name === 'probe-budget') recordBudgets = true
      return processOwner
    } }
    const resources = {
      admitRuntimeStart: async () => {},
      registered: async () => {
        if (name === 'registration-error') throw failure
        if (name === 'late-registration' || name === 'cancel-registration') { entered.resolve(); await registration.promise }
        return true
      },
      stopped: async () => { if (processOwner !== undefined) assert.equal(await processOwner.isAlive(), false) },
    }
    manager = new InstanceManager(db, cfg, launcher, undefined, resources)
    if (name === 'late-ready-publication' || name === 'publication-error') {
      const original = manager.repository.markReady.bind(manager.repository)
      manager.repository.markReady = async (...args) => {
        if (name === 'publication-error') throw failure
        entered.resolve(); await publication.promise
        return original(...args)
      }
    }
    AbortSignal.timeout = function (ms) { if (recordBudgets) budgets.push(ms); return Reflect.apply(originalTimeout, AbortSignal, [ms]) }
    pending = manager.ensureRunning(actor, 'explicit').then(value => ({ value }), error => ({ error }))
    if (name === 'probe-budget') {
      await waitForJson(probeMarker)
      assert.ok(budgets.length > 0 && budgets[0] <= timeoutMs, `Readiness request exceeded its remaining budget: ${String(budgets[0])}`)
    }
    if (name === 'late-registration' || name === 'cancel-registration' || name === 'late-ready-publication') {
      await bounded(entered.promise, 20_000)
      if (name === 'cancel-registration') {
        stop = manager.stop({ kind: 'user', id: actor.id })
        await waitFor(() => startupSignal.aborted)
      } else { offset = timeoutMs * 2; clock() }
      registration.resolve(); publication.resolve()
    }
    const result = await bounded(pending, name === 'frozen-clock' ? 3000 : 15_000)
    if (name === 'healthy') {
      assert.ok(result.value)
      assert.equal(await manager.stateOf({ kind: 'user', id: actor.id }), 'ready')
      assert.equal(manager.capacitySnapshot().resident, 1)
      transcript.push('A signed healthy Runtime becomes ready and retains its resident reservation.')
    } else {
      assert.ok(result.error, 'Startup must not confirm late, cancelled or rejected readiness')
      if (name.includes('error')) { assert.equal(result.error, failure); assert.equal(result.error.code, 'DB_CHECKOUT_QUEUE_FULL') }
      else if (name === 'cancel-registration') assert.equal(result.error.reason, 'cancelled')
      else assert.match(result.error.message, /failed to become ready/)
      assert.equal(await processOwner.isAlive(), false)
      assert.equal(await manager.stateOf({ kind: 'user', id: actor.id }), 'stopped')
      assert.equal(manager.capacitySnapshot().resident, 0)
      const messages = {
        'wrong-identity': 'A signed response for another generation cannot acknowledge the requested Runtime.',
        'frozen-clock': 'A frozen wall clock cannot indefinitely retain startup or its resident reservation.',
        'probe-budget': 'An in-flight readiness response uses the remaining startup budget and closes before release.',
        'late-registration': 'Resource registration completed after the readiness deadline cannot confirm startup.',
        'cancel-registration': 'Stopping during resource registration rejects startup as cancelled and joins physical termination.',
        'late-ready-publication': 'A delayed ready publication cannot return successful startup after its deadline.',
        'registration-error': 'Resource-registration database refusal keeps its structured failure after physical rollback.',
        'publication-error': 'Ready-publication database refusal keeps its structured failure after physical rollback.',
      }
      transcript.push(messages[name])
    }
    await stop
  } catch (error) { primaryError = error; throw error }
  finally {
    registration.resolve(); publication.resolve(); restoreClock(); AbortSignal.timeout = originalTimeout
    const failures = [], close = async fn => { try { await fn() } catch (error) { failures.push(error) } }
    if (manager !== undefined) await close(() => manager.stopAll())
    await Promise.allSettled([pending, stop])
    let stopped = true
    if (processOwner !== undefined) {
      await close(() => processOwner.terminate(0))
      try { stopped = !await processOwner.isAlive() } catch (error) { stopped = false; failures.push(error) }
    }
    if (relay?.listening) {
      const closed = new Promise((done, fail) => { relay.close(error => error ? fail(error) : done()) })
      for (const socket of sockets) socket.destroy()
      await close(() => closed)
    }
    if (db !== undefined) await close(async () => db.close())
    if (relayFailure !== undefined) failures.push(relayFailure)
    if (stopped) await close(() => rm(root, { recursive: true, force: true }))
    else failures.push(new Error('Unconfirmed Runtime ownership retained at ' + root))
    if (failures.length > 0) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], 'Readiness lifecycle cleanup failed')
  }
}
for (const name of selected === 'all' ? cases : [selected]) await scenario(name)
const expected = (await readFile(new URL('../expected/runtime-readiness-lifecycle.expected.md', import.meta.url), 'utf8')).trimEnd().split('\n')
const actual = transcript.join('\n') + '\n'
assert.equal(actual, (selected === 'all' ? expected : [expected[cases.indexOf(selected)]]).join('\n') + '\n')
process.stdout.write(actual)
