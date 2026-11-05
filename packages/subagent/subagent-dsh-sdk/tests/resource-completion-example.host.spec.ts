/** Public SDK backend cleanup through a native Loader parent and nested runtime. @module */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.each([
  ['resource-completion', 'recovers resource completion and upgrades uncertain native cleanup'],
  ['model-shutdown', 'joins a paused model consumer during SDK shutdown'],
  ['startup-owner', 'refuses stale SDK startup before real process creation'],
])('%s: %s through the managed SDK wire', async (fixture) => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('SDK resource example requires src or lib')
  const root = await mkdtemp(join(tmpdir(), 'sdk-resource-completion-example-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL(`./fixtures/${fixture}.mjs`, import.meta.url)), mode,
      ...(mode === 'lib' && process.env.DSH_SDK_ARTIFACT_ROOT !== undefined ? [process.env.DSH_SDK_ARTIFACT_ROOT] : []),
    ], { cwd: root, timeout: 90_000, killSignal: 'SIGKILL', env: { ...process.env,
      NODE_OPTIONS: undefined, NODE_PATH: undefined, DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), TMPDIR: root,
      DSH_TELEMETRY_DISABLED: '1', DSH_MANAGED_DATA_MANIFEST: undefined,
      TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../../../../tsconfig.json') : undefined,
    } }).catch((error: Error & { stdout?: string; stderr?: string }) => {
      error.message += `\nstdout:\n${error.stdout}\nstderr:\n${error.stderr}`
      throw error
    })
    await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, `expected/${fixture}.jsonl`))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 100_000)
