/** Loader-owned SSH helper cleanup retries use the native wire program and original process permit. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')('retains SSH helper cleanup ownership through temporary filesystem failures and actual native exit', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('SSH cleanup example requires src or lib')
  const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-cleanup-example-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('../../packages/ssh/ssh/tests/fixtures/cleanup-recovery.mjs', import.meta.url)), mode,
      ...(process.env.DSH_SSH_ARTIFACT_ROOT === undefined ? [] : [process.env.DSH_SSH_ARTIFACT_ROOT]),
    ], { cwd: root, timeout: 60_000, killSignal: 'SIGKILL', env: { ...process.env,
      NODE_OPTIONS: undefined, NODE_PATH: undefined, DSH_MANAGED_DATA_MANIFEST: undefined,
      DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), DSH_TELEMETRY_DISABLED: '1', TMPDIR: root,
      TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../../tsconfig.json') : undefined,
    } })
    await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./ssh-helper-cleanup-recovery/expected.jsonl', import.meta.url)))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 70_000)
