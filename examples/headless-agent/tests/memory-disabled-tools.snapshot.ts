/** Model tool scopes follow live file settings while owner data remains readable. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it.each(['personal', 'project'])('withdraws model memory tools and restores them in %s space', async (space) => {
  const driver = fileURLToPath(new URL('./fixtures/memory-disabled-tools-driver.ts', import.meta.url))
  const config = fileURLToPath(new URL('../memory-disabled-tools.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'memory tool scope withdrawal', tempDirPrefix: 'memory-disabled-tools-',
    binScript: driver, libBinScript: driver, configPath: config, binArgs: [config, space],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm',
    env: { DSH_MEMORY_FIXTURE_SPACE: space },
  })
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe(await readFile(new URL(`./snapshots/memory-disabled-tools/${space}.expected.jsonl`, import.meta.url), 'utf8'))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
