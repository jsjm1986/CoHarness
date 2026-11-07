/** Loader-owned SSH filesystem and a real helper preserve text-stream capacity. */
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
const entry = path => path === 'ssh/fs-ssh' && artifactRoot !== undefined
  ? pathToFileURL(resolve(artifactRoot, mode === 'src' ? 'src/index.ts' : 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, repository).href
const { boot } = await import(entry('boot/app-boot'))
const { SSH_MAX_TEXT_STREAMS } = await import(new URL(`packages/ssh/ssh/${mode === 'src' ? 'src/protocol.ts' : 'lib/protocol.js'}`, repository))
const helper = fileURLToPath(new URL(`packages/ssh/ssh/${mode === 'src' ? 'src/helper-entry.ts' : 'lib/helper.js'}`, repository))
const workspace = process.cwd(), filename = join(workspace, 'text.txt'), config = join(workspace, 'cordis.yml')
const originalPath = process.env.PATH
let ctx, privateRoot
try {
  let carrier = await readFile(new URL('../../../ssh/tests/fixtures/local-ssh-carrier.mjs', import.meta.url), 'utf8')
  if (mode === 'src') {
    const launch = "['--disable-sigusr1', helper]"
    assert.ok(carrier.includes(launch))
    carrier = carrier.replace(launch, `['--disable-sigusr1', '--import', ${JSON.stringify(import.meta.resolve('tsx/esm'))}, helper]`)
  }
  const carrierPath = join(workspace, 'carrier.mjs'), bin = join(workspace, 'bin')
  await writeFile(carrierPath, carrier)
  await mkdir(bin)
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  await writeFile(join(bin, 'ssh'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(carrierPath)} ${quote(helper)} "$@"\n`, { mode: 0o700 })
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`
  await writeFile(filename, 'fixture read\n')
  await writeFile(config, JSON.stringify([
    { name: entry('session/session-projection') },
    { name: entry('sandbox/sandbox-policy'), config: { mode: 'read-only', workspaceRoot: workspace } },
    { name: entry('ssh/ssh'), config: { host: 'stream-lifecycle-fixture', launch: { kind: 'node-script', node: process.execPath },
      helper, helperHash: createHash('sha256').update(await readFile(helper)).digest('hex'), workspace,
      requestTimeoutMs: 10_000, leaseMs: 30_000 } },
    { name: entry('ssh/fs-ssh') },
  ]))
  ctx = await boot('ssh-text-stream-lifecycle', config)
  privateRoot = (await ctx.ssh.ready).root
  const target = await ctx.fs.resolve('text.txt')
  for (let index = 0; index <= SSH_MAX_TEXT_STREAMS; index++) {
    const iterator = (await ctx.fs.streamText(target))[Symbol.asyncIterator]()
    assert.deepEqual(await iterator.return(), { done: true, value: undefined })
  }
  const reservations = []
  try {
    for (let index = 0; index < SSH_MAX_TEXT_STREAMS; index++) {
      reservations.push(await ctx.ssh.request('fs.stream', { target }, z.string()))
    }
    await assert.rejects(ctx.ssh.request('fs.stream', { target }, z.string()), /text stream limit/u)
  } finally {
    for (const id of reservations) await ctx.ssh.request('fs.streamClose', { id }, z.null())
  }
  console.log(JSON.stringify({ phase: 'unread', closedBeforeFirstPull: SSH_MAX_TEXT_STREAMS + 1,
    remainingCapacity: reservations.length, capacityBoundPreserved: true }))
  const cancelled = new AbortController(), failure = new Error('unread stream cancelled')
  const unread = (await ctx.fs.streamText(target, cancelled.signal))[Symbol.asyncIterator]()
  cancelled.abort(failure)
  await assert.rejects(unread.next(), error => error === failure)
  const content = []
  for await (const chunk of await ctx.fs.streamText(target)) content.push(chunk)
  assert.equal(content.join(''), 'fixture read\n')
  const partial = (await ctx.fs.streamText(target))[Symbol.asyncIterator]()
  assert.equal((await partial.next()).value, 'fixture read\n')
  await partial.return()
  const observed = await ctx.fs.stat(target)
  const versioned = await ctx.fs.streamText(target, undefined, observed.version)
  await writeFile(filename, 'changed read payload\n')
  await assert.rejects(versioned[Symbol.asyncIterator]().next(), error => error.code === 'FS_STALE_VERSION')
  assert.equal(await ctx.fs.readText(target), 'changed read payload\n')
  console.log(JSON.stringify({ phase: 'reads', cancellationRetained: true, text: content.join(''),
    earlyCloseAcknowledged: true, staleVersionRefused: true, connectionReusable: true }))
} finally {
  try { await ctx?.fiber.dispose() } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
}
assert.ok(privateRoot)
assert.equal(existsSync(privateRoot), false)
console.log(JSON.stringify({ phase: 'disposed', helperPrivateRootRemoved: true }))
