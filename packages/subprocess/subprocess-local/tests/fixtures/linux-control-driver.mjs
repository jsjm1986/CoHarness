/** Exercise a real Linux native-owner query or synchronous manager probe without a host manager. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [entry, operation, root] = process.argv.slice(2)
const { prepareLinuxTerminalScope, probeLinuxManager } = await import(pathToFileURL(entry).href)
const systemctl = join(root, 'systemctl')
if (operation === 'query') {
  const scope = prepareLinuxTerminalScope({ argv: [process.execPath], cwd: root, rows: 24, cols: 80, terminalType: 'dumb', graceMs: 100 }, {}, [],
    { systemctl, runnerInvocation: [process.execPath] })
  try {
    const owner = scope.bindOwner({ running: () => false, signal: () => false, settled: Promise.resolve() })
    await assert.rejects(owner.waitForExit(), { killed: true, signal: 'SIGKILL' })
    process.stdout.write('An unresponsive native scope query closes and retains unknown managed ownership.\n')
  } finally { scope.cleanup() }
} else {
  assert.equal(operation, 'probe')
  assert.equal(probeLinuxManager({ systemctl }), false)
  process.stdout.write('An unresponsive synchronous native manager probe closes and refuses availability.\n')
}
