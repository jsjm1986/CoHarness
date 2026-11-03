/** Loader, real browser Workers and owned profiles retain admission ownership across startup waits. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import workerThreads from 'node:worker_threads'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installExternalBrowserHooks } from '../../../../../snapshots/session/browser-use-stagehand-native/native-fixture.mjs'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const root = new URL('../../../../../', import.meta.url)
const browserPath = 'experimental/browser-use-stagehand-native'
const entry = path => path === browserPath && artifactRoot !== undefined
  ? pathToFileURL(resolve(artifactRoot, 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root).href
const hooks = new URL('../../../../../snapshots/session/browser-use-stagehand-native/native-fixture.mjs', import.meta.url)
const NativeWorker = workerThreads.Worker, mkdtemp = fs.mkdtemp
let active, ctx, releaseGate, removeHooks
const workers = []
class BrowserFixtureWorker extends NativeWorker {
  constructor(filename, options) {
    if (active?.phase === 'allocation-uncertain' && active.failAllocation) throw new Error('Browser Worker allocation unavailable')
    const gated = (active?.phase === 'ready' || active?.phase === 'reconnect-ready') && !active.entered
    const channel = gated ? new workerThreads.MessageChannel() : undefined
    const bootstrap = `import { installExternalBrowserHooks } from ${JSON.stringify(hooks.href)};
installExternalBrowserHooks();
${gated ? `const { workerData } = await import('node:worker_threads');
const gate = workerData.fixtureGate; delete workerData.fixtureGate;
await new Promise(resolve => { gate.once('message', resolve); gate.postMessage('entered'); }); gate.close();` : ''}
await import(${JSON.stringify(String(filename))});`
    super(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), channel === undefined ? options : {
      ...options, workerData: { ...options.workerData, fixtureGate: channel.port2 },
      transferList: [...options.transferList ?? [], channel.port2],
    })
    workers.push(this)
    if (channel !== undefined) {
      active.worker = this
      channel.port1.once('message', () => {
        active.entered = true
        releaseGate = () => { channel.port1.postMessage('continue'); channel.port1.close() }
        active.gate.resolve()
      })
    }
  }
  terminate() {
    if (active?.worker === this && active.failTermination) return Promise.reject(new Error('Reconnect Worker termination unavailable'))
    return super.terminate()
  }
}
const createProfile = async (...args) => {
  const profile = await mkdtemp(...args)
  if (active?.phase === 'profile' && !active.entered && String(args[0]).includes('dsh-stagehand-chrome-')) {
    active.entered = true
    active.profile = profile
    active.gate.resolve()
    await active.proceed.promise
  }
  return profile
}

try {
  const { boot } = await import(entry('boot/app-boot'))
  const { SessionId } = await import(entry('core/session'))
  const { ToolCallId, LlmAdapter } = await import(entry('llm/llm'))
  const { default: ResourceBudget } = await import(entry('context/resource-budget'))
  const config = join(process.cwd(), 'cordis.yml')
  await fs.writeFile(config, JSON.stringify([
    ...['core/session', 'core/agent', 'llm/llm', 'core/tools', 'core/system-prompt', 'session/session-projection', 'browser-use/browser-use']
      .map(path => ({ name: entry(path) })),
    { name: entry('attachment/attachment-local'), config: { dshHome: process.cwd() } },
    { name: entry('core/agent-loop'), config: { agents: [] } },
  ]))
  ctx = await boot('browser-startup-owner', config)
  removeHooks = installExternalBrowserHooks()
  workerThreads.Worker = BrowserFixtureWorker
  fs.mkdtemp = createProfile
  syncBuiltinESMExports()
  let modelGate
  class BrowserModel extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      if (modelGate !== undefined) {
        const gate = modelGate; modelGate = undefined
        gate.entered.resolve(); await gate.proceed.promise
      }
      options.signal?.throwIfAborted()
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"extraction":"Fixture heading"}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['fixture'], new BrowserModel()))
  const provider = await import(entry(browserPath))
  const execute = (agent, name = 'tabs', args = { action: 'list' }, signal = new AbortController().signal) =>
    ctx.tools.execute({ agent, name: `stagehand_${name}`, arguments: args, callId: ToolCallId(`browser-${name}`), signal })
  const cancelConnection = async (agent, update = async () => {}) => {
    const gate = { entered: Promise.withResolvers(), proceed: Promise.withResolvers() }
    const controller = new AbortController()
    modelGate = gate
    releaseGate = () => gate.proceed.resolve()
    const pending = execute(agent, 'extract', { instruction: 'Extract the heading' }, controller.signal)
    try {
      await Promise.race([gate.entered.promise, pending.then(result => {
        throw new Error(`Browser returned before reconnect cancellation: ${JSON.stringify(result)}`)
      })])
      await update()
      controller.abort(new Error('Cancel current browser operation'))
      releaseGate()
      assert.equal((await pending).isError, true)
    } finally { releaseGate(); await pending.catch(() => {}) }
  }
  const cases = [
    ...['withdrawn', 'replaced', 'required'].map(change => ({ phase: 'admission', change, browser: 'attach' })),
    ...['withdrawn', 'replaced', 'installed', 'required'].map(change => ({ phase: 'ready', change, browser: 'attach' })),
    ...['replaced', 'installed', 'required'].map(change => ({ phase: 'profile', change, browser: 'launch' })),
  ]
  for (const { phase, change, browser } of cases) {
    active = { phase, gate: Promise.withResolvers(), proceed: Promise.withResolvers(), entered: false }
    releaseGate = () => active.proceed.resolve()
    let originalProcesses = 0, completed = 0, replacementProcesses = 0, pending, owner, replacement, required, browserPlugin
    const start = workers.length
    class Budget extends ResourceBudget {
      async acquire(request) {
        assert.equal(request.kind, 'process')
        assert.equal(request.sessionId, `browser-${phase}-${change}`)
        originalProcesses++
        if (phase === 'admission' && !active.entered) {
          active.entered = true; active.gate.resolve(); await active.proceed.promise
        }
        let released = false
        return { signal: new AbortController().signal,
          async release() { if (!released) { released = true; completed++ } },
          async uncertain() { throw new Error('Unexpected browser allocation uncertainty') },
        }
      }
    }
    class Replacement extends ResourceBudget {
      async acquire(request) {
        assert.equal(request.sessionId, `browser-${phase}-${change}`)
        replacementProcesses++
        return { signal: new AbortController().signal, async release() {}, async uncertain() { throw new Error('Unexpected replacement uncertainty') } }
      }
    }
    try {
      if (change !== 'installed') owner = await ctx.plugin(Budget)
      browserPlugin = await ctx.plugin(provider, {
        mode: browser, model: { provider: 'fixture', model: 'browser' },
        ...browser === 'attach' ? { cdpEndpoint: 'http://fixture:9222' } : {},
      })
      const agent = await ctx.agentLoop.create(SessionId(`browser-${phase}-${change}`), { provider: 'fixture', model: 'main' })
      pending = execute(agent)
      await Promise.race([active.gate.promise, pending.then(result => {
        throw new Error(`Browser returned before ${phase} ownership wait: ${JSON.stringify(result)}`)
      })])
      if (change === 'required') required = ctx.provide('resourceBudgetRequired', true)
      await owner?.dispose(); owner = undefined
      if (change === 'replaced' || change === 'installed') replacement = await ctx.plugin(Replacement)
      releaseGate()
      const result = await pending
      const staleWorkers = workers.slice(start)
      assert.equal(result.isError, true)
      assert.ok(JSON.stringify(result.content).includes(change === 'required' ? 'requires its resource admission provider' : 'resource provider changed'))
      assert.equal(staleWorkers.length, phase === 'ready' ? 1 : 0)
      assert.ok(staleWorkers.every(worker => worker.threadId === -1))
      assert.equal(completed, originalProcesses)
      assert.equal(replacementProcesses, 0)
      if (active.profile !== undefined) await assert.rejects(fs.access(active.profile))
      required?.(); required = undefined
      active.phase = 'unchanged'
      replacement ??= await ctx.plugin(Replacement)
      const retry = await execute(agent)
      assert.equal(retry.isError, false)
      assert.ok(replacementProcesses > 0)
      await browserPlugin.dispose(); browserPlugin = undefined
      assert.ok(workers.slice(start).every(worker => worker.threadId === -1))
      console.log(JSON.stringify({ browser, phase, change, rejected: result.isError, staleWorkers: staleWorkers.length,
        originalProcesses, originalCompleted: completed, retry: !retry.isError, workersStopped: true }))
    } finally {
      releaseGate()
      await pending?.catch(() => {})
      await browserPlugin?.dispose()
      required?.()
      await replacement?.dispose()
      await owner?.dispose()
    }
  }
  for (const managed of [false, true]) {
    active = { phase: 'unchanged' }
    let original = 0, replacement = 0, completed = 0, owner, next, browserPlugin, pending
    const lease = () => ({ signal: new AbortController().signal, async release() { completed++ }, async uncertain() { throw new Error('Unexpected reconnect uncertainty') } })
    class Budget extends ResourceBudget { async acquire() { original++; return lease() } }
    class Replacement extends ResourceBudget { async acquire() { replacement++; return lease() } }
    const start = workers.length
    try {
      if (managed) owner = await ctx.plugin(Budget)
      browserPlugin = await ctx.plugin(provider, { mode: 'attach', cdpEndpoint: 'http://fixture:9222', model: { provider: 'fixture', model: 'browser' } })
      const agent = await ctx.agentLoop.create(SessionId(`browser-reconnect-${managed}`), { provider: 'fixture', model: 'main' })
      assert.equal((await execute(agent)).isError, false)
      await cancelConnection(agent, async () => {
        await owner?.dispose(); owner = undefined
        next = await ctx.plugin(Replacement)
      })
      const before = replacement
      assert.equal((await execute(agent)).isError, false)
      assert.equal(replacement - before, 1)
      await browserPlugin.dispose(); browserPlugin = undefined
      assert.ok(workers.slice(start).every(worker => worker.threadId === -1))
      assert.equal(completed, original + replacement)
      console.log(JSON.stringify({ browser: 'attach', phase: 'reconnect', previous: managed ? 'managed' : 'independent',
        currentProviderUsed: true, workersStopped: true, allPermitsCompleted: true }))
    } finally {
      releaseGate(); await pending?.catch(() => {})
      await browserPlugin?.dispose(); await next?.dispose(); await owner?.dispose()
    }
  }
  {
    active = { phase: 'allocation-uncertain', failAllocation: true }
    const reporting = Promise.withResolvers(), reportEntered = Promise.withResolvers()
    releaseGate = () => reporting.resolve()
    let acquired = 0, attempts = 0, uncertain = 0, released = 0, failReport = true, owner, browserPlugin, closing
    const start = workers.length
    class Budget extends ResourceBudget {
      async acquire(request) {
        assert.equal(request.kind, 'process')
        assert.ok(['browser-allocation-original', 'browser-allocation-next'].includes(request.sessionId))
        acquired++
        let completed = false
        return { signal: new AbortController().signal,
          async release() { if (!completed) { completed = true; released++ } },
          async uncertain() {
            attempts++
            if (failReport) throw new Error('Browser resource accounting unavailable')
            reportEntered.resolve(); await reporting.promise
            if (!completed) { completed = true; uncertain++ }
          },
        }
      }
    }
    try {
      owner = await ctx.plugin(Budget)
      browserPlugin = await ctx.plugin(provider, { mode: 'attach', cdpEndpoint: 'http://fixture:9222', model: { provider: 'fixture', model: 'browser' } })
      const original = await ctx.agentLoop.create(SessionId('browser-allocation-original'), { provider: 'fixture', model: 'main' })
      const next = await ctx.agentLoop.create(SessionId('browser-allocation-next'), { provider: 'fixture', model: 'main' })
      assert.equal((await execute(original)).isError, true)
      assert.equal(workers.length, start)
      assert.equal((await execute(next)).isError, true)
      assert.equal(acquired, 1, 'Failed accounting must retain the original browser reservation')
      active.failAllocation = false; failReport = false
      let closed = false
      closing = original.ctx.fiber.dispose().then(() => { closed = true })
      await reportEntered.promise
      assert.equal(closed, false)
      assert.equal((await execute(next)).isError, true)
      assert.equal(acquired, 1)
      reporting.resolve(); await closing
      assert.equal(uncertain, 1)
      assert.equal(attempts, 2)
      assert.equal((await execute(next)).isError, false)
      assert.equal(acquired, 2)
      await browserPlugin.dispose(); browserPlugin = undefined
      assert.equal(released, 1)
      assert.ok(workers.slice(start).every(worker => worker.threadId === -1))
      console.log(JSON.stringify({ browser: 'attach', phase: 'allocation-accounting', failedAcquisitionReported: true,
        foreignReservationBlocked: true, disposalWaitsForReport: true, originalUncertaintyReported: true,
        freshSessionAdmittedAfterReport: true, workersStopped: true }))
    } finally {
      active.failAllocation = false; failReport = false; reporting.resolve()
      await closing?.catch(() => {})
      await browserPlugin?.dispose(); await owner?.dispose()
    }
  }
  for (const failure of ['completion', 'termination', 'dispose']) {
    active = { phase: 'unchanged', entered: false, gate: Promise.withResolvers(), proceed: Promise.withResolvers(), failTermination: false }
    let processes = 0, acquired = 0, completed = 0, uncertain = 0, releaseAttempts = 0
    let failCompletion = failure !== 'termination', arm = false, held, pending, owner, browserPlugin
    const start = workers.length
    class Budget extends ResourceBudget {
      async acquire(request) {
        assert.equal(request.sessionId, `browser-reconnect-cleanup-${failure}`)
        acquired++
        const process = request.kind === 'process'
        if (process) processes++
        const reconnect = process && arm
        if (reconnect && failure !== 'termination') {
          active.signal = request.signal
          active.gate.resolve(); await active.proceed.promise
        }
        let released = false
        const lease = { signal: new AbortController().signal,
          async release() {
            if (reconnect) { releaseAttempts++; if (failCompletion) throw new Error('Reconnect accounting completion unavailable') }
            if (!released) { released = true; completed++ }
          },
          async uncertain() { uncertain++ },
        }
        if (reconnect) held = lease
        return lease
      }
    }
    releaseGate = () => active.proceed.resolve()
    try {
      owner = await ctx.plugin(Budget)
      browserPlugin = await ctx.plugin(provider, { mode: 'attach', cdpEndpoint: 'http://fixture:9222', model: { provider: 'fixture', model: 'browser' } })
      const agent = await ctx.agentLoop.create(SessionId(`browser-reconnect-cleanup-${failure}`), { provider: 'fixture', model: 'main' })
      assert.equal((await execute(agent)).isError, false)
      await cancelConnection(agent)
      releaseGate = () => active.proceed.resolve()
      arm = true
      const controller = new AbortController()
      if (failure === 'termination') active.phase = 'reconnect-ready'
      pending = execute(agent, 'tabs', { action: 'list' }, controller.signal)
      await Promise.race([active.gate.promise, pending.then(result => { throw new Error(`Reconnect returned before cleanup wait: ${JSON.stringify(result)}`) })])
      if (failure === 'termination') active.failTermination = true
      let disposing
      if (failure === 'dispose') {
        const aborted = new Promise(resolve => { active.signal.addEventListener('abort', resolve, { once: true }) })
        disposing = browserPlugin.dispose()
        await aborted
      } else controller.abort(new Error('Cancel reconnect acquisition'))
      releaseGate()
      assert.equal((await pending).isError, true)
      if (disposing !== undefined) {
        await disposing
        assert.equal(ctx.browserUse.providerName, 'stagehand-native')
        assert.ok(releaseAttempts >= 2)
        console.log(JSON.stringify({ browser: 'attach', phase: 'reconnect-cleanup', failure,
          reservationRetained: true, noNewWorker: workers.length === start + 1, completionStillOwned: completed < acquired }))
      } else {
        const before = workers.length
        const blocked = await execute(agent)
        assert.equal(blocked.isError, true)
        assert.equal(processes, 2)
        assert.equal(workers.length, before)
        if (failure === 'termination') {
          assert.notEqual(active.worker.threadId, -1)
          assert.ok(uncertain > 0)
        } else assert.ok(releaseAttempts >= 2)
        failCompletion = false; active.failTermination = false; arm = false
        releaseGate()
        assert.equal((await execute(agent)).isError, false)
        assert.equal(processes, 3)
        await browserPlugin.dispose(); browserPlugin = undefined
        assert.ok(workers.slice(start).every(worker => worker.threadId === -1))
        assert.equal(completed, acquired)
        console.log(JSON.stringify({ browser: 'attach', phase: 'reconnect-cleanup', failure,
          retryBlockedUntilCleanup: true, recovered: true, workersStopped: true, allPermitsCompleted: true }))
      }
    } finally {
      failCompletion = false; active.failTermination = false
      releaseGate(); await pending?.catch(() => {})
      await browserPlugin?.dispose()
      // A deliberately failed plugin disposal retains its reservation until host restart.
      await held?.release()
      await owner?.dispose()
    }
  }

} finally {
  releaseGate?.()
  await ctx?.fiber.dispose()
  await Promise.all(workers.map(worker => worker.terminate()))
  workerThreads.Worker = NativeWorker; fs.mkdtemp = mkdtemp
  syncBuiltinESMExports(); removeHooks?.()
}
