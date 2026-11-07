/** Actual owned processes stay live while their external identity observation is unavailable. */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

// Win32 uses its handle inspector; this fixture exercises the POSIX observers.
it.skipIf(process.platform === 'win32')('refuses unknown identity observations before signalling an owned process', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib.')
  const result = await execute(process.execPath, [
    ...mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : [],
    fileURLToPath(new URL('./fixtures/identity-observation.mjs', import.meta.url)), mode,
  ], { timeout: 20_000, maxBuffer: 64 * 1024, env: { PATH: process.env.PATH } })
  expect(result.stdout).toBe(await readFile(new URL('./expected/identity-observation.jsonl', import.meta.url), 'utf8'))
}, 30_000)
