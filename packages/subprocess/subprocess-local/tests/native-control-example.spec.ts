/** Native helper failure leaves the original real workload owned until verified exit. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleMode, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it.skipIf(process.platform === 'win32')('bounds native helper processes without reporting workload quiescence', async () => {
  const mode = resolveExampleMode()
  const driver = fileURLToPath(new URL('./fixtures/native-control-deadlines.mjs', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'native process control deadlines', tempDirPrefix: 'native-control-deadlines-loader-',
    binScript: driver, libBinScript: driver, sourceImport: 'tsx/esm',
    configPath: fileURLToPath(new URL('../../../../examples/headless-agent/tests/fixtures/subprocess/subprocess-local/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    env: { DSH_EXAMPLE_MODE: mode,
      DSH_CONTROL_BOOT_ENTRY: new URL(`../../../boot/app-boot/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, import.meta.url).href },
  })
  expect(result.stderr).toBe('')
  await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/native-control-deadlines.jsonl', import.meta.url)))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
