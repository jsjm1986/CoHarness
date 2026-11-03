/** Keyless process ownership transcript through the actual Loader application. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleMode, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it.skipIf(process.platform === 'win32')('retains a real live descendant after an incomplete Linux process-table observation', async () => {
  const mode = resolveExampleMode()
  const driver = fileURLToPath(new URL('./fixtures/process-observation-driver.mjs', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'local subprocess incomplete process table', tempDirPrefix: 'subprocess-observation-loader-',
    binScript: driver, libBinScript: driver, sourceImport: 'tsx/esm',
    configPath: fileURLToPath(new URL('../../../../examples/headless-agent/tests/fixtures/subprocess/subprocess-local/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    env: { DSH_PROCESS_OBSERVATION_BOOT_ENTRY: new URL(`../../../boot/app-boot/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, import.meta.url).href },
  })
  expect(result.stderr).toBe('')
  await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/process-observation.jsonl', import.meta.url)))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
