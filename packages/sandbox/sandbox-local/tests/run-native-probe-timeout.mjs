/** Keyless real-process probe deadlines through source or public compiled sandbox plugin. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const [mode, artifact = '-', selected = 'all'] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
assert.notEqual(process.platform, 'win32')
const entry = artifact === '-' ? fileURLToPath(new URL(`../${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, import.meta.url)) : artifact
const runners = ['bwrap', 'landlock', 'seatbelt', 'windows-acl'], transcript = []
assert.ok(selected === 'all' || runners.includes(selected))
async function endpoint(marker, release = false) {
  try { return await (await fetch(`${marker.url}/${release ? 'release/' : ''}${marker.token}`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(1000) })).text() }
  catch (error) { if (['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code)) return undefined; throw error }
}
for (const runner of selected === 'all' ? runners : [selected]) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-probe-deadline-'))
  let pending, marker, timer, primaryError
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
    const binary = join(root, 'bwrap')
    await writeFile(binary, `#!${process.execPath}\n${await readFile(new URL('./fixtures/probe-client.mjs', import.meta.url), 'utf8')}`)
    await chmod(binary, 0o700)
    pending = promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/probe-timeout-driver.mjs', import.meta.url)), entry, runner, root,
    ], { timeout: 30_000, killSignal: 'SIGKILL', env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}`,
      NODE_OPTIONS: undefined, NODE_PATH: undefined } }).then(value => ({ value }), error => ({ error }))
    const deadline = performance.now() + 20_000
    while (marker === undefined) {
      try { marker = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT' || performance.now() >= deadline) throw error; await delay(10) }
    }
    assert.equal(await endpoint(marker), marker.token)
    const result = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Confinement probe retained a native client past its deadline')), 15_000) })])
    assert.ok(result.value, result.error?.message)
    assert.equal(await endpoint(marker), undefined)
    transcript.push(result.value.stdout)
  } catch (error) { primaryError = error; throw error }
  finally {
    clearTimeout(timer)
    const failures = []
    if (marker !== undefined) { try { await endpoint(marker, true) } catch (error) { failures.push(error) } }
    await pending
    try { await rm(root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], 'Confinement probe fixture cleanup failed')
  }
}
const expected = (await readFile(new URL('./fixtures/probe-timeout.expected.md', import.meta.url), 'utf8')).trimEnd().split('\n')
const actual = transcript.join('')
assert.equal(actual, (selected === 'all' ? expected : [expected[runners.indexOf(selected)]]).join('\n') + '\n')
process.stdout.write(actual)
