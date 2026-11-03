/** Real Loader, SSH carrier and helper prove stream-forward rollback and failed-cancel ownership. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const repository = new URL('../../../../../', import.meta.url)
const entry = path => path === 'ssh/ssh' && artifactRoot !== undefined
  ? pathToFileURL(join(artifactRoot, mode === 'src' ? 'src/index.ts' : 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, repository).href
const sshRoot = artifactRoot ?? fileURLToPath(new URL('packages/ssh/ssh/', repository))
const { preparedSchema } = await import(pathToFileURL(join(sshRoot, mode === 'src' ? 'src/schemas.ts' : 'lib/schemas.js')).href)
const { boot } = await import(entry('boot/app-boot'))
const { SshConnection } = await import(entry('ssh/ssh'))
const helper = join(sshRoot, mode === 'src' ? 'src/helper-entry.ts' : 'lib/helper.js')
const workspace = process.cwd(), config = join(workspace, 'cordis.yml')
await writeFile(config, '[]\n')
const ctx = await boot('ssh-stream-forwarding', config)
const originalPath = process.env.PATH
let active, connection
try {
  ctx.effect(() => ctx.provide('resourceBudgetRequired', true))
  ctx.effect(() => ctx.provide('resourceBudget', { async acquire(request) {
    assert.equal(request.origin, 'infrastructure')
    const owner = active, ordinal = ++owner.admissions
    let settled = false
    return { signal: new AbortController().signal,
      release: async () => {
        if (settled) return
        settled = true; owner.releases++
        if (ordinal === 1) owner.masterStopped.resolve(true)
        if (owner.armed) { owner.armed = false; owner.caller.abort(new Error('cancel completed stream forward')) }
      }, uncertain: async () => { owner.uncertainties++ } }
  } }))
  for (const phase of ['caller-cancel', 'cancel-failure']) {
    active = { admissions: 0, releases: 0, uncertainties: 0, armed: false,
      masterStopped: Promise.withResolvers(), caller: new AbortController() }
    const audit = join(workspace, `${phase}.jsonl`), bin = join(workspace, phase)
    await writeFile(audit, '')
    let carrier = await readFile(new URL('./local-ssh-carrier.mjs', import.meta.url), 'utf8')
    const importLine = "import { createConnection, createServer } from 'node:net'"
    assert.ok(carrier.includes(importLine))
    carrier = carrier.replace(importLine, `${importLine}\nimport { appendFileSync } from 'node:fs'`)
    const handler = 'const command = async ({ method, forward, reverse }) => {'
    assert.ok(carrier.includes(handler))
    carrier = carrier.replace(handler, `${handler}\n    appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ method, forward, reverse }) + '\\n')\n    if (method === 'cancel' && ${JSON.stringify(phase)} === 'cancel-failure') throw new Error('Fixture mux cancellation rejected')`)
    if (mode === 'src') {
      const launch = "['--disable-sigusr1', helper]"
      assert.ok(carrier.includes(launch))
      carrier = carrier.replace(launch, `['--disable-sigusr1', '--import', ${JSON.stringify(import.meta.resolve('tsx/esm'))}, helper]`)
    }
    const script = join(workspace, `${phase}.mjs`)
    await writeFile(script, carrier); await mkdir(bin)
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`
    await writeFile(join(bin, 'ssh'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${quote(helper)} "$@"\n`, { mode: 0o700 })
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`
    connection = new SshConnection(ctx.isolate('ssh'), { host: 'stream-forward-fixture', launch: { kind: 'node-script', node: process.execPath },
      helper, helperHash: createHash('sha256').update(await readFile(helper)).digest('hex'), workspace,
      requestTimeoutMs: 10_000, leaseMs: 30_000 })
    await connection.ready
    const prepared = await connection.request('process.prepare', {
      argv: [process.execPath], cwd: workspace, graceMs: 50,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    }, preparedSchema)
    let callerCancelled = false, stoppedAfterFailure = false
    if (phase === 'caller-cancel') {
      active.armed = true
      const result = await connection.connectStream(prepared.streams.stdout, active.caller.signal)
        .then(socket => { socket.destroy(); return false }, error => error.message.includes('cancel completed stream forward'))
      callerCancelled = result
    } else {
      const socket = await connection.connectStream(prepared.streams.stdout)
      socket.destroy()
      let deadline
      try {
        stoppedAfterFailure = await Promise.race([
          active.masterStopped.promise,
          new Promise(ready => { deadline = setTimeout(() => ready(false), 10_000) }),
        ])
      } finally { clearTimeout(deadline) }
    }
    const commands = (await readFile(audit, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const allocated = commands.find(command => command.method === 'forward' && !command.reverse)
    assert.ok(allocated)
    const local = allocated.forward.split(':')[0]
    const removedBeforeDispose = !existsSync(local)
    const reusable = await connection.request('heartbeat', {}, z.null()).then(() => true, () => false)
    if (reusable) await connection.request('process.terminate', { id: prepared.id }, z.null())
    await connection.dispose()
    connection = undefined
    console.log(JSON.stringify({ phase, callerCancelled, cancelCommands: commands.filter(command => command.method === 'cancel').length,
      removedBeforeDispose, reusable, stoppedAfterFailure,
      allNativePermitsCompleted: active.admissions === active.releases, uncertainties: active.uncertainties }))
  }
} finally {
  await connection?.dispose()
  await ctx.fiber.dispose()
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
}
