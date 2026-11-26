/** Real Web and Inspector startup retain resource ownership through queued admission. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const LANE_TEST_TIMEOUT_MS = Number(process.env.DSH_COVERAGE_TEST_TIMEOUT_MS ?? 0)
const CASE_TIMEOUT_MS = Math.max(150_000, LANE_TEST_TIMEOUT_MS)
const CHILD_TIMEOUT_MS = Math.max(120_000, LANE_TEST_TIMEOUT_MS - 10_000)

it('refuses stale Inspector startup and recovers through the real Web composition', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('Inspector startup example requires src or lib')
  const root = await mkdtemp(join(tmpdir(), 'dsh-inspector-owner-example-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/startup-owner.mjs', import.meta.url)), mode,
      ...(process.env.DSH_INSPECTOR_ARTIFACT_ROOT === undefined ? [] : [process.env.DSH_INSPECTOR_ARTIFACT_ROOT]),
    ], { cwd: root, timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL', env: { ...process.env,
      NODE_OPTIONS: undefined, NODE_PATH: undefined, DSH_MANAGED_DATA_MANIFEST: undefined,
      DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), DSH_TELEMETRY_DISABLED: '1', TMPDIR: root,
      TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../../../../tsconfig.json') : undefined,
    } }).catch((error: unknown) => {
      const detail = error as { stdout?: string; stderr?: string; message: string }
      detail.message += `\nstdout:\n${detail.stdout}\nstderr:\n${detail.stderr}`
      throw detail
    })
    await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./startup-owner/expected.jsonl', import.meta.url)))
  } finally { await rm(root, { recursive: true, force: true }) }
}, CASE_TIMEOUT_MS)
