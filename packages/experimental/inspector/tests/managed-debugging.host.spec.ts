/** Real Web and Inspector refuse unrestricted debugging in managed runtimes. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('refuses managed Inspector startup and closes live debugging through the real Web composition', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('Inspector startup example requires src or lib')
  const root = await mkdtemp(join(tmpdir(), 'dsh-inspector-debugging-example-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/managed-debugging.mjs', import.meta.url)), mode,
      ...(process.env.DSH_INSPECTOR_ARTIFACT_ROOT === undefined ? [] : [process.env.DSH_INSPECTOR_ARTIFACT_ROOT]),
    ], { cwd: root, timeout: 60_000, killSignal: 'SIGKILL', env: { ...process.env,
      NODE_OPTIONS: undefined, NODE_PATH: undefined, DSH_MANAGED_DATA_MANIFEST: undefined,
      DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), DSH_TELEMETRY_DISABLED: '1', TMPDIR: root,
      TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../../../../tsconfig.json') : undefined,
    } }).catch((error: unknown) => {
      const detail = error as { stdout?: string; stderr?: string; message: string }
      detail.message += `\nstdout:\n${detail.stdout}\nstderr:\n${detail.stderr}`
      throw detail
    })
    await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./managed-debugging/expected.jsonl', import.meta.url)))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 70_000)
