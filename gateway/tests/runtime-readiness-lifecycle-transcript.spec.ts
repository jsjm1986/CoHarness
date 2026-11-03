/** Actual managed Runtime readiness, resource ownership and public start/stop completion. */
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')('bounds authenticated readiness and preserves cancellation, backend errors and physical ownership', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib')
  const result = await promisify(execFile)(process.execPath, [
    ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
    fileURLToPath(new URL('./fixtures/runtime-readiness-lifecycle.mjs', import.meta.url)), mode,
    process.env.DSH_GATEWAY_ARTIFACT_ROOT ?? '-',
  ], { timeout: 150_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined,
    TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../tsconfig.run.json') : undefined } })
  await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, 'expected/runtime-readiness-lifecycle.expected.md'))
}, 155_000)
