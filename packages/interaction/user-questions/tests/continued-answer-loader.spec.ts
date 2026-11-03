/** Timed question continuation through a runnable Loader application. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.each(['independent', 'project'] as const)('attests a continued reply, refuses cancelled delivery and retains its real Agent: %s', async (scenario) => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib')
  const directory = await mkdtemp(join(tmpdir(), 'question-answer-loader-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/continued-answer-driver.mjs', import.meta.url)), mode, scenario,
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
    const expected = scenario === 'project' ? 'continued-answer-project.jsonl' : 'continued-answer.jsonl'
    await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/' + expected, import.meta.url)))
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 45_000)
