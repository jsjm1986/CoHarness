/** Manual command attribution through a runnable Loader and real compaction backend. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('attributes the assembled summary request and refuses a revoked initiator', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib')
  const directory = await mkdtemp(join(tmpdir(), 'compact-authority-loader-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/authority-driver.mjs', import.meta.url)), mode,
    ], {
      cwd: directory, timeout: 30_000, killSignal: 'SIGKILL',
      env: {
        ...process.env, DSH_HOME: join(directory, '.dsh'), DSH_AGENTS_HOME: join(directory, '.agents'),
        NODE_OPTIONS: undefined, NODE_PATH: undefined,
        TSX_TSCONFIG_PATH: mode === 'src' ? fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)) : undefined,
        DSH_GATEWAY_CREDENTIAL_FD: undefined, DSH_GATEWAY_CREDENTIAL_FILE: undefined,
        DSH_MANAGED_DATA_MANIFEST: undefined,
      },
    })
    await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/authority.jsonl', import.meta.url)))
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 45_000)
