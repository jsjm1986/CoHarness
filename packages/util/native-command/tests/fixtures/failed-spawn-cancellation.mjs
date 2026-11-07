/** Run cancellation at the native allocation edge inside an isolated test process. */
import { existsSync, watch } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const [mode, implementation = 'src'] = process.argv.slice(2)
const { runNativeCommand } = await import(implementation === 'lib' ? '../../lib/index.js' : '../../src/runner.ts')
const root = await mkdtemp(join(tmpdir(), 'native-failed-spawn-'))
const controller = new AbortController()
let pending, watcher
try {
  if (mode.startsWith('before-')) controller.abort(new Error('cancelled before native dispatch'))
  let pid
  if (mode === 'during-live') {
    const path = join(root, 'ready'), ready = Promise.withResolvers()
    watcher = watch(root, () => { if (existsSync(path)) ready.resolve() })
    pending = runNativeCommand(process.execPath, ['--input-type=module', '-e',
      "import {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},60000)", path],
    AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), 'hidden')
    await Promise.race([ready.promise, pending.then(() => { throw new Error('Helper exited before readiness') })])
    watcher.close(); watcher = undefined
    pid = Number(await readFile(path, 'utf8'))
    controller.abort(new Error('cancelled live TERM-resistant helper'))
  } else {
    const command = mode === 'before-existing' ? process.execPath : join(root, 'executable-that-does-not-exist')
    pending = runNativeCommand(command, ['-e', 'process.stdout.write("unexpected")'], controller.signal, 'hidden')
  }
  if (mode === 'during-missing') controller.abort(new Error('cancelled after failed allocation'))
  const result = await pending.then(() => { throw new Error('Unexpected successful command') }, error => ({
    scenario: mode, code: error.code, stdout: error.stdout, stderr: error.stderr,
  }))
  if (pid !== undefined) {
    try { process.kill(pid, 0); result.helperRunningAfterReturn = true } catch (error) {
      if (error.code !== 'ESRCH') throw error
      result.helperRunningAfterReturn = false
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  controller.abort()
  await pending?.catch((_fixtureCommandFailure) => undefined)
  watcher?.close()
  await rm(root, { recursive: true, force: true })
}
