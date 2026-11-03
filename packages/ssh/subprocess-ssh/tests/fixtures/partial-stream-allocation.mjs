/** Loader application retains failed process admission through an actually running SSH control command. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const repository = new URL('../../../../../', import.meta.url)
const entry = path => path === 'ssh/subprocess-ssh' && artifactRoot !== undefined
  ? pathToFileURL(resolve(artifactRoot, mode === 'src' ? 'src/index.ts' : 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, repository).href
const { boot } = await import(entry('boot/app-boot'))
const { SshConnection } = await import(entry('ssh/ssh'))
const { SshSubprocessRuntime } = await import(entry('ssh/subprocess-ssh'))
const helper = fileURLToPath(new URL(`packages/ssh/ssh/${mode === 'src' ? 'src/helper-entry.ts' : 'lib/helper.js'}`, repository))
const workspace = process.cwd(), held = join(workspace, 'native-held.json'), proceed = join(workspace, 'native-proceed')
const marker = join(workspace, 'payload-created'), bin = join(workspace, 'bin'), config = join(workspace, 'cordis.yml')
await writeFile(config, '[]\n')
const ctx = await boot('ssh-partial-stream-allocation', config)
const originalPath = process.env.PATH
let connection, provider
try {
  let carrier = await readFile(new URL('../../../ssh/tests/fixtures/local-ssh-carrier.mjs', import.meta.url), 'utf8')
  const importLine = "import { createConnection, createServer } from 'node:net'"
  assert.ok(carrier.includes(importLine))
  carrier = carrier.replace(importLine, `${importLine}\nimport { existsSync, writeFileSync } from 'node:fs'\nimport { setTimeout as delay } from 'node:timers/promises'\nconst waitForFile = async path => { const signal = AbortSignal.timeout(15000); while (!existsSync(path)) await delay(10, undefined, { signal }) }`)
  const branch = 'if (operation !== -1) {'
  assert.ok(carrier.includes(branch))
  carrier = carrier.replace(branch, `${branch}\n  const forward = args[args.indexOf('-L') + 1], forwarding = args[operation + 1] === 'forward'\n  const heldControl = forwarding && forward.endsWith('/stderr')\n  let keepAlive\n  if (forwarding && forward.endsWith('/stdout')) await waitForFile(${JSON.stringify(held)})\n  if (heldControl) { process.on('SIGTERM', () => {}); keepAlive = setInterval(() => {}, 1000) }`)
  const finished = "socket.once('close', () => {\n    if (reply.trim() === 'ok') return"
  assert.ok(carrier.includes(finished))
  carrier = carrier.replace(finished, `socket.once('close', async () => {\n    if (heldControl) { writeFileSync(${JSON.stringify(held)}, JSON.stringify({ pid: process.pid })); try { await waitForFile(${JSON.stringify(proceed)}) } finally { clearInterval(keepAlive) } }\n    if (reply.trim() === 'ok') return`)
  const command = 'const command = async ({ method, forward, reverse }) => {'
  assert.ok(carrier.includes(command))
  carrier = carrier.replace(command, `${command}\n    if (method === 'forward' && forward.endsWith('/stdout')) throw new Error('Fixture stdout forwarding refused')`)
  if (mode === 'src') {
    const launch = "['--disable-sigusr1', helper]"
    assert.ok(carrier.includes(launch))
    carrier = carrier.replace(launch, `['--disable-sigusr1', '--import', ${JSON.stringify(import.meta.resolve('tsx/esm'))}, helper]`)
  }
  const script = join(workspace, 'ssh-carrier.mjs')
  await writeFile(script, carrier); await mkdir(bin)
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  await writeFile(join(bin, 'ssh'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${quote(helper)} "$@"\n`, { mode: 0o700 })
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`
  let ordinaryAdmissions = 0, ordinaryReleases = 0, infrastructureAdmissions = 0, infrastructureReleases = 0, uncertainties = 0
  ctx.effect(() => ctx.provide('resourceBudgetRequired', true))
  ctx.effect(() => ctx.provide('resourceBudget', { async acquire(request) {
    assert.equal(request.kind, 'process')
    const infrastructure = request.origin === 'infrastructure'
    if (infrastructure) infrastructureAdmissions++
    else ordinaryAdmissions++
    let settled = false
    return { signal: new AbortController().signal,
      release: async () => {
        if (settled) return
        settled = true
        if (infrastructure) infrastructureReleases++
        else ordinaryReleases++
      }, uncertain: async () => { uncertainties++ } }
  } }))
  connection = new SshConnection(ctx.isolate('ssh'), { host: 'partial-stream-fixture', launch: { kind: 'node-script', node: process.execPath },
    helper, helperHash: createHash('sha256').update(await readFile(helper)).digest('hex'), workspace,
    requestTimeoutMs: 10_000, leaseMs: 30_000 })
  await connection.ready
  const request = connection.request.bind(connection), terminated = Promise.withResolvers()
  let starts = 0
  ctx.effect(() => ctx.provide('ssh', {
    retainConsumer: connection.retainConsumer.bind(connection), dispose: connection.dispose.bind(connection), ready: connection.ready,
    connectStream: connection.connectStream.bind(connection),
    request: async (method, ...args) => {
      if (method === 'process.start') starts++
      const result = await request(method, ...args)
      if (method === 'process.terminate') terminated.resolve()
      return result
    },
  }))
  provider = await ctx.plugin(SshSubprocessRuntime)
  const handle = await ctx.subprocess.spawn({ argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'created')`],
    cwd: workspace, graceMs: 100, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } })
  let doneSettled = false, observationSettled = false, disposed = false
  const done = handle.done.then(() => false, error => error instanceof Error).finally(() => { doneSettled = true })
  await terminated.promise
  const native = JSON.parse(await readFile(held, 'utf8'))
  assert.ok(Number.isSafeInteger(native.pid) && native.pid > 0)
  const alive = () => { try { process.kill(native.pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
  const observation = handle.waitForExit().finally(() => { observationSettled = true })
  const disposal = provider.dispose().then(() => { disposed = true })
  await new Promise(ready => setImmediate(ready))
  const before = { nativeControlAlive: alive(), resultHeld: !doneSettled, observationHeld: !observationSettled,
    providerHeld: !disposed, ordinaryPermitRetained: ordinaryReleases === 0 }
  await writeFile(proceed, 'released')
  const originalFailureRetained = await done
  const rangeConfirmed = await observation
  await disposal
  const masterReusable = await connection.request('heartbeat', {}, z.null()).then(() => true, () => false)
  await connection.dispose()
  console.log(JSON.stringify({ ...before, originalFailureRetained, rangeConfirmed, masterReusable,
    launchRefused: starts === 0 && !existsSync(marker), nativeControlStopped: !alive(),
    ordinaryAdmissions, ordinaryReleases, allInfrastructurePermitsCompleted: infrastructureAdmissions === infrastructureReleases, uncertainties }))
} finally {
  try {
    await writeFile(proceed, 'released')
    try { await provider?.dispose() } finally {
      try { await connection?.dispose() } finally { await ctx.fiber.dispose() }
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
}
