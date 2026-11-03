/** Native capability probes close real uncooperative clients before fail-closed provider settlement. */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')('bounds every native functional probe and retains the unavailable verdict', async () => {
  const result = await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx/esm'),
    fileURLToPath(new URL('./run-native-probe-timeout.mjs', import.meta.url)), 'src'],
  { timeout: 100_000, killSignal: 'SIGKILL', env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined } })
  expect(result.stdout.trim().split('\n')).toHaveLength(4)
}, 105_000)
