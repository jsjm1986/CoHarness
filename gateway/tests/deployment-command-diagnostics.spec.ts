/** Command errors retain a complete UTF-8 prefix within the diagnostic byte ceiling. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it('bounds ASCII and multibyte diagnostics without changing an exact-limit message', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib.')
  const root = await mkdtemp(join(tmpdir(), 'hgw-command-diagnostics-'))
  try {
    const result = await execute(process.execPath, [
      ...mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : [],
      fileURLToPath(new URL('./fixtures/deployment-command-diagnostics.mjs', import.meta.url)), mode, root,
      process.env.HGW_TEST_GATEWAY_ARTIFACT ?? '',
    ], { timeout: 20_000, maxBuffer: 64 * 1024, env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root } })
    expect(result.stdout).toBe(await readFile(new URL('./expected/deployment-command-diagnostics.jsonl', import.meta.url), 'utf8'))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)
