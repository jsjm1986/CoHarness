/** Loader application with a real SSH helper and authenticated local stream forwarding. */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [mode, artifactRoot] = process.argv.slice(2)
if (mode !== 'src' && mode !== 'lib') throw new Error('SSH admission replay requires src or lib.')
const repository = new URL('../../../../../', import.meta.url)
const entry = path => path === 'ssh/subprocess-ssh' && artifactRoot !== undefined
  ? pathToFileURL(resolve(artifactRoot, 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, repository).href
const { boot } = await import(entry('boot/app-boot'))
const { SshConnection } = await import(entry('ssh/ssh'))
const { default: Remote } = await import(entry('ssh/subprocess-ssh'))
const workspace = process.cwd(), config = join(workspace, 'cordis.yml')
await writeFile(config, '[]')
const ctx = await boot('ssh-admission-owner', config)
let connection
try {
  ctx.effect(() => ctx.provide('resourceBudgetRequired', true))
  const transport = ctx.isolate('resourceBudget').isolate('ssh')
  transport.effect(() => transport.provide('resourceBudget', { async acquire(request) {
    if (request.origin !== 'infrastructure') throw new Error('Only the carrier may use infrastructure admission.')
    return { signal: new AbortController().signal, release: async () => {}, uncertain: async () => {} }
  } }))
  const helper = fileURLToPath(new URL(`packages/ssh/ssh/${mode === 'src' ? 'src/helper-entry.ts' : 'lib/helper.js'}`, repository))
  let carrier = await readFile(new URL('../../../../ssh/ssh/tests/fixtures/local-ssh-carrier.mjs', import.meta.url), 'utf8')
  if (mode === 'src') {
    const original = "['--disable-sigusr1', helper]"
    if (!carrier.includes(original)) throw new Error('The source helper launcher changed.')
    carrier = carrier.replace(original, `['--disable-sigusr1', '--import', ${JSON.stringify(import.meta.resolve('tsx/esm'))}, helper]`)
  }
  const carrierPath = join(workspace, 'carrier.mjs'), bin = join(workspace, 'bin')
  await writeFile(carrierPath, carrier)
  await mkdir(bin)
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  await writeFile(join(bin, 'ssh'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(carrierPath)} ${quote(helper)} "$@"\n`, { mode: 0o700 })
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
  connection = new SshConnection(transport, { host: 'admission-fixture', launch: { kind: 'node-script', node: process.execPath },
    helper, helperHash: createHash('sha256').update(await readFile(helper)).digest('hex'), workspace,
    requestTimeoutMs: 10_000, leaseMs: 30_000,
  })
  await connection.ready
  const request = connection.request.bind(connection), connectStream = connection.connectStream.bind(connection)
  let active
  ctx.effect(() => ctx.provide('ssh', {
    retainConsumer: connection.retainConsumer.bind(connection), dispose: connection.dispose.bind(connection), ready: connection.ready,
    request: async (method, ...args) => {
      if (method === 'process.start') active.starts++
      const result = await request(method, ...args)
      if (method === 'process.prepare' && active?.phase === 'prepare') { active.entered.resolve(); await active.proceed.promise }
      return result
    },
    connectStream: async (...args) => {
      const socket = await connectStream(...args)
      if (active?.phase === 'connect') { active.entered.resolve(); await active.proceed.promise }
      return socket
    },
  }))
  await ctx.plugin(Remote)
  const cases = ['process', 'terminal'].flatMap(kind => ['prepare', 'connect']
    .flatMap(phase => ['withdrawn', 'replaced'].map(change => ({ kind, phase, change }))))
  cases.push(...['process', 'terminal'].map(kind => ({ kind, phase: 'prepare', change: 'unchanged' })))
  for (const { kind, phase, change } of cases) {
    const entered = Promise.withResolvers(), proceed = Promise.withResolvers(), released = Promise.withResolvers()
    active = { phase, entered, proceed, starts: 0 }
    let admissions = 0, releases = 0, uncertainties = 0, replacementAdmissions = 0, withdraw
    const lease = { signal: new AbortController().signal,
      release: async () => { releases++; released.resolve() }, uncertain: async () => { uncertainties++ } }
    const registration = ctx.effect(() => {
      withdraw = ctx.provide('resourceBudget', { async acquire() { admissions++; return lease } })
      return withdraw
    })
    const marker = join(workspace, `${kind}-${phase}-${change}.txt`)
    const spec = { argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'created')`],
      cwd: workspace, graceMs: 100 }
    const allocation = kind === 'process'
      ? ctx.subprocess.spawn({ ...spec, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
      : ctx.subprocess.spawnTerminal({ ...spec, rows: 24, cols: 80, terminalType: 'xterm' })
    const outcome = allocation.then(async handle => { await handle.done; return null }, error => error)
      .catch(error => error)
    let replacement
    try {
      await Promise.race([entered.promise, outcome.then(() => { throw new Error('The target did not reach its controlled wait.') })])
      if (change !== 'unchanged') {
        withdraw()
        if (change === 'replaced') replacement = ctx.effect(() => ctx.provide('resourceBudget', { async acquire() {
          replacementAdmissions++; return lease
        } }))
      }
      proceed.resolve()
      const error = await outcome
      if (error === null) await released.promise
      else if (error.reason !== 'unavailable') throw error
      if (kind === 'process' && error !== null) await released.promise
      console.log(JSON.stringify({ kind, phase, change, reason: error?.reason ?? null, starts: active.starts,
        created: existsSync(marker), admissions, releases, uncertainties, replacementAdmissions }))
    } finally {
      proceed.resolve(); await outcome; await replacement?.(); await registration()
    }
  }
} finally { await connection?.dispose(); await ctx.fiber.dispose() }
