/** A real Loader transcript covers Unicode limits, scope order and recall addresses. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it('recalls omitted content later and records only the admitted unique entries', async () => {
  const driver = fileURLToPath(new URL('./fixtures/memory-recall-integrity-driver.ts', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'bounded memory recall', tempDirPrefix: 'memory-recall-integrity-',
    binScript: driver, libBinScript: driver,
    configPath: fileURLToPath(new URL('../memory-recall-integrity.cordis.snapshot.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm',
  })
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe(await readFile(new URL('./snapshots/memory-recall-integrity/recalls.expected.jsonl', import.meta.url), 'utf8'))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
