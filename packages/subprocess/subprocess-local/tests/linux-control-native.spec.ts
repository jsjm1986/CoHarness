/** Real native-query closure for the Linux owner, using an inert private systemctl substitute. */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')('closes stalled asynchronous and synchronous native control clients at their deadlines', async () => {
  const result = await promisify(execFile)(process.execPath, [
    '--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./run-linux-control-timeout.mjs', import.meta.url)), 'src',
  ], { timeout: 65_000, killSignal: 'SIGKILL', env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined } })
  expect(result.stdout).toContain('retains unknown managed ownership')
  expect(result.stdout).toContain('refuses availability')
}, 70_000)
