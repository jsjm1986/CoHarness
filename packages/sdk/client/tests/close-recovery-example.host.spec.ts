/** Native SDK runtime and plugin teardown under a refused process-control operation. @module */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('retries cleanup of the original complete SDK runtime while keeping new requests closed', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('SDK close example requires src or lib')
  const root = await mkdtemp(join(tmpdir(), 'sdk-close-recovery-example-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/close-recovery.mjs', import.meta.url)), mode,
      ...(mode === 'lib' && process.env.DSH_SDK_CLIENT_ARTIFACT_ROOT !== undefined ? [process.env.DSH_SDK_CLIENT_ARTIFACT_ROOT] : []),
    ], { cwd: root, timeout: 90_000, killSignal: 'SIGKILL', env: { ...process.env,
      NODE_OPTIONS: undefined, NODE_PATH: undefined, DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), TMPDIR: root,
      DSH_TELEMETRY_DISABLED: '1', DSH_MANAGED_DATA_MANIFEST: undefined,
      TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../../../../tsconfig.json') : undefined,
    } })
    await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, 'expected/close-recovery.jsonl'))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 100_000)
