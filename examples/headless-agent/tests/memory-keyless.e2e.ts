import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/memory-cli.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('headless-agent keyless memory smoke', () => {
  it('boots the memory stack through the real Loader, saves through the tool executor, and republishes the catalog', async () => {
    let saved: string | undefined
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'headless-agent memory keyless',
      tempDirPrefix: 'headless-agent-memory-keyless-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'remember the freeze'],
      tsconfigPath,
      inspect: async (cwd) => {
        const table = join(cwd, '.memory-store', 'memory', 'entries')
        const files = await readdir(table).catch(() => [] as string[])
        const record = files.find(name => name.endsWith('_release-freeze.json'))
        if (record !== undefined) saved = await readFile(join(table, record), 'utf8')
      },
    })
    expect(stderr).toBe('')
    const lines = stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const events = lines.slice(0, -1).map(line => line['event'] as SessionEvent)
    expect(events.some(event => event.type === 'tool/call' && event.data.name === 'memory_save')).toBe(true)
    const catalog = events.find(event => event.type === 'user/message'
      && (event.data.source as { kind?: string } | undefined)?.kind === 'memory-catalog')
    expect(catalog).toBeDefined()
    expect(saved).toBeDefined()
    expect(JSON.parse(saved!)).toMatchObject({ record: { key: 'release-freeze', scope: { kind: 'personal' }, kind: 'background' } })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
