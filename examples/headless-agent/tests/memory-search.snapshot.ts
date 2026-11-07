/** Unicode excerpts through the real Loader, memory tool, model requests, and JSON store. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

const driver = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const config = fileURLToPath(new URL('./fixtures/memory-cli.cordis.yml', import.meta.url))
const expected = new URL('./snapshots/memory-search/normalization.expected.jsonl', import.meta.url)

it('retains original matched content in normalized search excerpts delivered to the model', async () => {
  const result = await runLoaderSmoke({
    label: 'Unicode memory search snapshot', tempDirPrefix: 'headless-memory-search-',
    binScript: driver, libBinScript: driver, configPath: config,
    binArgs: [config, 'SEARCH_NORMALIZATION: Search for needle.'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm',
    prepare: async (cwd) => {
      const table = join(cwd, '.memory-store', 'memory', 'entries')
      await mkdir(table, { recursive: true })
      const prefixes = ['ﬃ'.repeat(100), '㎏'.repeat(100), 'A\u030A'.repeat(200), 'İ'.repeat(100),
        'ㄱㅏ'.repeat(120), '가'.repeat(120), '𐐀'.repeat(200)]
      for (const [index, prefix] of prefixes.entries()) {
        const key = `unicode-${String(index + 1).padStart(2, '0')}`
        const attribution = { source: 'member', at: '2026-10-01T00:00:00.000Z' }
        await writeFile(join(table, `personal_${key}.json`), JSON.stringify({ version: 1, record: {
          scope: { kind: 'personal' }, key, kind: 'background', summary: 'source excerpt',
          content: prefix + 'NEEDLE' + 'z'.repeat(300), revision: `seed-${key}`, created: attribution, updated: attribution,
        } }))
      }
    },
  })
  expect(result.stderr).toBe('')
  const rows = result.stdout.trimEnd().split('\n')
    .map(line => JSON.parse(line) as { event?: SessionEvent; output?: string })
  const calls = rows.flatMap(row => row.event?.type === 'tool/call' ? [row.event.data.name] : [])
  const results = rows.flatMap(row => row.event?.type === 'tool/result' ? [row.event.data.message] : [])
  expect(calls).toEqual(['memory_search'])
  expect(results).toHaveLength(1)
  expect(results[0]?.isError).not.toBe(true)
  const observed = { tool: calls[0], modelOutput: rows.at(-1)?.output }
  expect(JSON.stringify(observed) + '\n').toBe(await readFile(expected, 'utf8'))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
