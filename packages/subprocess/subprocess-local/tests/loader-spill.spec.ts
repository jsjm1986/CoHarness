/** Keyless local-process recovery transcript through the real Loader application. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleMode, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it('retains complete output when the real local provider receives partial filesystem writes', async () => {
  const mode = resolveExampleMode()
  const driver = fileURLToPath(new URL('./fixtures/spill-write-driver.mjs', import.meta.url))
  const configPath = fileURLToPath(new URL(
    '../../../../examples/headless-agent/tests/fixtures/subprocess/subprocess-local/cordis.yml', import.meta.url,
  ))
  const result = await runLoaderSmoke({
    label: 'local subprocess partial spill writes', tempDirPrefix: 'subprocess-spill-loader-',
    binScript: driver, libBinScript: driver, sourceImport: 'tsx/esm', configPath,
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    env: { DSH_SPILL_BOOT_ENTRY: new URL(
      `../../../boot/app-boot/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, import.meta.url,
    ).href },
  })
  expect(result.stderr).toBe('')
  await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/spill-short-write.jsonl', import.meta.url)))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
