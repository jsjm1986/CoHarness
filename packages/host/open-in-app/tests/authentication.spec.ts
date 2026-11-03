/** Optional desktop routes retain browser authentication throughout provider replacement. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it('withdraws unauthenticated desktop routes while Connection is unavailable', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib.')
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-auth-'))
  try {
    const result = await execute(process.execPath, [
      ...mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : [],
      fileURLToPath(new URL('./fixtures/authentication.mjs', import.meta.url)), mode, root,
    ], { timeout: 20_000, maxBuffer: 256 * 1024, env: {
      PATH: process.env.PATH, HOME: root, USERPROFILE: root,
      TSX_TSCONFIG_PATH: mode === 'src' ? fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)) : undefined,
    } })
    expect(result.stdout).toBe(await readFile(new URL('./expected/authentication.jsonl', import.meta.url), 'utf8'))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)
