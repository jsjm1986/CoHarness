/** Application replay of remote allocation ownership with a real helper and local carrier. @module */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('refuses stale admission before real helper process and terminal starts through a Loader application', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('SSH admission replay requires src or lib.')
  const directory = await mkdtemp('/tmp/ssh-admission-owner-')
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/admission-owner.mjs', import.meta.url)), mode,
      ...(process.env.DSH_SSH_PROVIDER_ARTIFACT_ROOT === undefined ? [] : [process.env.DSH_SSH_PROVIDER_ARTIFACT_ROOT]),
    ], { cwd: directory, timeout: 90_000, killSignal: 'SIGKILL', env: { ...process.env,
      NODE_OPTIONS: undefined, NODE_PATH: undefined, DSH_TELEMETRY_DISABLED: '1',
      DSH_HOME: join(directory, '.dsh'), DSH_AGENTS_HOME: join(directory, '.agents'), TMPDIR: directory,
      DSH_MANAGED_DATA_MANIFEST: undefined,
      TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../../../../tsconfig.json') : undefined,
    } })
    await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, 'expected/admission-owner.jsonl'))
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 100_000)
