/** Real Loader Inspector capture and native HTTP across independent plugin retirements. @module */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('restores native fetch after independent Loader Inspector owners stop in either order', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('Inspector fetch example requires src or lib')
  const root = await mkdtemp(join(tmpdir(), 'inspector-fetch-retirement-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/fetch-retirement.mjs', import.meta.url)), mode,
      ...(process.env.DSH_INSPECTOR_ARTIFACT_ROOT === undefined ? [] : [process.env.DSH_INSPECTOR_ARTIFACT_ROOT]),
    ], { cwd: root, timeout: 60_000, killSignal: 'SIGKILL', env: { ...process.env,
      NODE_OPTIONS: undefined, NODE_PATH: undefined, DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), TMPDIR: root,
      TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../../../../tsconfig.json') : undefined,
    } })
    await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, 'expected/fetch-retirement.jsonl'))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 70_000)
