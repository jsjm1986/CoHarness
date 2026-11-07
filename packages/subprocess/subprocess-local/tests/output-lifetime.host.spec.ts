/** Default spill registration and actual exit cleanup in isolated Node processes. @module */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.each([false, true])('registers spill cleanup on first default storage and preserves completed files=%s', async (keepFile) => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('Spill lifetime replay requires src or lib.')
  const directory = await mkdtemp(join(tmpdir(), 'spill-lifetime-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/output-lifetime.mjs', import.meta.url)),
      process.env.DSH_SPILL_OUTPUT_ENTRY ?? new URL(`../${mode}/output.${mode === 'src' ? 'ts' : 'js'}`, import.meta.url).href,
      keepFile ? 'yes' : 'no',
    ], { cwd: directory, timeout: 30_000, killSignal: 'SIGKILL', env: { ...process.env,
      NODE_OPTIONS: undefined, NODE_PATH: undefined, TMPDIR: directory,
    } })
    const { directory: spillDir, ...facts } = JSON.parse(result.stdout) as {
      directory: string
      importedHooks: number
      customHooks: number
      defaultHooks: number
      sameDirectory: boolean
    }
    expect(facts).toEqual({ importedHooks: 0, customHooks: 0, defaultHooks: 1, sameDirectory: true })
    expect(existsSync(spillDir)).toBe(keepFile)
    if (keepFile) expect(await readFile(join(spillDir, 'completed.txt'), 'utf8')).toBe('retained output')
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 40_000)
