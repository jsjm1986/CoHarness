/** A project scope admits one real auxiliary review across overlapping Agent Sessions. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it('coalesces two real Session triggers into one admitted project consolidation', async () => {
  const driver = fileURLToPath(new URL('./fixtures/memory-consolidation-sessions-driver.ts', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'shared project memory consolidation', tempDirPrefix: 'memory-consolidation-sessions-',
    binScript: driver, libBinScript: driver,
    configPath: fileURLToPath(new URL('../memory-consolidation-sessions.cordis.snapshot.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm',
    prepare: async (cwd) => {
      const root = join(cwd, '.memory-store', 'memory')
      await mkdir(join(root, 'entries'), { recursive: true })
      await mkdir(join(root, 'cursors'))
      const attribution = { source: 'member', at: '2026-10-01T00:00:00.000Z' }
      await writeFile(join(root, 'entries', 'project_original.json'), JSON.stringify({ version: 1, record: {
        scope: { kind: 'project' }, key: 'original', kind: 'background', summary: 'Project fact', content: 'Shared project fact',
        revision: 'seed-original', created: attribution, updated: attribution,
      } }))
      await writeFile(join(root, 'cursors', 'consolidation-project.json'), JSON.stringify({ version: 1, record: { changedSince: 1 } }))
    },
  })
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe(await readFile(new URL('./snapshots/memory-curation-race/concurrent-sessions.expected.jsonl', import.meta.url), 'utf8'))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
