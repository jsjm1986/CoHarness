/** Exercise Gateway control and maintenance allocation in a dedicated process group. */
import nativeChildProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const [mode, implementation = 'src'] = process.argv.slice(2)
const root = await mkdtemp(join(tmpdir(), 'gateway-failed-spawn-'))
const missing = join(root, 'executable-that-does-not-exist'), controller = new AbortController()
const reason = new Error('fixture cancellation'), originalSpawn = nativeChildProcess.spawn
try {
  const extension = implementation === 'lib' ? 'js' : 'ts'
  let pending
  if (mode.startsWith('helper-')) {
    const { runGatewayChildCommand } = await import(`../../${implementation}/child-command.${extension}`)
    if (mode === 'helper-pre') controller.abort(reason)
    pending = runGatewayChildCommand(missing, [], 10_000, controller.signal)
    if (mode === 'helper-post') controller.abort(reason)
  } else {
    nativeChildProcess.spawn = (...args) => {
      const child = originalSpawn(...args)
      if (args[0] === missing && mode === 'maintenance-post') controller.abort(reason)
      return child
    }
    syncBuiltinESMExports()
    const { createDeploymentCommands } = await import(`../../${implementation}/deployment-commands.${extension}`)
    const dump = join(root, 'fixture.dump')
    await writeFile(dump, 'fixture')
    pending = createDeploymentCommands([missing], [missing]).verifyDump(dump, controller.signal)
  }
  const result = await pending.then(() => { throw new Error('Unexpected successful command') }, error => ({
    scenario: mode, rejected: true, callerCancelled: controller.signal.aborted,
    cancellationReasonPreserved: error === reason, missingExecutable: error.code === 'ENOENT',
  }))
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  nativeChildProcess.spawn = originalSpawn
  syncBuiltinESMExports()
  await rm(root, { recursive: true, force: true })
}
