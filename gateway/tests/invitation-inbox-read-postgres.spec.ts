/** Public Gateway invitation history and notification reads retain current browser authority. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const database = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
it.skipIf(database === undefined)('publishes only current invitation authority and preserves account participant history', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib.')
  const root = await mkdtemp(join(tmpdir(), 'invitation-inbox-replay-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/invitation-inbox-read.mjs', import.meta.url)), mode,
      ...(mode === 'lib' && process.env.DSH_GATEWAY_ARTIFACT_ROOT !== undefined ? [process.env.DSH_GATEWAY_ARTIFACT_ROOT] : []),
    ], { cwd: root, timeout: 90000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, env: {
      ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined, DEEPSEEK_API_KEY: undefined, OPENAI_API_KEY: undefined,
      DSH_INVITATION_INBOX_FIXTURE_ROOT: root,
      TSX_TSCONFIG_PATH: mode === 'src' ? fileURLToPath(new URL('../tsconfig.run.json', import.meta.url)) : undefined,
    } })
    await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/projects/invitation-inbox-read.jsonl', import.meta.url)))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 110000)
