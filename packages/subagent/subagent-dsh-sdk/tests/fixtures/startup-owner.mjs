/** Loader parent retains admission through queue/control waits before real SDK startup. */
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { Server } from 'node:net'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const root = new URL('../../../../../', import.meta.url)
const entry = path => path === 'subagent/subagent-dsh-sdk' && artifactRoot !== undefined
  ? pathToFileURL(resolve(artifactRoot, 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root).href
const { boot } = await import(entry('boot/app-boot'))
const { SessionId } = await import(entry('core/session'))
const { LlmAdapter } = await import(entry('llm/llm'))
const record = join(process.cwd(), 'physical-starts.jsonl')
const dispatchRecord = join(process.cwd(), 'model-dispatches.jsonl')
const childProcess = createRequire(import.meta.url)('node:child_process')
const spawn = childProcess.spawn, listen = Server.prototype.listen, children = []
let ctx, pendingControl, run
childProcess.spawn = function (...args) {
  const child = Reflect.apply(spawn, this, args)
  if (args[2]?.env?.DSH_STARTUP_OWNER_RECORD === record) {
    const exited = new Promise(ready => { child.once('close', ready) })
    children.push({ child, exited })
  }
  return child
}
syncBuiltinESMExports()
Server.prototype.listen = function (...args) {
  const callback = args.at(-1), gate = pendingControl
  if (gate !== undefined && typeof callback === 'function') {
    pendingControl = undefined
    args[args.length - 1] = function (...values) {
      gate.entered.resolve()
      void gate.proceed.promise.then(() => Reflect.apply(callback, this, values))
    }
  }
  return Reflect.apply(listen, this, args)
}
const markerCount = () => {
  let text
  try { text = readFileSync(record, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
  return text.trimEnd().split('\n').filter(Boolean).length
}
function unavailable(error) {
  const pending = [error], seen = new Set()
  while (pending.length > 0) {
    const item = pending.pop()
    if (item === null || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    if (item.reason === 'unavailable') return true
    pending.push(item.cause, ...item instanceof AggregateError ? item.errors : [])
  }
  return false
}
try {
  const childPatch = join(process.cwd(), 'child.patch.yml')
  await writeFile(childPatch, JSON.stringify([
    { id: 'llm-deepseek', disabled: true }, { id: 'agent-instructions', disabled: true },
    { id: 'skill-filesystem', config: { includeDefaultRoots: false } },
    { insert: [{ id: 'startup-owner-child', name: new URL('./startup-owner-child.mjs', import.meta.url).href,
      config: { record, dispatchRecord, llmEntry: entry('llm/llm') } }] },
  ]))
  const plugins = [
    ['core/session'], ['core/agent'], ['llm/llm'], ['core/tools'], ['core/system-prompt'],
    ['session/session-persistence-jsonl', { root: join(process.cwd(), 'sessions'), compression: 'none' }],
    ['session/session-projection'], ['fs/fs-local'], ['session/working-directory'], ['core/agent-loop', { agents: [] }], ['subagent/subagent'],
    ['subagent/subagent-dsh-sdk', { providerName: 'startup-owner-child', profile: 'sdk', patches: [childPatch],
      dshHome: join(process.cwd(), 'child-home'), provider: 'startup-owner', model: 'fixture',
      initializeTimeoutMs: 30_000, controlRequestTimeoutMs: 2000, controlCleanupTimeoutMs: 20_000,
      env: { DSH_TELEMETRY_DISABLED: '1', DSH_STARTUP_OWNER_RECORD: record,
        TSX_TSCONFIG_PATH: fileURLToPath(new URL('tsconfig.json', root)) } }],
  ].map(([path, config]) => ({ name: entry(path), ...config === undefined ? {} : { config } }))
  const config = join(process.cwd(), 'cordis.yml'); await writeFile(config, JSON.stringify(plugins))
  ctx = await boot('sdk-startup-owner', config)
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'SDK_OWNER_DONE' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'SDK_OWNER_DONE' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['startup-owner'], new Adapter()))
  const parent = await ctx.agentLoop.create(SessionId('startup-owner-parent'), { provider: 'startup-owner', model: 'fixture' }, { cwd: process.cwd() })
  const cases = ['queued', 'control'].flatMap(phase => ['replaced', 'downgraded'].map(change => ({ phase, change })))
  cases.push({ phase: 'unchanged', change: 'managed' }, { phase: 'unchanged', change: 'independent' })
  for (const { phase, change } of cases) {
    let originalAcquires = 0, originalReleases = 0, uncertainties = 0, replacementAcquires = 0, starts = 0, ends = 0
    const entered = Promise.withResolvers(), proceed = Promise.withResolvers(), grant = Promise.withResolvers()
    const markerBefore = markerCount(), before = children.length
    const leaseFor = (kind) => {
      let settled = false
      return { signal: new AbortController().signal,
        release: async () => { if (!settled) { settled = true; if (kind === 'process') originalReleases++ } },
        uncertain: async () => { if (kind === 'process') uncertainties++ } }
    }
    const budget = { async acquire(request) {
      assert.equal(String(request.sessionId), String(parent.id)); assert.equal(request.origin, 'execution')
      const lease = leaseFor(request.kind)
      if (request.kind !== 'process') return lease
      originalAcquires++
      if (phase !== 'queued') return lease
      entered.resolve(); return grant.promise.then(() => lease)
    } }
    const requirement = change === 'independent' ? undefined : ctx.effect(() => ctx.provide('resourceBudgetRequired', true))
    const registration = change === 'independent' ? undefined : ctx.effect(() => ctx.provide('resourceBudget', budget))
    const observers = [ctx.on('subagent/start', () => { starts++ }), ctx.on('subagent/end', () => { ends++ })]
    let replacement, rejected = false, resourceUnavailable = false, outcome = null
    if (phase === 'control') pendingControl = { entered, proceed }
    const starting = ctx.subagents.start('startup-owner-child', { parent, prompt: 'Verify SDK startup ownership.', signal: new AbortController().signal })
    const result = starting.then(value => ({ value }), error => ({ error }))
    try {
      if (phase !== 'unchanged') {
        await Promise.race([entered.promise, result.then(() => { throw new Error('SDK startup did not reach its controlled wait.') })])
        await registration()
        if (change === 'replaced') replacement = ctx.effect(() => ctx.provide('resourceBudget', { async acquire(request) {
          if (request.kind === 'process') replacementAcquires++
          return leaseFor(request.kind)
        } }))
        else await requirement()
        grant.resolve(); proceed.resolve()
      }
      const settled = await result
      if (settled.error !== undefined) {
        rejected = true; resourceUnavailable = unavailable(settled.error)
        process.stderr.write(`startup-owner ${phase}/${change} rejected: ${settled.error?.stack ?? settled.error}\n`)
      }
      else {
        run = settled.value
        outcome = (await run.result).stopReason
        await run.dispose(); run = undefined
        await ctx.subagents.waitForChildren(parent); await parent.whenIdle()
      }
      const spawned = children.slice(before)
      await Promise.all(spawned.map(item => item.exited))
      console.log(JSON.stringify({ phase, change, rejected, resourceUnavailable, spawns: spawned.length,
        marker: markerCount() > markerBefore, closed: spawned.every(item => item.child.exitCode !== null || item.child.signalCode !== null),
        originalAcquires, originalReleases, uncertainties, replacementAcquires, starts, ends, outcome }))
      if (phase === 'unchanged') assert.equal(outcome, 'completed')
    } finally {
      pendingControl = undefined; grant.resolve(); proceed.resolve()
      await run?.dispose(); run = undefined
      await result; for (const off of observers) off()
      await replacement?.(); await registration?.(); await requirement?.()
    }
  }
  for (const allowed of [true, false]) {
    const local = new AsyncLocalStorage(), scope = { parentSessionId: parent.id, inputs: [], primaryActorUserId: 7, unverifiedHistory: false }
    const authority = ctx.effect(() => ctx.provide('executionAuthority', {
      capture: () => scope, current: () => local.getStore(),
      runCaptured: (_agent, inherited, work) => local.run(inherited, work),
    }))
    let checks = 0
    const guard = ctx.on('llm/pre-dispatch', async (options, next) => {
      assert.equal(options.sessionId, parent.id)
      assert.equal(local.getStore(), scope)
      checks++
      if (!allowed) throw new Error('SDK_AUTHORITY_DENIED')
      await next()
    })
    const count = () => {
      try { return readFileSync(dispatchRecord, 'utf8').trimEnd().split('\n').filter(Boolean).length } catch (error) {
        if (error.code === 'ENOENT') return 0
        throw error
      }
    }
    const before = children.length, beforeDispatch = count()
    try {
      assert.equal(ctx.get('resourceBudget'), undefined)
      assert.equal(ctx.get('modelAccess'), undefined)
      assert.notEqual(ctx.get('resourceBudgetRequired'), true)
      assert.notEqual(ctx.get('modelAccessRequired'), true)
      run = await ctx.subagents.start('startup-owner-child', { parent, prompt: 'Verify authority-only model dispatch.', signal: new AbortController().signal })
      const result = await run.result
      await run.dispose(); run = undefined
      await ctx.subagents.waitForChildren(parent); await parent.whenIdle()
      const spawned = children.slice(before)
      await Promise.all(spawned.map(item => item.exited))
      assert.equal(checks, 1)
      assert.equal(count() - beforeDispatch, allowed ? 1 : 0)
      assert.equal(result.stopReason, allowed ? 'completed' : 'error')
      assert.equal(spawned.length, 1)
      assert.ok(spawned.every(item => item.child.exitCode !== null || item.child.signalCode !== null))
      console.log(JSON.stringify({ phase: 'authority-only', allowed, parentChecks: checks, childDispatches: count() - beforeDispatch,
        outcome: result.stopReason, spawns: spawned.length, closed: true }))
    } finally {
      await run?.dispose(); run = undefined
      guard(); await authority()
    }
  }
} finally {
  pendingControl?.proceed.resolve()
  childProcess.spawn = spawn; syncBuiltinESMExports(); Server.prototype.listen = listen
  try { await run?.dispose() } finally { await ctx?.fiber.dispose() }
}
