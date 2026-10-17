import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../memory.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const hasKey = Boolean(process.env.DEEPSEEK_API_KEY)

describe.skipIf(!hasKey)('headless-agent memory tools with real model', () => {
  it('saves a durable memory record the test inspects outside the agent', async () => {
    let saved: string | undefined
    const { stdout } = await runLoaderSmoke({
      label: 'headless-agent memory save',
      tempDirPrefix: 'headless-agent-memory-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [
        configPath,
        'Use the memory_save tool to save a personal-scope memory with key "release-freeze", kind "background", a one-line summary, and content "No deploys on Friday." Then reply briefly.',
      ],
      tsconfigPath,
      processTimeoutMs: 120_000,
      inspect: async (cwd) => {
        const table = join(cwd, '.memory-store', 'memory', 'entries')
        const files = await readdir(table)
        const record = files.find(name => name.endsWith('_release-freeze.json'))
        if (record !== undefined) saved = await readFile(join(table, record), 'utf8')
      },
    })
    expect(saved).toBeDefined()
    expect(JSON.parse(saved!)).toMatchObject({ record: { key: 'release-freeze', scope: { kind: 'personal' }, kind: 'background' } })
    expect(stdout.trim().length).toBeGreaterThan(0)
  }, 135_000)
})
