/** Public Gateway health and native configuration-control replay without a model provider. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('binds configuration health to its computer and joins native restart clients', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib')
  const result = await promisify(execFile)(process.execPath, [
    ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
    fileURLToPath(new URL('./fixtures/node-configuration-health.mjs', import.meta.url)), mode,
    ...(mode === 'lib' && process.env.DSH_GATEWAY_ARTIFACT_ROOT !== undefined ? [process.env.DSH_GATEWAY_ARTIFACT_ROOT] : []),
  ], { timeout: 40_000, killSignal: 'SIGKILL', env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined,
    TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../tsconfig.run.json') : undefined } })
  await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, 'expected/node-configuration-health.expected.md'))
}, 45_000)
