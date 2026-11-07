/** Public Inspector and HTTP resource acknowledgement through a standalone native process. @module */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('retains stopped Worker accounting until cleanup is acknowledged and preserves successful completion', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('Inspector resource example requires src or lib')
  const root = await mkdtemp(join(tmpdir(), 'inspector-resource-example-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/resource-cleanup.mjs', import.meta.url)), mode,
      ...(mode === 'lib' && process.env.DSH_INSPECTOR_ARTIFACT_ROOT !== undefined ? [process.env.DSH_INSPECTOR_ARTIFACT_ROOT] : []),
    ], { cwd: root, timeout: 60_000, killSignal: 'SIGKILL', env: { ...process.env,
      NODE_OPTIONS: undefined, NODE_PATH: undefined, DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), TMPDIR: root,
      TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../../../../tsconfig.json') : undefined,
    } })
    await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, 'expected/resource-cleanup.jsonl'))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 70_000)
