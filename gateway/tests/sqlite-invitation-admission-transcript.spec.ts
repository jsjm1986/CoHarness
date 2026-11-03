/** SQLite write ownership and subsequent account revocation through runnable source/emitted services. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('retains SQLite recipient eligibility through invitation publication and refuses consumption after revocation', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib.')
  const root = await mkdtemp(join(tmpdir(), 'sqlite-invitation-assembly-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/sqlite-invitation-admission.mjs', import.meta.url)), mode,
    ], { cwd: root, timeout: 60_000, killSignal: 'SIGKILL', env: {
      ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined,
      DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), DSH_MANAGED_DATA_MANIFEST: undefined,
      TSX_TSCONFIG_PATH: mode === 'src' ? fileURLToPath(new URL('../../tsconfig.json', import.meta.url)) : undefined,
    } })
    await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/projects/sqlite-invitation-admission.jsonl', import.meta.url)))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 70_000)
