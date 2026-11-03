/** A real Loader application must preserve actors, file bytes and awaited HTTP consumer disposal. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

async function run(wrongPriority = false) {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib')
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-document-'))
  try {
    return await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/managed-store.mjs', import.meta.url)), mode,
      ...(wrongPriority ? ['borrow-viewer'] : []),
    ], { cwd: root, timeout: 40_000, killSignal: 'SIGKILL', env: {
      ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
      DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'),
      NODE_OPTIONS: undefined, NODE_PATH: undefined,
      TSX_TSCONFIG_PATH: mode === 'src' ? fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)) : undefined,
      DSH_GATEWAY_CREDENTIAL_FD: undefined, DSH_GATEWAY_CREDENTIAL_FILE: undefined, DSH_MANAGED_DATA_MANIFEST: undefined,
    } })
  } catch (error) {
    if (error instanceof Error) {
      const output = error as Error & { stdout?: string; stderr?: string }
      error.message += `\nFixture stdout:\n${output.stdout?.slice(-12_000) ?? ''}\nFixture stderr:\n${output.stderr?.slice(-6_000) ?? ''}`
    }
    throw error
  } finally { await rm(root, { recursive: true, force: true }) }
}

it('preserves the captured actor and full real-file operations across managed provider HTTP and unload', async () => {
  const result = await run()
  await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/managed-store.jsonl', import.meta.url)))
}, 60_000)

it('rejects a transport that borrows the later interactive viewer instead of captured execution', async () => {
  const failure = await run(true).then(
    () => { throw new Error('The wrong authority priority must fail the fixture.') }, (error: unknown) => error,
  )
  if (!(failure instanceof Error) || !('stdout' in failure) || !('stderr' in failure)) {
    throw new Error('Missing child process failure details.')
  }
  expect('signal' in failure ? failure.signal : undefined).toBeNull()
  expect(failure).toMatchObject({ code: 1 })
  expect(failure.stdout).toContain('"operation":"managed-document-bootstrap"')
  expect(failure.stderr).toContain('captured execution must remain the upload owner')
}, 60_000)
