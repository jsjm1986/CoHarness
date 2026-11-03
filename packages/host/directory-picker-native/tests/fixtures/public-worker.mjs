/** Observe actual public worker allocation without replacing the process or its program. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'

const [mode] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
assert.notEqual(process.platform, 'win32')
const owned = [], closed = new Set(), original = childProcess.spawn
const watchdog = setTimeout(() => { for (const child of owned) child.kill('SIGKILL') }, 15_000)
childProcess.spawn = (...args) => {
  const child = original(...args)
  owned.push(child)
  child.once('close', () => closed.add(child))
  return child
}
syncBuiltinESMExports()
try {
  const { pickNativeDirectory } = await import(new URL(`../../${mode}/index.${mode === 'src' ? 'ts' : 'js'}`, import.meta.url))
  await assert.rejects(pickNativeDirectory(new AbortController().signal, { platform: 'win32' }), /win32 folder dialog failed/)
  assert.equal(owned.length, 1)
  console.log(JSON.stringify({ operation: 'native-surface-failure', workerClosed: closed.has(owned[0]) }))
} finally {
  childProcess.spawn = original; syncBuiltinESMExports()
  for (const child of owned) {
    const completion = closed.has(child) ? Promise.resolve() : once(child, 'close')
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    await completion
  }
  clearTimeout(watchdog)
}
