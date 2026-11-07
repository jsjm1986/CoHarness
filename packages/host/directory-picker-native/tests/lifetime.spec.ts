/** Real Loader withdrawal must retire accepted native chooser processes. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

// These fixtures replace POSIX chooser executables; Windows COM has separate driver coverage.
it.skipIf(process.platform === 'win32').each(['provider', 'root', 'caller'])(
  'owns native chooser lifetime through %s disposal', async (scenario) => {
    const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
    if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib.')
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-picker-life-'))
    try {
      const result = await execute(process.execPath, [
        ...mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : [],
        fileURLToPath(new URL('./fixtures/lifetime.mjs', import.meta.url)), mode, root, scenario,
      ], { timeout: 20_000, maxBuffer: 64 * 1024, env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root } })
      expect(result.stdout).toBe(await readFile(new URL(`./expected/lifetime-${scenario}.jsonl`, import.meta.url), 'utf8'))
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 30_000,
)
