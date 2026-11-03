/** Plain-Node public-package admission and real local helper lifecycle. */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { SshConnection } from '../../lib/index.js'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'

const [root] = process.argv.slice(2)
assert.ok(root)
const ctx = new Context()
const grant = Promise.withResolvers(), requested = Promise.withResolvers()
const permit = new AbortController()
let requests = 0, completions = 0, uncertainties = 0
const lease = () => {
  let completed = false
  return { signal: permit.signal,
    async release() { if (!completed) { completed = true; completions++ } },
    async uncertain() { uncertainties++ },
  }
}
const first = lease()
const helper = fileURLToPath(new URL('../../lib/helper.js', import.meta.url))
const bin = join(root, 'bin'), marker = join(root, 'started')
await mkdir(bin)
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const carrier = fileURLToPath(new URL('./local-ssh-carrier.mjs', import.meta.url))
await writeFile(join(bin, 'ssh'), `#!/bin/sh\nprintf started > ${quote(marker)}\nexec ${quote(process.execPath)} ${quote(carrier)} ${quote(helper)} "$@"\n`, { mode: 0o700 })
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
ctx.provide('resourceBudgetRequired', true)
ctx.provide('resourceBudget', { async acquire(request) {
  assert.equal(request.kind, 'process')
  assert.equal(request.origin, 'infrastructure')
  requests++
  requested.resolve()
  return requests === 1 ? grant.promise : lease()
} })
const connection = new SshConnection(ctx, {
  host: 'local-fixture', launch: { kind: 'node-script', node: process.execPath }, helper,
  helperHash: createHash('sha256').update(await readFile(helper)).digest('hex'), workspace: root,
  requestTimeoutMs: 5_000, leaseMs: 30_000,
})
const interrupted = () => {
  permit.abort(new Error('fixture carrier is stopping'))
  grant.resolve(first)
  void connection.dispose().finally(() => ctx.fiber.dispose()).then(
    () => { process.exitCode = 143 },
    (error) => { console.error(error); process.exitCode = 1 },
  )
}
process.once('SIGTERM', interrupted)
try {
  await Promise.race([requested.promise, connection.ready.then(() => { throw new Error('local carrier bypassed admission') })])
  await assert.rejects(access(marker))
  grant.resolve(first)
  const ready = await connection.ready
  assert.equal(ready.workspace, root)
  await access(marker)
  assert.equal(completions, 0)
  await ctx.plugin(SshSubprocessRuntime)
  const job = await ctx.subprocess.spawn({
    argv: [process.execPath, '-e', 'process.stdout.write("remote-ready\\n"); setInterval(() => {}, 1000)'],
    cwd: root, resourceOrigin: 'infrastructure', graceMs: 50,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
  })
  void job.done.catch(() => {})
  const deadline = AbortSignal.timeout(5_000)
  await Promise.race([
    (async () => {
      while (!job.collected.stdout.readFrom(0).text.includes('remote-ready')) {
        deadline.throwIfAborted()
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    })(),
    job.done.then(result => { throw new Error(`remote job exited before readiness: ${JSON.stringify(result)}`) }),
  ])
  await ctx.fiber.dispose()
  assert.equal(await job.waitForExit(), true)
  assert.ok(requests >= 4)
  assert.equal(completions, requests)
  assert.equal(uncertainties, 0)
  console.log(JSON.stringify({ waited: true, requests, completed: true, uncertainties, remoteJobStopped: true }))
} finally {
  process.off('SIGTERM', interrupted)
  grant.resolve(first)
  try { await connection.dispose() } finally { await ctx.fiber.dispose() }
}
