import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

const config = fileURLToPath(new URL('../memory-cancellation.cordis.snapshot.yml', import.meta.url))
const driver = fileURLToPath(new URL('./fixtures/memory-cancellation-driver.ts', import.meta.url))
const baseConfig = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const fixtureUrl = new URL('./fixtures/memory-cancellation-model.ts', import.meta.url).href
const modules = fileURLToPath(new URL('../../node_modules', import.meta.url))

it.each([
  ['after-entry', 'stop-between-writes.expected.jsonl'],
  ['before-entry', 'stop-before-entry.expected.jsonl'],
] as const)('retains only committed entries when Loader stops curation %s', async (trigger, expectedName) => {
  const [base, scenario] = await Promise.all([readFile(baseConfig, 'utf8'), readFile(config, 'utf8')])
  const result = await runLoaderSmoke({
    label: 'memory cancellation snapshot', tempDirPrefix: 'headless-memory-cancellation-',
    binScript: driver, libBinScript: driver, configPath: config,
    binArgs: ['./memory-cancellation.cordis.yml'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm',
    prepare: async (cwd) => {
      // Loader disposal persists entry changes into the owning Include file.
      await writeFile(join(cwd, 'cordis.yml'), base)
      await writeFile(join(cwd, 'memory-cancellation.cordis.yml'), scenario.replace(
        "name: './tests/fixtures/memory-cancellation-model.ts'",
        `name: '${fixtureUrl}'\n  config:\n    trigger: ${trigger}`,
      ))
      await symlink(modules, join(cwd, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    },
  })
  expect(await readFile(baseConfig, 'utf8')).toBe(base)
  expect(await readFile(config, 'utf8')).toBe(scenario)
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe(await readFile(new URL(`./snapshots/memory-cancellation/${expectedName}`, import.meta.url), 'utf8'))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
