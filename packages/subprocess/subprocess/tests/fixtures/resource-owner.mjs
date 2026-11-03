/** Loader application proving admission ownership and unused local capacity recovery. */
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, artifactRoot] = process.argv.slice(2)
if (mode !== 'src' && mode !== 'lib') throw new Error('Process resource owner replay requires src or lib.')
const root = new URL('../../../../../', import.meta.url)
const entry = path => path === 'subprocess/subprocess-local' && artifactRoot !== undefined
  ? pathToFileURL(resolve(artifactRoot, 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root).href
const { boot } = await import(entry('boot/app-boot'))
const { ResourceAdmissionError } = await import(entry('context/resource-budget'))
let ctx
try {
  const config = join(process.cwd(), 'cordis.yml')
  await writeFile(config, JSON.stringify([{ name: entry('subprocess/subprocess-local') }]))
  ctx = await boot('process-resource-owner', config)
  ctx.effect(() => ctx.provide('resourceBudgetRequired', true))
  const cases = ['process', 'terminal'].flatMap(kind => ['withdrawn', 'replaced']
    .flatMap(change => ['queued', 'grant-handoff'].map(phase => ({ kind, change, phase }))))
  cases.push(...['process', 'terminal'].map(kind => ({ kind, change: 'unchanged', phase: 'queued' })))
  for (const { kind, change, phase } of cases) {
    const marker = join(process.cwd(), `${kind}-${change}-${phase}.txt`)
    const entered = Promise.withResolvers(), grant = Promise.withResolvers(), released = Promise.withResolvers()
    let admissions = 0, releases = 0, uncertainties = 0, replacementAdmissions = 0, withdraw
    const lease = { signal: new AbortController().signal,
      release: async () => { releases++; released.resolve() }, uncertain: async () => { uncertainties++ } }
    const registration = ctx.effect(() => {
      withdraw = ctx.provide('resourceBudget', { async acquire() { admissions++; entered.resolve(); return grant.promise } })
      return withdraw
    })
    let replacement
    const changeOwner = () => {
      withdraw()
      if (change === 'replaced') replacement = ctx.effect(() => ctx.provide('resourceBudget', {
        async acquire() { replacementAdmissions++; return lease },
      }))
    }
    const argv = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'created')`]
    const spec = { argv, cwd: process.cwd(), graceMs: 100 }
    const allocation = kind === 'process'
      ? ctx.subprocess.spawn({ ...spec, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
      : ctx.subprocess.spawnTerminal({ ...spec, rows: 24, cols: 80, terminalType: 'xterm' })
    const result = allocation.then(async (handle) => {
      await handle.done; await released.promise; return null
    }, error => error.reason ?? error.name)
    try {
      await Promise.race([entered.promise, result.then(() => { throw new Error('The process must reach its admission wait.') })])
      if (change !== 'unchanged' && phase === 'queued') changeOwner()
      grant.resolve(lease)
      if (change !== 'unchanged' && phase === 'grant-handoff') queueMicrotask(changeOwner)
      const reason = await result
      console.log(JSON.stringify({ kind, change, phase, reason, created: existsSync(marker), admissions,
        releases, uncertainties, replacementAdmissions }))
    } finally {
      grant.resolve(lease); await result; await replacement?.(); await registration()
    }
  }
  const preflightCases = ['process', 'terminal'].map(kind => ({ kind, field: 'empty-argv' }))
  preflightCases.push(...['process', 'terminal'].flatMap(kind => ['program', 'argument', 'directory', 'environment-key', 'environment-value']
    .map(field => ({ kind, field }))))
  for (const { kind, field } of preflightCases) {
    const marker = join(process.cwd(), `${kind}-${field}-after-preflight.txt`)
    const leases = []
    let admissions = 0, nextRefusal = null
    const withdraw = ctx.effect(() => ctx.provide('resourceBudget', { async acquire() {
      admissions++
      if (leases.some(lease => !lease.released)) throw new ResourceAdmissionError('refused', 'The single process slot is occupied.')
      const entry = { released: false, uncertain: false }
      leases.push(entry)
      return { signal: new AbortController().signal, release: async () => { entry.released = true },
        uncertain: async () => { entry.uncertain = true } }
    } }))
    try {
      const base = { argv: [process.execPath, '-e', ''], cwd: process.cwd(), graceMs: 100 }
      const spec = field === 'empty-argv' ? { ...base, argv: [] }
        : field === 'program' ? { ...base, argv: ['bad\0program'] }
        : field === 'argument' ? { ...base, argv: [process.execPath, 'bad\0argument'] }
        : field === 'directory' ? { ...base, cwd: base.cwd + '\0' }
        : { ...base, env: field === 'environment-key' ? { ['bad\0key']: 'value' } : { DSH_TEST_INVALID_VALUE: 'bad\0value' } }
      const invalid = kind === 'process'
        ? ctx.subprocess.spawn({ ...spec, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
        : ctx.subprocess.spawnTerminal({ ...spec, rows: 24, cols: 80, terminalType: 'dumb' })
      const failure = await invalid.then(() => { throw new Error('Invalid OS strings must never start a target.') }, error => error)
      const afterFailure = { ...leases[0] }
      try {
        const handle = await ctx.subprocess.spawn({ ...base,
          argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'created')`],
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
        handle.stdout?.resume(); handle.stderr?.resume()
        await handle.done; await handle.waitForExit()
      } catch (error) { nextRefusal = error.reason ?? error.name }
      console.log(JSON.stringify({ kind, phase: 'preflight-failure',
        ...field === 'empty-argv' ? {} : { field },
        originalError: field === 'empty-argv' ? failure.message === (kind === 'process'
          ? 'invalid argv: expected a non-empty program name at argv[0]' : 'subprocess-local: terminal argv must contain a program')
          : failure.code === 'ERR_INVALID_ARG_VALUE' && failure.message.includes('must be a string without null bytes'),
        afterFailure, nextCreated: existsSync(marker), nextRefusal, admissions, grants: leases.length,
        allReturned: leases.every(lease => lease.released && !lease.uncertain) }))
    } finally { await withdraw() }
  }
} finally { await ctx?.fiber.dispose() }
