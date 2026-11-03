/** Real Loader and AgentLoop plan reviews retain cancellation through a delayed external answer. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('applies a live plan review and rejects a late approval after cancellation', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib')
  const directory = await mkdtemp(join(tmpdir(), 'question-lifetime-loader-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/foreground-driver.mjs', import.meta.url)), mode,
    ], { cwd: directory, timeout: 30_000, killSignal: 'SIGKILL', env: {
      ...process.env, DSH_HOME: join(directory, '.dsh'), DSH_AGENTS_HOME: join(directory, '.agents'),
      NODE_OPTIONS: undefined, NODE_PATH: undefined, DSH_GATEWAY_CREDENTIAL_FD: undefined,
      DSH_GATEWAY_CREDENTIAL_FILE: undefined, DSH_MANAGED_DATA_MANIFEST: undefined,
      TSX_TSCONFIG_PATH: mode === 'src' ? fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)) : undefined,
    } })
    expect(result.stdout).toBe(await readFile(new URL('./expected/foreground.jsonl', import.meta.url), 'utf8'))
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 45_000)
