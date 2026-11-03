/** Actual credential files distinguish stopped attempts from already-admitted writes. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scheduler } from 'node:timers/promises'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const root = new URL('../../../../../', import.meta.url)
const entry = path => path === 'credentials/authorization' && artifactRoot !== undefined
  ? pathToFileURL(resolve(artifactRoot, mode === 'src' ? 'src/index.ts' : 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root).href
const { boot } = await import(entry('boot/app-boot'))
const { credentialKey } = await import(entry('credentials/credentials'))
const key = credentialKey('native-proof', 'account'), grant = { kind: 'grant', payload: { account: 'original' } }
for (const scenario of ['retained', 'cancelled', 'admitted']) {
  const directory = join(process.cwd(), scenario), home = join(directory, '.dsh'), config = join(directory, 'cordis.yml')
  const filename = join(home, 'credentials.yaml')
  await mkdir(directory)
  await writeFile(config, JSON.stringify([
    { name: entry('credentials/credentials-local'), config: { path: filename, dshHome: home, watch: false } },
    { id: 'authorization-owner', name: entry('credentials/authorization') },
  ]))
  const ctx = await boot('authorization-owner-' + scenario, config), service = ctx.authorization
  const mounted = [...ctx.loader.entries()].find(row => row.options.id === 'authorization-owner')
  assert.ok(mounted?.fiber)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let stopping, pending, session, calls = 0, notices = 0, prompts = 0, promptRefusal, commitRefusal
  const interaction = { notify() { notices++ }, async prompt() { prompts++; return 'late answer' } }
  try {
    service.registerFlow({ key, label: 'Native account', methods: [{ id: 'login', label: 'Login' }], async run(current) {
      session = current; calls++
      if (scenario === 'cancelled') {
        entered.resolve()
        await release.promise
        current.notify({ message: 'retired notice' })
        try { await current.prompt({ kind: 'secret', message: 'retired prompt' }) } catch (error) { promptRefusal = error.code }
        try { await current.commit(async () => grant) } catch (error) { commitRefusal = error.code }
      } else await current.commit(async () => grant)
    } })
    if (scenario === 'retained') {
      await mounted.fiber.dispose()
      let refusal
      try { await service.begin({ key, interaction }) } catch (error) { refusal = error.code }
      const stored = await ctx.credentials.readRecord(key)
      console.log(JSON.stringify({ scenario, refusal: refusal ?? null, calls, stored: stored !== undefined }))
      assert.equal(refusal, 'WITHDRAWN', 'A stopped authorization service admitted another credential write')
      assert.equal(calls, 0); assert.equal(stored, undefined)
    } else if (scenario === 'cancelled') {
      pending = service.begin({ key, interaction })
      await entered.promise
      let stopped = false
      stopping = mounted.fiber.dispose().then(() => { stopped = true })
      await scheduler.yield()
      assert.equal(session.signal.aborted, true)
      assert.equal(stopped, false, 'Authorization disposal did not join its retained flow')
      release.resolve()
      assert.deepEqual(await pending, { status: 'cancelled' })
      await stopping
      assert.equal(notices, 0); assert.equal(prompts, 0)
      assert.equal(promptRefusal, 'WITHDRAWN'); assert.equal(commitRefusal, 'WITHDRAWN')
      assert.equal(await ctx.credentials.readRecord(key), undefined)
      console.log(JSON.stringify({ scenario, joinedFlow: true, notices, prompts, promptRefusal, commitRefusal, stored: false }))
    } else {
      ctx.on('credentials/record-updated', changed => {
        if (changed === key) stopping = mounted.fiber.dispose()
      })
      assert.deepEqual(await service.begin({ key, interaction }), { status: 'authorized' })
      await stopping
      assert.equal(session.signal.aborted, false)
      assert.deepEqual(await ctx.credentials.readRecord(key), grant)
      assert.ok((await readFile(filename, 'utf8')).includes('original'))
      console.log(JSON.stringify({ scenario, authorized: true, originalFileVerified: true, callerAborted: false }))
    }
  } finally {
    release.resolve()
    await pending?.catch(() => {})
    await stopping
    await ctx.fiber.dispose()
  }
}
