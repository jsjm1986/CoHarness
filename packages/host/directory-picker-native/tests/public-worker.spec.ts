/** The public native picker retains its actual failing COM worker through closure. */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

// A Windows host would open a physical dialog; its explicit native smoke owns that case.
it.skipIf(process.platform === 'win32')('closes the real native-surface failure before the public picker rejects', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib.')
  const result = await execute(process.execPath, [
    ...mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : [],
    fileURLToPath(new URL('./fixtures/public-worker.mjs', import.meta.url)), mode,
  ], { timeout: 20_000, maxBuffer: 64 * 1024, env: { PATH: process.env.PATH } })
  expect(result.stdout).toBe(await readFile(new URL('./expected/public-worker.jsonl', import.meta.url), 'utf8'))
}, 30_000)
