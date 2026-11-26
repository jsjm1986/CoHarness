/** Public SDK backend cleanup through a native Loader parent and nested runtime. @module */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const LANE_TEST_TIMEOUT_MS = Number(process.env.DSH_COVERAGE_TEST_TIMEOUT_MS ?? 0)
const CASE_TIMEOUT_MS = Math.max(100_000, LANE_TEST_TIMEOUT_MS)
const CHILD_TIMEOUT_MS = Math.max(90_000, LANE_TEST_TIMEOUT_MS - 10_000)

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
    ], { cwd: root, timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL', env: { ...process.env,
      NODE_OPTIONS: undefined, NODE_PATH: undefined, DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), TMPDIR: root,
      DSH_TELEMETRY_DISABLED: '1', DSH_MANAGED_DATA_MANIFEST: undefined,
      TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../../../../tsconfig.json') : undefined,
    } }).catch((error: unknown) => {
      const detail = error as { stdout?: string; stderr?: string; message: string }
      detail.message += `\nstdout:\n${detail.stdout}\nstderr:\n${detail.stderr}`
      throw detail
    })
    await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, `expected/${fixture}.jsonl`))
  } finally { await rm(root, { recursive: true, force: true }) }
}, CASE_TIMEOUT_MS)
