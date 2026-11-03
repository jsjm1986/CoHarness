/** Loader-composed historical writes retain admission before starting real verification threads. */
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const root = new URL('../../../../../', import.meta.url)
const entry = path => path === 'session/session-persistence-jsonl' && artifactRoot !== undefined
  ? pathToFileURL(resolve(artifactRoot, 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root).href
const threads = createRequire(import.meta.url)('node:worker_threads')
const OriginalWorker = threads.Worker, workers = []
threads.Worker = class extends OriginalWorker {
  constructor(...args) {
    super(...args)
    const record = { exited: false, completion: undefined }
    record.completion = new Promise(ready => this.once('exit', () => { record.exited = true; ready() }))
    workers.push(record)
  }
}
syncBuiltinESMExports()
let ctx, unblock
const exists = async path => stat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false
  throw error
})
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
  const { boot } = await import(entry('boot/app-boot'))
  const { SessionId } = await import(entry('core/session'))
  const config = join(process.cwd(), 'cordis.yml'), sessions = join(process.cwd(), 'sessions')
  await writeFile(config, JSON.stringify([{ name: entry('session/session-persistence-jsonl'), config: {
    root: sessions, compression: 'none', verificationConcurrency: 1, maxQueuedVerifications: 1,
  } }]))
  ctx = await boot('migration-owner', config)
  for (const change of ['replaced', 'withdrawn', 'unchanged', 'independent']) {
    const id = SessionId(`migration-${change}`), directory = join(sessions, '_no-cwd', id)
    const source = join(directory, 'session.v6.jsonl'), current = join(directory, 'session.v7.jsonl')
    const bytes = JSON.stringify({ type: 'session', version: 6, id, createdAt: 1, isSeeded: false, delegationDepth: 0 }) + '\n'
    await mkdir(directory, { recursive: true }); await writeFile(source, bytes)
    let admissions = 0, releases = 0, uncertainties = 0, replacementAdmissions = 0
    const entered = Promise.withResolvers(), grant = Promise.withResolvers()
    unblock = () => grant.resolve()
    const lease = () => {
      let settled = false
      return { signal: new AbortController().signal,
        release: async () => { if (!settled) { settled = true; releases++ } },
        uncertain: async () => { uncertainties++ } }
    }
    const budget = { async acquire(request) {
      assert.equal(request.kind, 'process'); assert.equal(request.origin, 'infrastructure')
      assert.equal(request.sessionId, undefined)
      admissions++; entered.resolve(); await grant.promise; return lease()
    } }
    const requirement = change === 'independent' ? undefined : ctx.effect(() => ctx.provide('resourceBudgetRequired', true))
    const registration = change === 'independent' ? undefined : ctx.effect(() => ctx.provide('resourceBudget', budget))
    let replacement, fresh
    const before = workers.length
    try {
      const pending = ctx.sessionPersistence.open(id, 'write').then(async handle => {
        await handle.close(); return { opened: true }
      }, error => ({ opened: false, unavailable: unavailable(error) }))
      if (change !== 'independent') await entered.promise
      if (change === 'replaced' || change === 'withdrawn') {
        await registration(); await requirement()
        if (change === 'replaced') replacement = ctx.effect(() => ctx.provide('resourceBudget', {
          async acquire() { replacementAdmissions++; return lease() },
        }))
      }
      grant.resolve()
      const outcome = await pending, published = await exists(current)
      await Promise.all(workers.slice(before).map(worker => worker.completion))
      console.log(JSON.stringify({ change, ...outcome, workers: workers.length - before,
        exited: workers.slice(before).every(worker => worker.exited), admissions, releases, uncertainties,
        replacementAdmissions, published, sourceUnchanged: await readFile(source, 'utf8') === bytes }))
      if (!outcome.opened) {
        assert.equal(outcome.unavailable, true)
        await replacement?.()
        fresh = ctx.effect(() => ctx.provide('resourceBudget', budget))
        const retryBefore = workers.length, handle = await ctx.sessionPersistence.open(id, 'write')
        await handle.close()
        await Promise.all(workers.slice(retryBefore).map(worker => worker.completion))
        assert.equal(workers.length - retryBefore, 1)
        assert.equal(await exists(current), true)
        assert.equal(await readFile(source, 'utf8'), bytes)
      }
    } finally { await fresh?.(); await replacement?.(); await registration?.(); await requirement?.() }
  }
} finally {
  unblock?.()
  try { await ctx?.fiber.dispose() } finally { threads.Worker = OriginalWorker; syncBuiltinESMExports() }
}
