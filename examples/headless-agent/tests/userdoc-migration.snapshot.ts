import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

const configPath = fileURLToPath(new URL('./fixtures/userdoc-migration.cordis.yml', import.meta.url))
const driver = fileURLToPath(new URL('./fixtures/userdoc-migration-driver.ts', import.meta.url))
const expected = fileURLToPath(new URL('./snapshots/userdoc-migration/lock-retry.expected.jsonl', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

it('preserves document and partial-upload bytes through refused migration and metadata recovery', async () => {
  const result = await runLoaderSmoke({
    label: 'document migration lock snapshot',
    tempDirPrefix: 'userdoc-migration-snapshot-',
    binScript: driver,
    libBinScript: driver,
    sourceImport: 'tsx/esm',
    configPath,
    tsconfigPath,
    prepare: async (cwd) => {
      await mkdir(join(cwd, 'uploads'))
      await writeFile(join(cwd, 'uploads', 'brief.txt'), 'retained legacy document')
      await writeFile(join(cwd, '.documents-migration.lock'), '')
    },
  })
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe(await readFile(expected, 'utf8'))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
