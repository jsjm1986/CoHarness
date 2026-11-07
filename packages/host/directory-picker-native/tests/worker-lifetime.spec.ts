/** Worker IPC results and kill requests do not establish native process closure. */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it.each(['result', 'kill-refused', 'pending-close', 'late-showing'])(
  'retains the dialog worker through %s retirement', async (scenario) => {
    const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
    if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib.')
    const result = await execute(process.execPath, [
      ...mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : [],
      fileURLToPath(new URL('./fixtures/worker-lifetime.mjs', import.meta.url)), mode, scenario,
    ], { timeout: 20_000, maxBuffer: 64 * 1024, env: { PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      ...process.env.HGW_TEST_NATIVE_ARTIFACT ? { HGW_TEST_NATIVE_ARTIFACT: process.env.HGW_TEST_NATIVE_ARTIFACT } : {} } })
    expect(result.stdout).toBe(await readFile(new URL(`./expected/worker-lifetime-${scenario}.jsonl`, import.meta.url), 'utf8'))
  }, 30_000,
)
