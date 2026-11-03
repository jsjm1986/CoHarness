/** Loader backend withdrawal must join rollback of a real unpublished PTY. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scheduler } from 'node:timers/promises'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const root = new URL('../../../../../', import.meta.url)
const entry = path => path === 'terminal/terminal' && artifactRoot !== undefined
  ? pathToFileURL(resolve(artifactRoot, mode === 'src' ? 'src/index.ts' : 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root).href
const { boot } = await import(entry('boot/app-boot'))
const { SessionId } = await import(entry('core/session'))
const backend = await import('./backend-lifetime-plugin.mjs')
const workspace = join(process.cwd(), 'workspace'), home = join(process.cwd(), '.dsh'), config = join(process.cwd(), 'cordis.yml')
await mkdir(workspace)
const plugins = [
  ['credentials/credentials-local', { path: join(home, 'credentials.yaml'), dshHome: home, watch: false }],
  ['core/session'], ['llm/llm'], ['core/system-prompt'], ['core/tools'], ['core/agent'],
  ['session/session-projection'], ['core/agent-loop', { agents: [] }],
  ['fs/fs-local', { cwd: workspace }], ['session/working-directory'],
  ['sandbox/sandbox-local'], ['sandbox/sandbox-policy', { mode: 'danger-full-access', workspaceRoot: workspace }],
  ['subprocess/subprocess-local'], ['terminal/terminal'],
]
await writeFile(config, JSON.stringify([
  ...plugins.map(([path, options]) => ({ name: entry(path), ...options === undefined ? {} : { config: options } })),
  { id: 'held-native-backend', name: new URL('./backend-lifetime-plugin.mjs', import.meta.url).href,
    config: { pollIntervalMs: 10, exactProbeAfterMs: 20, idleSilenceMs: 250, handoffGraceMs: 250, timeoutMs: 5_000, disposeGraceMs: 500 } },
]))
const ctx = await boot('terminal-backend-lifetime', config)
let handle, pending, stopping, concurrent
try {
  handle = await ctx.agents.create({ sessionId: SessionId('native-terminal-owner'), meta: { cwd: workspace } })
  const mounted = [...ctx.loader.entries()].find(row => row.options.id === 'held-native-backend')
  assert.ok(mounted?.fiber)
  pending = ctx.terminals.spawn(handle.agent, { type: 'shell', name: 'pending', cwd: workspace })
  const outcome = pending.then(value => ({ value }), error => ({ error }))
  const { session, signal } = await backend.entered.promise
  assert.equal(session.status().kind, 'running')
  assert.ok(session.pid > 0)
  process.kill(session.pid, 0)
  let stopped = false
  stopping = mounted.fiber.dispose().then(() => { stopped = true })
  await scheduler.yield()
  assert.equal(signal.aborted, true, 'Backend withdrawal left native terminal startup active')
  assert.equal(stopped, false, 'Backend withdrawal did not join the unpublished native terminal')
  let joined = false
  concurrent = backend.withdraw().then(() => { joined = true })
  await scheduler.yield()
  assert.equal(joined, false, 'A concurrent disposer returned before native terminal rollback')
  assert.equal(ctx.terminals.hasOwnerActivity(handle.agent), true)
  console.log(JSON.stringify({ phase: 'withdrawn', nativePtyWasRunning: true, setupCancelled: true, disposalJoined: true, concurrentDisposalJoined: true }))
  backend.release.resolve()
  const result = await outcome
  assert.equal(result.error?.code, 'NO_BACKEND')
  await stopping
  await concurrent
  assert.equal(session.status().kind, 'exited')
  assert.throws(() => process.kill(session.pid, 0), { code: 'ESRCH' })
  assert.deepEqual(ctx.terminals.list(handle.agent), [])
  assert.equal(ctx.terminals.hasOwnerActivity(handle.agent), false)
  console.log(JSON.stringify({ phase: 'settled', refusal: result.error.code, nativePtyStopped: true, publishedSessions: 0 }))
} finally {
  backend.release.resolve()
  await pending?.catch(() => {})
  await stopping
  await concurrent
  await handle?.dispose()
  await ctx.fiber.dispose()
}
