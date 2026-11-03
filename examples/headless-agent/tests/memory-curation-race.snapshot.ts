import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { memoryConsolidationCursorKey, memoryRecordKey } from '@deepseek-ai/dsh-memory'
import { expect, it } from 'vitest'

const driver = fileURLToPath(new URL('./fixtures/memory-curation-race-driver.ts', import.meta.url))

it.each([
  ['memory-curation-race.cordis.snapshot.yml', 'concurrent-member.expected.jsonl', false],
  ['memory-curation-scope.cordis.snapshot.yml', 'scope-isolation.expected.jsonl', true],
] as const)('preserves selected scope and concurrent edits through %s', async (configName, expectedName, includeWorkspace) => {
  const config = fileURLToPath(new URL(`../${configName}`, import.meta.url))
  const result = await runLoaderSmoke({
    label: 'concurrent memory curation snapshot', tempDirPrefix: 'headless-memory-curation-',
    binScript: driver, libBinScript: driver, configPath: config,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm',
    prepare: async (cwd) => {
      const entries = join(cwd, '.memory-store', 'memory', 'entries')
      const cursors = join(cwd, '.memory-store', 'memory', 'cursors')
      await mkdir(entries, { recursive: true })
      await mkdir(cursors)
      for (const key of ['obsolete', 'original']) {
        const attribution = { source: 'member', at: '2026-10-01T00:00:00.000Z' }
        await writeFile(join(entries, `personal_${key}.json`), JSON.stringify({ version: 1, record: {
          scope: { kind: 'personal' }, key, kind: 'background', summary: `${key} fact`, content: `${key} body`,
          revision: `seed-${key}`, created: attribution, updated: attribution,
        } }))
      }
      await writeFile(join(cursors, 'consolidation-personal.json'), JSON.stringify({ version: 1, record: { changedSince: 2 } }))
      if (includeWorkspace) {
        const scope = { kind: 'workspace' as const, directory: cwd }
        const attribution = { source: 'member', at: '2026-10-01T00:00:00.000Z' }
        await writeFile(join(entries, `${memoryRecordKey(scope, 'workspace-only')}.json`), JSON.stringify({ version: 1, record: {
          scope, key: 'workspace-only', kind: 'guidance', summary: 'workspace-only fact', content: 'workspace-only body',
          revision: 'seed-workspace', created: attribution, updated: attribution,
        } }))
        await writeFile(join(cursors, `${memoryConsolidationCursorKey(scope)}.json`), JSON.stringify({ version: 1, record: { changedSince: 1 } }))
      }
    },
  })
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe(await readFile(new URL(`./snapshots/memory-curation-race/${expectedName}`, import.meta.url), 'utf8'))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
