/** Real-process timeout replay for the source or emitted Linux native-control owner. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

assert.notEqual(process.platform, 'win32')
const [mode, artifact] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const entry = artifact ?? fileURLToPath(new URL(`../${mode === 'src' ? 'src/linux-scope.ts' : 'lib/types/linux-scope.js'}`, import.meta.url))
const transcript = []
async function endpoint(marker, release = false) {
  try { return await (await fetch(`${marker.url}/${release ? 'release/' : ''}${marker.token}`, { signal: AbortSignal.timeout(1000), headers: { connection: 'close' } })).text() }
  catch (error) { if (['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code)) return undefined; throw error }
}
for (const operation of ['query', 'probe']) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-linux-control-'))
  let marker, pending, timer, primaryError
  try {
    const binary = join(root, 'systemctl')
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
    await writeFile(binary, `#!${process.execPath}\n${await readFile(new URL('./fixtures/linux-control-client.mjs', import.meta.url), 'utf8')}`)
    await chmod(binary, 0o700)
    pending = promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/linux-control-driver.mjs', import.meta.url)), entry, operation, root,
    ], { timeout: 30_000, killSignal: 'SIGKILL', env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined } })
      .then(value => ({ value }), error => ({ error }))
    const readiness = performance.now() + 20_000
    while (marker === undefined) {
      try { marker = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT' || performance.now() >= readiness) throw error; await delay(10) }
    }
    assert.equal(await endpoint(marker), marker.token)
    const result = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native control client outlived its deadline')), 10_000) })])
    assert.ok(result.value, result.error?.message)
    assert.equal(await endpoint(marker), undefined)
    transcript.push(result.value.stdout)
  } catch (error) { primaryError = error; throw error }
  finally {
    clearTimeout(timer)
    const failures = []
    if (marker !== undefined) {
      try { await endpoint(marker, true) } catch (error) { failures.push(error) }
    }
    await pending
    try { await rm(root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], 'Native control fixture cleanup failed')
  }
}
const actual = transcript.join('')
assert.equal(actual, await readFile(new URL('./fixtures/linux-control-timeout.expected.md', import.meta.url), 'utf8'))
process.stdout.write(actual)
