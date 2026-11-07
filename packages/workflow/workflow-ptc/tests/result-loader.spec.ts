/** Workflow return serialization through the actual Loader and PTC child process. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('refuses lossy array returns through the Loader and PTC process', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib')
  const root = await mkdtemp(join(tmpdir(), 'workflow-result-loader-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/result-driver.mjs', import.meta.url)), mode,
    ], {
      cwd: root, timeout: 30_000, killSignal: 'SIGKILL',
      env: {
        ...process.env,
        HOME: root, USERPROFILE: root, DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'),
        NODE_OPTIONS: undefined, NODE_PATH: undefined,
        TSX_TSCONFIG_PATH: mode === 'src' ? fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)) : undefined,
        DSH_GATEWAY_CREDENTIAL_FD: undefined, DSH_GATEWAY_CREDENTIAL_FILE: undefined,
        DSH_MANAGED_DATA_MANIFEST: undefined,
      },
    })
    await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/lossless-result.jsonl', import.meta.url)))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 45_000)
