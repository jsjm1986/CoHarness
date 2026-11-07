/** Real Loader replacement across an unfinished JSON memory-domain acquisition. */
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

const config = fileURLToPath(new URL('./fixtures/memory-cli.cordis.yml', import.meta.url))
const driver = fileURLToPath(new URL('./fixtures/memory-lifecycle-driver.ts', import.meta.url))
const expected = fileURLToPath(new URL('./expected/memory-lifecycle/open-close.expected.jsonl', import.meta.url))
const baseConfig = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const modelUrl = new URL('./fixtures/memory-mock-llm.ts', import.meta.url).href
const modules = fileURLToPath(new URL('../../node_modules', import.meta.url))

it('replaces memory during JSON opening and completes a real model memory-save turn', async () => {
  const [base, scenario] = await Promise.all([readFile(baseConfig, 'utf8'), readFile(config, 'utf8')])
  const result = await runLoaderSmoke({
    label: 'memory lifecycle snapshot', tempDirPrefix: 'headless-memory-lifecycle-',
    binScript: driver, libBinScript: driver, configPath: config, binArgs: ['./memory-lifecycle.cordis.yml'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm',
    prepare: async (cwd) => {
      await writeFile(join(cwd, 'cordis.yml'), base)
      await writeFile(join(cwd, 'memory-lifecycle.cordis.yml'), scenario.replace('../../cordis.yml', './cordis.yml').replace('./memory-mock-llm.ts', modelUrl))
      await symlink(modules, join(cwd, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    },
  })
  expect(await readFile(baseConfig, 'utf8')).toBe(base)
  expect(await readFile(config, 'utf8')).toBe(scenario)
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe(await readFile(expected, 'utf8'))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
