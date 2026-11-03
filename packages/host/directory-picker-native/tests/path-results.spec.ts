/** A Loader-mounted native chooser preserves real POSIX filenames through its process output. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

// Windows filenames cannot contain the CR/LF characters these POSIX results preserve.
it.skipIf(process.platform === 'win32')('returns the selected newline-bearing directory from a native Loader composition', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib.')
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-picker-paths-'))
  try {
    const result = await execute(process.execPath, [
      ...mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : [],
      fileURLToPath(new URL('./fixtures/path-results.mjs', import.meta.url)), mode, root,
    ], { timeout: 20_000, maxBuffer: 64 * 1024, env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root } })
    expect(result.stdout).toBe(await readFile(new URL('./expected/path-results.jsonl', import.meta.url), 'utf8'))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)
