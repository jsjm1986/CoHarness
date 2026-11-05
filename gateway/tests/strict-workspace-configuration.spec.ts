/** Invalid normalized roots fail through the real Gateway source or compiled entry. */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('refuses equal managed parents before database or Runtime startup', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./fixtures/strict-workspace-configuration.mjs', import.meta.url)), mode,
    process.env.HGW_TEST_GATEWAY_ARTIFACT ?? '',
  ], { timeout: 60000, maxBuffer: 128 * 1024 })
  expect(result.stdout).toBe(await readFile(new URL('./expected/strict-workspace-configuration.jsonl', import.meta.url), 'utf8'))
})
